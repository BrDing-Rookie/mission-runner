/**
 * mission-verifier.ts — Core verification logic
 *
 * Extracted from mission-verify.ts: plan criteria extraction, artifact
 * file listing, criterion evaluation, and verification result computation.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionCriterion, Mission, MissionStatus, VerificationStatus } from './types.ts';
import { loadTextIfExists, missionPath, setMissionStatus, setVerification, upsertArtifact } from './mission-helpers.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export type CriterionResult = {
  criterionId: string;
  passed: boolean;
  reason: string;
};

export interface VerifyResult {
  missionId: string;
  verificationStatus: VerificationStatus;
  missionStatus: MissionStatus;
  gaps: string[];
  criteriaResults: CriterionResult[];
  success: boolean;
  changed: boolean;
  dryRun: boolean;
}

// ── Plan Criteria Extraction ───────────────────────────────────────────────────

/**
 * Extract custom completion criteria from plan.md.
 * Looks for numbered list items under "## Completion Criteria" or "## 完成标准".
 */
export function extractPlanCriteria(planText: string): string[] {
  const criteria: string[] = [];
  const lines = planText.split('\n');
  let inCriteriaSection = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      const heading = headingMatch[1].toLowerCase().trim();
      inCriteriaSection = heading.includes('completion criteria') || heading.includes('完成标准') || heading.includes('验收标准');
      continue;
    }

    if (inCriteriaSection) {
      const itemMatch = line.match(/^\s*(?:\d+\.|\-|\*)\s*(?:\[.\]\s*)?(.+)/);
      if (itemMatch) {
        criteria.push(itemMatch[1].trim());
      }
    }
  }

  return criteria;
}

// ── Artifact File Listing ──────────────────────────────────────────────────────

/**
 * List artifact files in the mission artifacts directory.
 */
export function listArtifactFiles(missionsDir: string, missionId: string): string[] {
  const artifactsDir = join(missionsDir, missionId, 'artifacts');
  if (!existsSync(artifactsDir)) return [];

  const files: string[] = [];
  try {
    const entries = readdirSync(artifactsDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(artifactsDir, entry.name);
      if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        try {
          const subEntries = readdirSync(fullPath, { recursive: true });
          for (const sub of subEntries) {
            files.push(join(fullPath, String(sub)));
          }
        } catch { /* ignore unreadable dirs */ }
      }
    }
  } catch { /* ignore */ }
  return files;
}

// ── Artifact Existence Check ───────────────────────────────────────────────────

function artifactFileExists(missionsDir: string, missionId: string, artifactPath: string): boolean {
  if (existsSync(artifactPath)) return true;

  const missionPrefix = `missions/${missionId}/`;
  const stripped = artifactPath.startsWith(missionPrefix)
    ? artifactPath.slice(missionPrefix.length)
    : artifactPath;

  const missionDir = join(missionsDir, missionId);
  if (existsSync(join(missionDir, stripped))) return true;
  if (existsSync(join(missionsDir, artifactPath))) return true;
  if (existsSync(join(missionsDir, '..', artifactPath))) return true;

  return false;
}

// ── Criterion Evaluation ───────────────────────────────────────────────────────

export function evaluateCriterion(criterion: CompletionCriterion, context: {
  hasPlan: boolean;
  hasArtifacts: boolean;
  hasPendingTasks: boolean;
  hasFailedTasks: boolean;
  planCriteria: string[];
  artifactFiles: string[];
  missionArtifacts: string[];
  missionsDir: string;
  missionId: string;
}): CriterionResult {
  if (criterion.verified === true) {
    return { criterionId: criterion.id, passed: true, reason: 'Criterion already explicitly marked verified=true.' };
  }

  const expected = `${criterion.id} ${criterion.description}`.toLowerCase();
  const mentionsPlan = expected.includes('plan');
  const mentionsArtifact = ['artifact', 'deliverable', 'output', '交付物', '产出'].some((token) => expected.includes(token));
  const mentionsFile = ['file', '文件', 'exists', 'exist', 'present', '生成'].some((token) => expected.includes(token));
  const needsTerminalTasks = (criterion.required ?? false) || !mentionsPlan;

  const reasons: string[] = [];
  if (mentionsPlan && !context.hasPlan) reasons.push('plan.md artifact is missing');
  if (mentionsArtifact && !context.hasArtifacts) reasons.push('mission artifacts are missing deliverables beyond plan.md/verification.md');
  if (needsTerminalTasks && context.hasPendingTasks) reasons.push('not all tasks are in terminal states');
  if (context.hasFailedTasks) reasons.push('failed tasks are present');

  if (mentionsFile || mentionsArtifact) {
    const referencedFiles = context.missionArtifacts;
    if (referencedFiles.length === 0 && context.artifactFiles.length === 0) {
      reasons.push('no artifact files found on disk');
    } else {
      for (const artPath of referencedFiles) {
        if (!artifactFileExists(context.missionsDir, context.missionId, artPath)) {
          reasons.push(`referenced artifact not found on disk: ${artPath}`);
        }
      }
    }
  }

  return {
    criterionId: criterion.id,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? 'Satisfied by current mission state under enhanced verification rules.' : reasons.join('; '),
  };
}

// ── Verification Markdown ──────────────────────────────────────────────────────

export function buildVerificationMarkdown(
  mission: Mission,
  verificationStatus: VerificationStatus,
  verificationSummary: string,
  criterionResults: CriterionResult[],
  completionCriteria: CompletionCriterion[],
  planCriteria: string[],
  artifactFiles: string[],
  gaps: string[],
  currentIteration: number,
  maxIterations: number,
  completedTasks: number,
  totalTasks: number,
): string {
  return [
    `# Verification for ${mission.missionId}`,
    '',
    `- status: ${verificationStatus}`,
    `- completedTasks: ${completedTasks}/${totalTasks}`,
    `- completionCriteriaSatisfied: ${criterionResults.filter((r) => r.passed).length}/${completionCriteria.length}`,
    `- iteration: ${currentIteration}/${maxIterations === Number.MAX_SAFE_INTEGER ? '∞' : maxIterations}`,
    `- artifactFiles: ${artifactFiles.length}`,
    `- planCriteriaFound: ${planCriteria.length}`,
    '',
    '## Summary',
    verificationSummary,
    '',
    '## Completion Criteria',
    ...(criterionResults.length === 0
      ? ['- none declared']
      : criterionResults.map((result) => {
          const criterion = completionCriteria.find((item) => item.id === result.criterionId);
          const required = criterion?.required === false ? 'optional' : 'required';
          const state = result.passed ? 'PASS' : 'GAP';
          return `- [${state}] ${result.criterionId} (${required}): ${criterion?.description ?? 'Unknown criterion'} — ${result.reason}`;
        })),
    '',
    '## Plan-Defined Criteria',
    ...(planCriteria.length === 0
      ? ['- none found in plan.md']
      : planCriteria.map((c, i) => `${i + 1}. ${c}`)),
    '',
    '## Artifact Files',
    ...(artifactFiles.length === 0
      ? ['- no artifact files found']
      : artifactFiles.map((f) => `- ${f}`)),
    '',
    '## Gaps',
    ...(gaps.length === 0 ? ['- none'] : gaps.map((gap) => `- ${gap}`)),
    '',
  ].join('\n');
}

// ── Core Verify Logic ──────────────────────────────────────────────────────────

export interface VerifyInput {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
}

export interface VerifyComputed {
  mission: Mission;
  verificationStatus: VerificationStatus;
  missionStatus: MissionStatus;
  gaps: string[];
  criteriaResults: CriterionResult[];
  verificationMarkdown: string;
  verificationFile: string;
  updatedMission: Mission;
}

export function computeVerification(args: VerifyInput, mission: Mission): VerifyComputed {
  const tasks = mission.tasks ?? [];
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
  const failedTasks = tasks.filter((task) => task.status === 'FAILED');
  const pendingTasks = tasks.filter((task) => !['COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status));
  const planText = loadTextIfExists(missionPath(args.missionsDir, mission.missionId, 'plan.md'));
  const completionCriteria = mission.completionCriteria ?? [];
  const missionArtifacts = mission.artifacts ?? [];
  const nonMetaArtifacts = missionArtifacts.filter((a) => !a.path.endsWith('/plan.md') && a.path !== 'plan.md' && !a.path.endsWith('/verification.md') && a.path !== 'verification.md');
  const gaps: string[] = [];

  const planCriteria = planText ? extractPlanCriteria(planText) : [];
  const artifactFiles = listArtifactFiles(args.missionsDir, mission.missionId);

  if (!planText) gaps.push('Missing plan.md artifact.');
  if (tasks.length === 0) gaps.push('Mission has no planned tasks.');
  if (pendingTasks.length > 0) gaps.push(`Pending non-terminal tasks: ${pendingTasks.map((task) => `${task.taskId}:${task.status}`).join(', ')}`);
  if (failedTasks.length > 0) gaps.push(`Failed tasks present: ${failedTasks.map((task) => task.taskId).join(', ')}`);

  const criterionResults = completionCriteria.map((criterion) => evaluateCriterion(criterion, {
    hasPlan: Boolean(planText),
    hasArtifacts: nonMetaArtifacts.length > 0,
    hasPendingTasks: pendingTasks.length > 0,
    hasFailedTasks: failedTasks.length > 0,
    planCriteria,
    artifactFiles,
    missionArtifacts: missionArtifacts.map((a) => a.path),
    missionsDir: args.missionsDir,
    missionId: mission.missionId,
  }));

  for (const criterion of completionCriteria) {
    if (criterion.required === false) continue;
    const result = criterionResults.find((item) => item.criterionId === criterion.id);
    if (result && !result.passed) {
      gaps.push(`Completion criterion ${criterion.id} not satisfied: ${result.reason}`);
    }
  }

  if (planCriteria.length > completionCriteria.length) {
    gaps.push(`Plan.md defines ${planCriteria.length} completion criteria but mission has only ${completionCriteria.length}; consider updating mission completionCriteria.`);
  }

  const currentIteration = mission.currentIteration ?? 0;
  const maxIterations = mission.maxIterations ?? Number.MAX_SAFE_INTEGER;
  const iterationLimitReached = gaps.length > 0 && currentIteration >= maxIterations;

  const verificationStatus: VerificationStatus = gaps.length === 0
    ? 'PASS'
    : iterationLimitReached
      ? 'NONRETRYABLE_FAILURE'
      : 'RETRYABLE_GAP';

  if (iterationLimitReached) {
    gaps.push(`Max iterations reached (${currentIteration}/${maxIterations}); mission cannot retry further.`);
  }

  const criteriaPassed = criterionResults.filter((r) => r.passed).length;
  const verificationSummary = gaps.length === 0
    ? `Verification passed with ${completedTasks}/${tasks.length} tasks completed and ${criteriaPassed}/${completionCriteria.length} completion criteria satisfied.`
    : iterationLimitReached
      ? `Verification failed permanently: iteration limit ${maxIterations} reached with ${gaps.length} unresolved gap(s).`
      : `Verification found ${gaps.length} gap(s); completed ${completedTasks}/${tasks.length} tasks and satisfied ${criteriaPassed}/${completionCriteria.length} completion criteria.`;

  const now = new Date().toISOString();
  const verificationFile = missionPath(args.missionsDir, mission.missionId, 'verification.md');

  const verificationMarkdown = buildVerificationMarkdown(
    mission, verificationStatus, verificationSummary,
    criterionResults, completionCriteria, planCriteria, artifactFiles, gaps,
    currentIteration, maxIterations, completedTasks, tasks.length,
  );

  const newMissionStatus: MissionStatus = verificationStatus === 'PASS'
    ? 'COMPLETED'
    : verificationStatus === 'NONRETRYABLE_FAILURE'
      ? 'FAILED'
      : 'ITERATING';

  const verifiedMission = setVerification(mission, { status: verificationStatus, summary: verificationSummary, gaps, criteriaResults: criterionResults });
  const updatedMission = {
    ...setMissionStatus(verifiedMission, newMissionStatus),
    artifacts: upsertArtifact(verifiedMission.artifacts, { path: `missions/${mission.missionId}/verification.md`, type: 'summary' as const, description: 'Verification result summary', generatedAt: now }),
    nextWakeAt: verificationStatus === 'PASS' || verificationStatus === 'NONRETRYABLE_FAILURE' ? null : now,
    currentIteration: verificationStatus === 'RETRYABLE_GAP' ? currentIteration + 1 : currentIteration,
  };

  return {
    mission,
    verificationStatus,
    missionStatus: newMissionStatus,
    gaps,
    criteriaResults: criterionResults,
    verificationMarkdown,
    verificationFile,
    updatedMission,
  };
}
