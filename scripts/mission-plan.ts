#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readMission } from './lib/fs-utils.ts';
import { discoverAgents, matchAgentForTask } from './lib/mission-agent-discovery.ts';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { derivePhaseFromTask } from './lib/mission-helpers.ts';
import type { CompletionCriterion, Mission, Task, TaskType } from './lib/types.ts';

interface PlanArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  tasksFile: string | null;
  tasksJson: string | null;
  criteriaFile: string | null;
  criteriaJson: string | null;
  parallel: number | null;
  template: string | null;
}

interface PlannedOutput {
  completionCriteria: CompletionCriterion[];
  tasks: Task[];
  planMarkdown: string;
}

type TaskInput = Omit<Task, 'status'> & { status?: Task['status'] };

function parseArgs(argv: string[]): PlanArgs {
  const args: PlanArgs = {
    missionsDir: './missions',
    missionId: '',
    dryRun: false,
    tasksFile: null,
    tasksJson: null,
    criteriaFile: null,
    criteriaJson: null,
    parallel: null,
    template: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--missions-dir':
        if (next) {
          args.missionsDir = next;
          index += 1;
        }
        break;
      case '--mission-id':
        if (next) {
          args.missionId = next;
          index += 1;
        }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--tasks-file':
        if (next) {
          args.tasksFile = next;
          index += 1;
        }
        break;
      case '--tasks-json':
        if (next) {
          args.tasksJson = next;
          index += 1;
        }
        break;
      case '--criteria-file':
        if (next) {
          args.criteriaFile = next;
          index += 1;
        }
        break;
      case '--criteria-json':
        if (next) {
          args.criteriaJson = next;
          index += 1;
        }
        break;
      case '--parallel': {
        const value = Number(next);
        if (Number.isInteger(value) && value >= 1) {
          args.parallel = value;
          index += 1;
        }
        break;
      }
      case '--template':
        if (next) {
          args.template = next;
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return args;
}

function assertRequired(args: PlanArgs): void {
  if (!args.missionId.trim()) {
    throw new Error('Missing required --mission-id');
  }

  const customTaskSources = [args.tasksFile, args.tasksJson, args.parallel !== null ? 'parallel' : null, args.template].filter(Boolean).length;
  if (customTaskSources > 1) {
    throw new Error('Use only one of --tasks-file, --tasks-json, --parallel, or --template');
  }

  if (args.criteriaFile && args.criteriaJson) {
    throw new Error('Use either --criteria-file or --criteria-json, not both');
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
}

function createTask(taskId: string, title: string, type: TaskType, description: string, priority: number, dependsOn: string[] = []): Task {
  return {
    taskId,
    title,
    description,
    type,
    status: dependsOn.length > 0 ? 'PENDING' : 'READY',
    dependsOn,
    priority,
    retryCount: 0,
    maxRetries: 2,
    artifacts: [],
    resultSummary: null,
    lastError: null,
    backgroundProcessId: null,
    sessionKey: null,
    agent: null,
  };
}

function resolveTemplate(templateName: string): string {
  const templates: Record<string, string> = {
    'serial-3': JSON.stringify([
      { taskId: 'T1-context', title: '收集上下文与输入边界', type: 'analysis', dependsOn: [] },
      { taskId: 'T2-execute', title: '执行核心任务', type: 'code', dependsOn: ['T1-context'] },
      { taskId: 'T3-verify', title: '验证完成标准并形成结论', type: 'verification', dependsOn: ['T2-execute'] },
    ]),
    'parallel-research': JSON.stringify([
      { taskId: 'T1-researcher-1', title: '调研方向 1', type: 'research', dependsOn: [] },
      { taskId: 'T2-researcher-2', title: '调研方向 2', type: 'research', dependsOn: [] },
      { taskId: 'T3-researcher-3', title: '调研方向 3', type: 'research', dependsOn: [] },
      { taskId: 'T4-synthesis', title: '综合分析', type: 'analysis', dependsOn: ['T1-researcher-1', 'T2-researcher-2', 'T3-researcher-3'] },
      { taskId: 'T5-report', title: '输出报告', type: 'document', dependsOn: ['T4-synthesis'] },
    ]),
    'parallel-build': JSON.stringify([
      { taskId: 'T1-design', title: '设计', type: 'analysis', dependsOn: [] },
      { taskId: 'T2-frontend', title: '前端实现', type: 'code', dependsOn: ['T1-design'] },
      { taskId: 'T3-backend', title: '后端实现', type: 'code', dependsOn: ['T1-design'] },
      { taskId: 'T4-test', title: '集成测试', type: 'test', dependsOn: ['T2-frontend', 'T3-backend'] },
      { taskId: 'T5-review', title: '代码审查', type: 'review', dependsOn: ['T4-test'] },
    ]),
  };

  const json = templates[templateName];
  if (!json) {
    const available = Object.keys(templates).join(', ');
    throw new Error(`Unknown template: ${templateName}. Available templates: ${available}`);
  }
  return json;
}

function parseCustomTasks(args: PlanArgs): TaskInput[] | null {
  // Template resolution produces JSON, then falls through to normal parsing
  const raw = args.tasksJson
    ? args.tasksJson
    : args.tasksFile
      ? readFileSync(args.tasksFile, 'utf-8')
      : args.template
        ? resolveTemplate(args.template)
        : null;

  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse custom tasks JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Custom tasks must be a JSON array');
  }

  return parsed as TaskInput[];
}

function defaultCompletionCriteria(): CompletionCriterion[] {
  return [
    {
      id: 'criterion-plan-exists',
      description: 'mission 已生成 plan.md，包含任务拆解、完成标准和下一步。',
      required: true,
      verified: false,
    },
    {
      id: 'criterion-primary-output',
      description: '至少一个主任务产出与 mission 目标直接相关的交付物。',
      required: true,
      verified: false,
    },
    {
      id: 'criterion-verification-ready',
      description: '存在可执行的验证任务或验收标准，能阻止“伪完成”。',
      required: true,
      verified: false,
    },
  ];
}

function parseCustomCriteria(args: PlanArgs): CompletionCriterion[] | null {
  const raw = args.criteriaJson
    ? args.criteriaJson
    : args.criteriaFile
      ? readFileSync(args.criteriaFile, 'utf-8')
      : null;

  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse custom criteria JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Custom completion criteria must be a JSON array');
  }

  const ids = new Set<string>();
  return parsed.map((item, index): CompletionCriterion => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Custom completion criterion at index ${index} must be an object`);
    }

    const id = 'id' in item && typeof item.id === 'string' ? item.id.trim() : '';
    const description = 'description' in item && typeof item.description === 'string' ? item.description.trim() : '';

    if (!id) {
      throw new Error(`Custom completion criterion at index ${index} is missing id`);
    }

    if (!description) {
      throw new Error(`Custom completion criterion ${id} is missing description`);
    }

    if (ids.has(id)) {
      throw new Error(`Custom completion criteria contain duplicate id: ${id}`);
    }
    ids.add(id);

    return {
      ...(item as CompletionCriterion),
      id,
      description,
    };
  });
}

function assertAcyclicTaskGraph(tasks: Task[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));

  const visit = (taskId: string, path: string[]): void => {
    if (visited.has(taskId)) {
      return;
    }

    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStart), taskId].join(' -> ');
      throw new Error(`Custom tasks contain cyclic dependency: ${cyclePath}`);
    }

    visiting.add(taskId);
    const task = taskMap.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      visit(dependencyId, [...path, taskId]);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) {
    visit(task.taskId, []);
  }
}

function normalizeCustomTasks(tasks: TaskInput[]): Task[] {
  if (tasks.length === 0) {
    throw new Error('Custom tasks must contain at least one task');
  }

  const normalized = tasks.map((task, index): Task => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Custom task at index ${index} must be an object`);
    }
    if (!task.taskId?.trim()) {
      throw new Error(`Custom task at index ${index} is missing taskId`);
    }
    if (!task.title?.trim()) {
      throw new Error(`Custom task ${task.taskId} is missing title`);
    }
    if (!task.type) {
      throw new Error(`Custom task ${task.taskId} is missing type`);
    }

    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.map((dependencyId) => {
          if (typeof dependencyId !== 'string' || !dependencyId.trim()) {
            throw new Error(`Custom task ${task.taskId} has an invalid dependsOn entry`);
          }
          return dependencyId;
        })
      : [];

    return {
      ...task,
      taskId: task.taskId.trim(),
      title: task.title.trim(),
      description: task.description,
      dependsOn,
      status: dependsOn.length > 0 ? 'PENDING' : 'READY',
      priority: task.priority ?? Math.max(1, (tasks.length - index) * 10),
      retryCount: task.retryCount ?? 0,
      maxRetries: task.maxRetries ?? 2,
      artifacts: task.artifacts ?? [],
      resultSummary: task.resultSummary ?? null,
      lastError: task.lastError ?? null,
      backgroundProcessId: task.backgroundProcessId ?? null,
      sessionKey: task.sessionKey ?? null,
      agent: task.agent ?? null,
      ...(task.phase !== undefined ? { phase: task.phase } : {}),
    };
  });

  const taskIds = new Set<string>();
  for (const task of normalized) {
    if (taskIds.has(task.taskId)) {
      throw new Error(`Custom tasks contain duplicate taskId: ${task.taskId}`);
    }
    taskIds.add(task.taskId);
  }

  for (const task of normalized) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Custom task ${task.taskId} depends on missing taskId: ${dependencyId}`);
      }
      if (dependencyId === task.taskId) {
        throw new Error(`Custom task ${task.taskId} cannot depend on itself`);
      }
    }
  }

  assertAcyclicTaskGraph(normalized);

  return normalized;
}

function buildParallelTasks(count: number, mission: Mission): Task[] {
  const workstream = inferWorkstreamType(mission.goal);
  const taskPrefix = slugify(mission.title || mission.goal || mission.missionId);
  return Array.from({ length: count }, (_, index) => {
    const lane = index + 1;
    return createTask(
      `${taskPrefix}-lane-${lane}`,
      `${workstream.executionTitle} (Lane ${lane}/${count})`,
      workstream.primaryType,
      `${workstream.executionDescription} 并行分支 ${lane}，与其他分支独立执行。`,
      100 - index,
      [] // no dependsOn — all READY from the start
    );
  });
}

function inferWorkstreamType(goal: string): { primaryType: TaskType; executionTitle: string; executionDescription: string } {
  const normalized = goal.toLowerCase();

  if (/code|fix|bug|implement|script|cli|api|功能|实现|修复/.test(normalized)) {
    return {
      primaryType: 'code',
      executionTitle: '实现主交付内容',
      executionDescription: '在目标仓库或工作区内完成代码/脚本变更，并生成可验证产物。',
    };
  }

  if (/review|评审|audit|检查/.test(normalized)) {
    return {
      primaryType: 'review',
      executionTitle: '执行评审与结论归纳',
      executionDescription: '审阅目标内容并产出问题清单、结论和建议。',
    };
  }

  return {
    primaryType: 'research',
    executionTitle: '执行调研与信息归纳',
    executionDescription: '收集信息、整理发现，并形成可交付结论。',
  };
}

function buildPlannedOutput(
  mission: Mission,
  customTasks: Task[] | null = null,
  customCriteria: CompletionCriterion[] | null = null,
  parallelCount: number | null = null
): PlannedOutput {
  const workstream = inferWorkstreamType(mission.goal);
  const taskPrefix = slugify(mission.title || mission.goal || mission.missionId);
  const criteria = customCriteria ?? defaultCompletionCriteria();

  const tasks: Task[] = customTasks ?? (parallelCount !== null ? buildParallelTasks(parallelCount, mission).map((t) => ({ ...t, phase: 'build' })) : [
    {
      ...createTask(
        `${taskPrefix}-context`,
        '收集上下文与输入边界',
        'analysis',
        '读取 mission 目标、现有文档和相关工件，确认范围、约束和完成定义。',
        100
      ),
      phase: 'research',
    },
    {
      ...createTask(
        `${taskPrefix}-execute`,
        workstream.executionTitle,
        workstream.primaryType,
        workstream.executionDescription,
        80,
        [`${taskPrefix}-context`]
      ),
      phase: 'build',
    },
    {
      ...createTask(
        `${taskPrefix}-verify`,
        '验证完成标准并形成结论',
        'verification',
        '运行必要检查、对照 completion criteria 判断 PASS / GAP / ESCALATE。',
        60,
        [`${taskPrefix}-execute`]
      ),
      phase: 'verify',
    },
  ]);

  const planMarkdown = [
    `# Plan for ${mission.missionId}`,
    '',
    '## Mission',
    `- Title: ${mission.title}`,
    `- Goal: ${mission.goal}`,
    `- Current status: ${mission.status}`,
    '',
    '## Completion Criteria',
    ...criteria.map((item, index) => `${index + 1}. [ ] ${item.description}`),
    '',
    '## Task Breakdown',
    ...tasks.map((task, index) => {
      const dependsText = task.dependsOn && task.dependsOn.length > 0 ? ` | dependsOn=${task.dependsOn.join(',')}` : '';
      const phaseText = task.phase ? ` | phase=${task.phase}` : '';
      return `${index + 1}. ${task.taskId} | type=${task.type} | status=${task.status}${phaseText}${dependsText}\n   - ${task.description ?? task.title}`;
    }),
    '',
    '## Notes',
    '- 此 planner 为 MVP 规则型实现，用于优先跑通 create -> plan -> dispatch -> watchdog -> verify 主流程。',
    '- 后续可替换为基于模型的 planner，但保持 mission.json 与 plan.md 输出契约不变。',
    '',
  ].join('\n');

  return {
    completionCriteria: criteria,
    tasks,
    planMarkdown,
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    assertRequired(args);

    const mission = readMission(args.missionsDir, args.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${args.missionId}`);
    }

    const customTaskInput = parseCustomTasks(args);
    const customTasks = customTaskInput ? normalizeCustomTasks(customTaskInput) : null;
    const customCriteria = parseCustomCriteria(args);
    const output = buildPlannedOutput(mission, customTasks, customCriteria, args.parallel);

    // Agent 发现 + 分配
    const agents = discoverAgents({
      channel: mission.owner?.channel ?? '',
      chatId: mission.owner?.chatId ?? '',
    });
    for (const task of output.tasks) {
      // 自动推导并标注 phase
      task.phase = derivePhaseFromTask(task);
      const matched = matchAgentForTask(task, agents);
      if (matched) {
        task.agent = matched.agentId;
        task.config = { ...task.config, agentMentionTag: matched.mentionTag, agentName: matched.name };
      }
    }

    const nowIso = new Date().toISOString();
    const nextWakeAt = mission.nextWakeAt ?? nowIso;

    // 记录 orchestrator 信息到 metadata（当前 Agent 即是 orchestrator）
    const existingMetadata = mission.metadata ?? {};
    const updatedMission: Mission = {
      ...mission,
      status: 'PLANNED',
      updatedAt: nowIso,
      lastProgressAt: nowIso,
      nextWakeAt,
      completionCriteria: output.completionCriteria,
      tasks: output.tasks,
      artifacts: [
        ...(mission.artifacts ?? []).filter((artifact) => artifact.path !== 'plan.md'),
        {
          path: 'plan.md',
          type: 'document',
          description: 'Planner 生成的任务拆解与完成标准。',
          generatedAt: nowIso,
        },
      ],
      metadata: {
        ...existingMetadata,
        // 保留已有 orchestrator 信息（由 mission-create 写入）
      },
    };

    const missionDir = join(args.missionsDir, mission.missionId);
    const planPath = join(missionDir, 'plan.md');

    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: mission.missionId, output, updatedMission, planPath }, null, 2));
      return 0;
    }

    const commitOk = commitMissionUpdate({
      missionsDir: args.missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: args.dryRun,
      source: 'planned',
      eventExtras: {
        taskCount: output.tasks.length,
        completionCriteriaCount: output.completionCriteria.length,
        artifactPath: 'plan.md',
        agentsDiscovered: agents.length,
      },
      artifactWrites: [{ path: planPath, content: output.planMarkdown }],
    });

    if (!commitOk) {
      console.error(`[mission-plan] failed | missionId=${mission.missionId}`);
      return 1;
    }

    console.log(`[mission-plan] planned | missionId=${mission.missionId} | tasks=${output.tasks.length} | criteria=${output.completionCriteria.length}`);
    console.log(planPath);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-plan] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
