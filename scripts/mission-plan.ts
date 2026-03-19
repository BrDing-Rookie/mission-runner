#!/usr/bin/env node

import { join } from 'path';
import { appendEvent, readMission, safeWriteFile, writeMission } from './lib/fs-utils.ts';
import type { CompletionCriterion, Mission, Task, TaskType } from './lib/types.ts';

interface PlanArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
}

interface PlannedOutput {
  completionCriteria: CompletionCriterion[];
  tasks: Task[];
  planMarkdown: string;
}

function parseArgs(argv: string[]): PlanArgs {
  const args: PlanArgs = {
    missionsDir: './missions',
    missionId: '',
    dryRun: false,
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

function inferWorkstream(goal: string): { primaryType: TaskType; executionTitle: string; executionDescription: string } {
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

function buildPlannedOutput(mission: Mission): PlannedOutput {
  const workstream = inferWorkstream(mission.goal);
  const taskPrefix = slugify(mission.title || mission.goal || mission.missionId);

  const criteria: CompletionCriterion[] = [
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

  const tasks: Task[] = [
    createTask(
      `${taskPrefix}-context`,
      '收集上下文与输入边界',
      'analysis',
      '读取 mission 目标、现有文档和相关工件，确认范围、约束和完成定义。',
      100
    ),
    createTask(
      `${taskPrefix}-execute`,
      workstream.executionTitle,
      workstream.primaryType,
      workstream.executionDescription,
      80,
      [`${taskPrefix}-context`]
    ),
    createTask(
      `${taskPrefix}-verify`,
      '验证完成标准并形成结论',
      'verification',
      '运行必要检查、对照 completion criteria 判断 PASS / GAP / ESCALATE。',
      60,
      [`${taskPrefix}-execute`]
    ),
  ];

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
      return `${index + 1}. ${task.taskId} | type=${task.type} | status=${task.status}${dependsText}\n   - ${task.description ?? task.title}`;
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

function main(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    assertRequired(args);

    const mission = readMission(args.missionsDir, args.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${args.missionId}`);
    }

    const output = buildPlannedOutput(mission);
    const nowIso = new Date().toISOString();
    const nextWakeAt = mission.nextWakeAt ?? nowIso;
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
    };

    const missionDir = join(args.missionsDir, mission.missionId);
    const planPath = join(missionDir, 'plan.md');

    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: mission.missionId, output, updatedMission, planPath }, null, 2));
      return 0;
    }

    const planOk = safeWriteFile(planPath, output.planMarkdown);
    const missionOk = writeMission(args.missionsDir, updatedMission);
    const eventOk = appendEvent(args.missionsDir, mission.missionId, {
      type: 'mission_planned',
      statusFrom: mission.status,
      statusTo: updatedMission.status,
      taskCount: output.tasks.length,
      completionCriteriaCount: output.completionCriteria.length,
      artifactPath: 'plan.md',
    });

    if (!planOk || !missionOk || !eventOk) {
      console.error(`[mission-plan] failed | missionId=${mission.missionId} | plan=${planOk} | mission=${missionOk} | event=${eventOk}`);
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

process.exitCode = main();
