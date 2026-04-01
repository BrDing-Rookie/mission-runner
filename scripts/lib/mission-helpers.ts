import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { appendEvent, readMission, safeWriteFile, writeMission } from './fs-utils.ts';
import { commitMissionUpdate } from './mission-commit.ts';
import type { CompletionCriterion, Mission, MissionArtifact, MissionStatus, RiskPolicy, Task, TaskArtifact, TaskPhase, TaskStatus, TaskType, VerificationStatus } from './types.ts';

// Re-export for convenience
export type { TaskType } from './types.ts';

export interface MissionCliArgs { missionsDir: string; missionId: string; dryRun: boolean; }
export function parseMissionCliArgs(argv: string[]): MissionCliArgs {
  const args: MissionCliArgs = { missionsDir: './missions', missionId: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
  }
  return args;
}
export interface MissionActionCliArgs extends MissionCliArgs { action: string; }
export function parseMissionActionCliArgs(argv: string[]): MissionActionCliArgs {
  const args: MissionActionCliArgs = { ...parseMissionCliArgs(argv), action: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--action' && next) {
      args.action = next;
      i += 1;
    }
  }
  return args;
}
export function requireMission(args: MissionCliArgs): Mission {
  if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
  const mission = readMission(args.missionsDir, args.missionId);
  if (!mission) throw new Error(`Mission not found: ${args.missionId}`);
  return mission;
}
export function nowIso(): string { return new Date().toISOString(); }
export function missionPath(missionsDir: string, missionId: string, fileName: string): string { return join(missionsDir, missionId, fileName); }
export interface PlanDraft { summary: string; completionCriteria: CompletionCriterion[]; riskPolicy: RiskPolicy; tasks: Task[]; }
function inferTaskType(title: string): TaskType {
  const s = title.toLowerCase();
  if (s.includes('verify') || s.includes('validation')) return 'verification';
  if (s.includes('notify') || s.includes('summary')) return 'notification';
  if (s.includes('test')) return 'test';
  if (s.includes('review')) return 'review';
  if (s.includes('document') || s.includes('plan')) return 'document';
  if (s.includes('code') || s.includes('implement')) return 'code';
  if (s.includes('research') || s.includes('调研')) return 'research';
  return 'analysis';
}
export function buildDefaultPlan(mission: Mission): PlanDraft {
  const createdAt = nowIso();
  const titles = ['Clarify execution scope and expected deliverables', 'Execute the highest-value implementation step', 'Verify outputs against completion criteria'];
  const tasks: Task[] = titles.map((title, index) => ({ taskId: `T${index + 1}`, title, description: `${title} for mission goal: ${mission.goal}`, type: inferTaskType(title), status: index === 0 ? 'READY' : 'PENDING', dependsOn: index === 0 ? [] : [`T${index}`], priority: index + 1, createdAt, startedAt: null, endedAt: null, estimatedDuration: null, timeout: null, resultSummary: null, artifacts: [], retryCount: 0, maxRetries: 2, lastError: null, backgroundProcessId: null, config: {} }));
  return { summary: 'MVP default plan generated from mission goal to establish the create → plan → dispatch → verify chain.', completionCriteria: [{ id: 'C1', description: 'A concrete implementation step has been completed and captured in mission artifacts.', required: true, verified: false }, { id: 'C2', description: 'Verification result is recorded with any remaining gaps explicitly listed.', required: true, verified: false }], riskPolicy: { autoAllowed: ['read_repo', 'write_workspace', 'run_local_validation'], askOnce: ['modify_existing_code', 'spawn_background_process'], mustConfirm: ['destructive_operation', 'production_side_effect'] }, tasks };
}
export function formatPlanMarkdown(mission: Mission, plan: PlanDraft): string {
  const lines: string[] = [`# Plan for ${mission.missionId}`, '', '## Title', mission.title, '', '## Goal', mission.goal, '', '## Summary', plan.summary, '', '## Completion Criteria', ...plan.completionCriteria.map((c, i) => `${i + 1}. [ ] ${c.description}`), '', '## Tasks', ...plan.tasks.map((task, i) => `${i + 1}. **${task.taskId}** (${task.type}) - ${task.title}${task.dependsOn?.length ? ` | dependsOn: ${task.dependsOn.join(', ')}` : ''}`), '', '## Risk Policy', `- autoAllowed: ${(plan.riskPolicy.autoAllowed ?? []).join(', ') || 'none'}`, `- askOnce: ${(plan.riskPolicy.askOnce ?? []).join(', ') || 'none'}`, `- mustConfirm: ${(plan.riskPolicy.mustConfirm ?? []).join(', ') || 'none'}`];
  return lines.join('\n') + '\n';
}
export function persistMissionUpdate(missionsDir: string, mission: Mission, event: Record<string, unknown>, artifactWrites?: Array<{ path: string; content: string }>, oldMission?: Mission) {
  if (oldMission) {
    // 使用集中式提交层（含自动通知）
    const ok = commitMissionUpdate({
      missionsDir,
      oldMission,
      newMission: mission,
      dryRun: false,
      source: (event.type as string | undefined)?.replace(/^mission_/, '') ?? 'update',
      eventExtras: event,
      artifactWrites,
    });
    return { writeOk: ok, eventOk: ok, artifactsOk: ok };
  }
  // 向后兼容：无 oldMission 时走原有逻辑（跳过通知检测）
  console.warn('[persistMissionUpdate] oldMission not provided, skipping notification detection');
  const writeOk = writeMission(missionsDir, mission); const eventOk = appendEvent(missionsDir, mission.missionId, event); const artifactsOk = (artifactWrites ?? []).every((a) => safeWriteFile(a.path, a.content));
  return { writeOk, eventOk, artifactsOk };
}
export function loadTextIfExists(filePath: string): string | null { return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null; }
export function upsertArtifact(artifacts: MissionArtifact[] | undefined, artifact: MissionArtifact): MissionArtifact[] {
  const next = [...(artifacts ?? [])]; const index = next.findIndex((item) => item.path === artifact.path); if (index >= 0) next[index] = artifact; else next.push(artifact); return next;
}
export function upsertTaskArtifact(artifacts: TaskArtifact[] | undefined, artifact: TaskArtifact): TaskArtifact[] {
  const next = [...(artifacts ?? [])]; const index = next.findIndex((item) => item.path === artifact.path); if (index >= 0) next[index] = artifact; else next.push(artifact); return next;
}
/**
 * Unified mission status derivation from task states.
 * WAITING_BACKGROUND takes priority, then RUNNING/READY, then all-terminal → VERIFYING.
 */
export function deriveMissionStatus(originalStatus: MissionStatus, tasks: Task[]): MissionStatus {
  if (tasks.length === 0) return originalStatus;
  const TERMINAL: TaskStatus[] = ['COMPLETED', 'FAILED', 'SKIPPED'];
  if (tasks.some((t) => t.status === 'WAITING_BACKGROUND')) return 'WAITING_BACKGROUND';
  if (tasks.some((t) => t.status === 'RUNNING' || t.status === 'READY')) return 'RUNNING';
  if (tasks.every((t) => TERMINAL.includes(t.status))) return 'VERIFYING';
  return originalStatus;
}
export function setMissionStatus(mission: Mission, status: MissionStatus): Mission {
  const timestamp = nowIso(); return { ...mission, status, updatedAt: timestamp, lastProgressAt: timestamp };
}
export function setVerification(mission: Mission, verification: { status: VerificationStatus; summary: string; gaps: string[]; criteriaResults?: Array<{ criterionId: string; passed: boolean; reason: string }> }): Mission {
  const timestamp = nowIso(); return { ...mission, updatedAt: timestamp, verification: { status: verification.status, lastCheckedAt: timestamp, summary: verification.summary, gaps: verification.gaps, criteriaResults: verification.criteriaResults } };
}

/** 构建标准 TASK-ENVELOPE 文本，用于跨 Agent 派发 */
export function buildTaskEnvelope(task: Task, mission: Mission, agentId: string): string {
  const lines = [
    '---TASK-ENVELOPE---',
    `RUN: ${mission.missionId}`,
    `TASK: ${task.taskId}`,
    `BACKEND: ${agentId}`,
    `WORKDIR: ${mission.metadata?.workdir ?? ''}`,
    `FOCUS: ${task.title}`,
    `EPOCH: ${mission.currentIteration ?? 1}`,
    `TIMEOUT: ${task.timeout ?? 600}s`,
    '---END-ENVELOPE---',
    '',
    task.description ?? task.title,
  ];
  return lines.join('\n');
}

/** 根据 task type 自动推导 Dashboard 分组 phase */
export function derivePhaseFromTask(task: Task): TaskPhase {
  const map: Record<string, TaskPhase> = {
    research: 'research',
    analysis: 'analysis',
    code: 'implement',
    test: 'test',
    review: 'review',
    deploy: 'deploy',
    document: 'document',
  };
  return map[task.type] ?? 'general';
}

// ==================== Parallel / Serial / JSON Task Builders ====================

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'task';
}

/**
 * 生成 N 个并行 task，dependsOn 为空，共享同一个 phase。
 */
export function buildParallelTasks(count: number, mission: Mission): Task[] {
  const createdAt = nowIso();
  const prefix = slugify(mission.title || mission.goal || mission.missionId);
  return Array.from({ length: count }, (_, index) => {
    const lane = index + 1;
    const task: Task = {
      taskId: `${prefix}-lane-${lane}`,
      title: `并行分支 ${lane}/${count}`,
      description: `独立执行分支 ${lane}，与其他分支无依赖。`,
      type: 'research',
      status: 'READY',
      dependsOn: [],
      priority: 100 - index,
      createdAt,
      startedAt: null,
      endedAt: null,
      estimatedDuration: null,
      timeout: null,
      resultSummary: null,
      artifacts: [],
      retryCount: 0,
      maxRetries: 2,
      lastError: null,
      backgroundProcessId: null,
      config: {},
    };
    task.phase = derivePhaseFromTask(task);
    return task;
  });
}

/**
 * 生成 stages.length 个串行 task，每个依赖前一个。
 */
export function buildSerialTasks(stages: string[], mission: Mission): Task[] {
  if (stages.length === 0) return [];
  const createdAt = nowIso();
  const prefix = slugify(mission.title || mission.goal || mission.missionId);
  return stages.map((title, index) => {
    const taskId = `${prefix}-step-${index + 1}`;
    const dependsOn = index === 0 ? [] : [`${prefix}-step-${index}`];
    const task: Task = {
      taskId,
      title,
      description: title,
      type: inferTaskType(title),
      status: index === 0 ? 'READY' : 'PENDING',
      dependsOn,
      priority: 100 - index * 10,
      createdAt,
      startedAt: null,
      endedAt: null,
      estimatedDuration: null,
      timeout: null,
      resultSummary: null,
      artifacts: [],
      retryCount: 0,
      maxRetries: 2,
      lastError: null,
      backgroundProcessId: null,
      config: {},
    };
    task.phase = derivePhaseFromTask(task);
    return task;
  });
}

type TaskJsonInput = Partial<Task> & { taskId: string; title: string; type: TaskType };

/**
 * 解析 JSON 输入并补全默认字段（status、priority、retryCount 等）。
 */
export function buildTasksFromJSON(jsonInput: string, _mission: Mission): Task[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse tasks JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Tasks JSON must be an array');
  }

  const createdAt = nowIso();
  return (parsed as TaskJsonInput[]).map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Task at index ${index} must be an object`);
    }
    if (!raw.taskId?.trim()) throw new Error(`Task at index ${index} is missing taskId`);
    if (!raw.title?.trim()) throw new Error(`Task ${raw.taskId} is missing title`);
    if (!raw.type) throw new Error(`Task ${raw.taskId} is missing type`);

    const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn : [];
    const task: Task = {
      taskId: raw.taskId.trim(),
      title: raw.title.trim(),
      description: raw.description ?? raw.title.trim(),
      type: raw.type,
      status: raw.status ?? (dependsOn.length > 0 ? 'PENDING' : 'READY'),
      dependsOn,
      priority: raw.priority ?? 10,
      createdAt: raw.createdAt ?? createdAt,
      startedAt: raw.startedAt ?? null,
      endedAt: raw.endedAt ?? null,
      estimatedDuration: raw.estimatedDuration ?? null,
      timeout: raw.timeout ?? null,
      resultSummary: raw.resultSummary ?? null,
      artifacts: raw.artifacts ?? [],
      retryCount: raw.retryCount ?? 0,
      maxRetries: raw.maxRetries ?? 2,
      lastError: raw.lastError ?? null,
      backgroundProcessId: raw.backgroundProcessId ?? null,
      config: raw.config ?? {},
    };
    task.phase = raw.phase ?? derivePhaseFromTask(task);
    return task;
  });
}
