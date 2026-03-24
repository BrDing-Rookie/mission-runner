import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { appendEvent, readMission, safeWriteFile, writeMission } from './fs-utils.ts';
import type { CompletionCriterion, Mission, MissionArtifact, MissionStatus, RiskPolicy, Task, TaskArtifact, TaskStatus, TaskType, VerificationStatus } from './types.ts';

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
export function persistMissionUpdate(missionsDir: string, mission: Mission, event: Record<string, unknown>, artifactWrites?: Array<{ path: string; content: string }>) {
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
