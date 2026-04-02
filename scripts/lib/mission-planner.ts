/**
 * mission-planner.ts — Plan generation logic
 *
 * Extracted from mission-plan.ts: template resolution, task normalization,
 * completion criteria, parallel task building, and plan output construction.
 */

import { readFileSync } from 'fs';
import type { CompletionCriterion, Mission, Task, TaskType } from './types.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskInput = Omit<Task, 'status'> & { status?: Task['status'] };

export interface PlannedOutput {
  completionCriteria: CompletionCriterion[];
  tasks: Task[];
  planMarkdown: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
}

export function createTask(taskId: string, title: string, type: TaskType, description: string, priority: number, dependsOn: string[] = []): Task {
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

// ── Template Resolution ────────────────────────────────────────────────────────

export function resolveTemplate(templateName: string): string {
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

// ── Custom Task Parsing ────────────────────────────────────────────────────────

export function parseCustomTasks(options: {
  tasksJson: string | null;
  tasksFile: string | null;
  template: string | null;
}): TaskInput[] | null {
  const raw = options.tasksJson
    ? options.tasksJson
    : options.tasksFile
      ? readFileSync(options.tasksFile, 'utf-8')
      : options.template
        ? resolveTemplate(options.template)
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

// ── Completion Criteria ────────────────────────────────────────────────────────

export function defaultCompletionCriteria(): CompletionCriterion[] {
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
      description: '存在可执行的验证任务或验收标准，能阻止"伪完成"。',
      required: true,
      verified: false,
    },
  ];
}

export function parseCustomCriteria(options: {
  criteriaJson: string | null;
  criteriaFile: string | null;
}): CompletionCriterion[] | null {
  const raw = options.criteriaJson
    ? options.criteriaJson
    : options.criteriaFile
      ? readFileSync(options.criteriaFile, 'utf-8')
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

// ── Task Graph Validation ──────────────────────────────────────────────────────

export function assertAcyclicTaskGraph(tasks: Task[]): void {
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

export function normalizeCustomTasks(tasks: TaskInput[]): Task[] {
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

// ── Workstream Inference ───────────────────────────────────────────────────────

export function inferWorkstreamType(goal: string): { primaryType: TaskType; executionTitle: string; executionDescription: string } {
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

// ── Parallel Task Building ─────────────────────────────────────────────────────

export function buildParallelTasks(count: number, mission: Mission): Task[] {
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
      []
    );
  });
}

// ── Plan Output Building ───────────────────────────────────────────────────────

export function buildPlannedOutput(
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
