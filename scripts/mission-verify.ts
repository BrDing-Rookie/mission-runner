#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'url';
import { loadTextIfExists, missionPath, parseMissionCliArgs, type MissionCliArgs, persistMissionUpdate, requireMission, setMissionStatus, setVerification, upsertArtifact } from './lib/mission-helpers.ts';
import type { CompletionCriterion, Mission, MissionStatus, VerificationStatus } from './lib/types.ts';

type CriterionResult = {
  criterionId: string;
  passed: boolean;
  reason: string;
};

/**
 * Extract custom completion criteria from plan.md.
 * Looks for numbered list items under "## Completion Criteria" or "## 完成标准".
 */
function extractPlanCriteria(planText: string): string[] {
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
      // Match numbered or bulleted list items: "1. ..." or "- ..." or "* ..." or "N. [ ] ..."
      const itemMatch = line.match(/^\s*(?:\d+\.|\-|\*)\s*(?:\[.\]\s*)?(.+)/);
      if (itemMatch) {
        criteria.push(itemMatch[1].trim());
      }
    }
  }

  return criteria;
}

/**
 * List artifact files in the mission artifacts directory.
 */
function listArtifactFiles(missionsDir: string, missionId: string): string[] {
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
        // Recursively list files in subdirectories
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

/**
 * Check if an artifact file exists at the given path (relative to mission dir or absolute).
 */
function artifactFileExists(missionsDir: string, missionId: string, artifactPath: string): boolean {
  // Try absolute path first
  if (existsSync(artifactPath)) return true;

  // Strip "missions/{missionId}/" prefix if present (artifact paths are stored this way)
  const missionPrefix = `missions/${missionId}/`;
  const stripped = artifactPath.startsWith(missionPrefix)
    ? artifactPath.slice(missionPrefix.length)
    : artifactPath;

  // Try relative to mission dir (e.g., "artifacts/CHANGELOG.md" under missions/{id}/)
  const missionDir = join(missionsDir, missionId);
  const missionRelative = join(missionDir, stripped);
  if (existsSync(missionRelative)) return true;

  // Try relative to missions dir (e.g., full "missions/{id}/artifacts/..." under missionsDir parent)
  const missionsRelative = join(missionsDir, artifactPath);
  if (existsSync(missionsRelative)) return true;

  // Try resolving from missionsDir parent (workspace root)
  const parentDir = join(missionsDir, '..');
  const parentRelative = join(parentDir, artifactPath);
  if (existsSync(parentRelative)) return true;

  return false;
}

function evaluateCriterion(criterion: CompletionCriterion, context: {
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
    return {
      criterionId: criterion.id,
      passed: true,
      reason: 'Criterion already explicitly marked verified=true.',
    };
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

  // Check for file existence if criterion mentions specific files
  if (mentionsFile || mentionsArtifact) {
    const referencedFiles = context.missionArtifacts;
    if (referencedFiles.length === 0 && context.artifactFiles.length === 0) {
      reasons.push('no artifact files found on disk');
    } else {
      // Verify that referenced artifact files actually exist on disk
      for (const artPath of referencedFiles) {
        if (!artifactFileExists(context.missionsDir, context.missionId, artPath)) {
          reasons.push(`referenced artifact not found on disk: ${artPath}`);
        }
      }
    }
  }

  // Enhanced: check plan.md criteria match
  if (context.planCriteria.length > 0) {
    const descLower = criterion.description.toLowerCase();
    const matchingPlanCriterion = context.planCriteria.find((pc) => {
      const pcLower = pc.toLowerCase();
      // Fuzzy match: if the criterion description shares significant words with a plan criterion
      const words = descLower.split(/\s+/).filter((w) => w.length > 3);
      const matchCount = words.filter((w) => pcLower.includes(w)).length;
      return matchCount >= Math.min(2, words.length);
    });
    if (matchingPlanCriterion) {
      // If there's a matching plan criterion, check if task artifacts satisfy it
      // This is informational — we still apply the same heuristic
    }
  }

  return {
    criterionId: criterion.id,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? 'Satisfied by current mission state under enhanced verification rules.' : reasons.join('; '),
  };
}

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

export function runVerify(args: MissionCliArgs): VerifyResult {
  const mission = requireMission(args);
  const tasks = mission.tasks ?? [];
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
  const failedTasks = tasks.filter((task) => task.status === 'FAILED');
  const pendingTasks = tasks.filter((task) => !['COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status));
  const planText = loadTextIfExists(missionPath(args.missionsDir, mission.missionId, 'plan.md'));
  const completionCriteria = mission.completionCriteria ?? [];
  const missionArtifacts = mission.artifacts ?? [];
  const nonMetaArtifacts = missionArtifacts.filter((artifact) => !artifact.path.endsWith('/plan.md') && artifact.path !== 'plan.md' && !artifact.path.endsWith('/verification.md') && artifact.path !== 'verification.md');
  const gaps: string[] = [];

  // Enhanced: extract custom criteria from plan.md
  const planCriteria = planText ? extractPlanCriteria(planText) : [];

  // Enhanced: list actual artifact files on disk
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

  // Enhanced: if plan.md has criteria not in mission's completionCriteria, report them
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

  const criteriaPassed = criterionResults.filter((result) => result.passed).length;
  const verificationSummary = gaps.length === 0
    ? `Verification passed with ${completedTasks}/${tasks.length} tasks completed and ${criteriaPassed}/${completionCriteria.length} completion criteria satisfied.`
    : iterationLimitReached
      ? `Verification failed permanently: iteration limit ${maxIterations} reached with ${gaps.length} unresolved gap(s).`
      : `Verification found ${gaps.length} gap(s); completed ${completedTasks}/${tasks.length} tasks and satisfied ${criteriaPassed}/${completionCriteria.length} completion criteria.`;
  const now = new Date().toISOString();
  const verificationFile = missionPath(args.missionsDir, mission.missionId, 'verification.md');

  // Enhanced: more detailed verification.md
  const verificationMarkdown = [
    `# Verification for ${mission.missionId}`,
    '',
    `- status: ${verificationStatus}`,
    `- completedTasks: ${completedTasks}/${tasks.length}`,
    `- completionCriteriaSatisfied: ${criteriaPassed}/${completionCriteria.length}`,
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

  const verifiedMission = setVerification(mission, { status: verificationStatus, summary: verificationSummary, gaps, criteriaResults: criterionResults });
  const newMissionStatus: MissionStatus = verificationStatus === 'PASS'
    ? 'COMPLETED'
    : verificationStatus === 'NONRETRYABLE_FAILURE'
      ? 'FAILED'
      : 'ITERATING';
  const updated = {
    ...setMissionStatus(verifiedMission, newMissionStatus),
    artifacts: upsertArtifact(verifiedMission.artifacts, { path: `missions/${mission.missionId}/verification.md`, type: 'summary' as const, description: 'Verification result summary', generatedAt: now }),
    nextWakeAt: verificationStatus === 'PASS' || verificationStatus === 'NONRETRYABLE_FAILURE' ? null : now,
    currentIteration: verificationStatus === 'RETRYABLE_GAP' ? currentIteration + 1 : currentIteration,
  };

  if (args.dryRun) {
    return {
      missionId: mission.missionId,
      verificationStatus,
      missionStatus: newMissionStatus,
      gaps,
      criteriaResults: criterionResults,
      success: true,
      changed: false,
      dryRun: true,
    };
  }

  const persistResult = persistMissionUpdate(args.missionsDir, updated, {
    type: 'mission_verified',
    verificationStatus,
    missionStatus: updated.status,
    gaps,
    criteriaResults: criterionResults,
  }, [{ path: verificationFile, content: verificationMarkdown }], mission);

  if (!persistResult.writeOk || !persistResult.eventOk || !persistResult.artifactsOk) {
    throw new Error(`Failed to persist verification: write=${persistResult.writeOk} event=${persistResult.eventOk} artifacts=${persistResult.artifactsOk}`);
  }

  return {
    missionId: mission.missionId,
    verificationStatus,
    missionStatus: newMissionStatus,
    gaps,
    criteriaResults: criterionResults,
    success: true,
    changed: true,
    dryRun: false,
  };
}

function main(): number {
  try {
    const args = parseMissionCliArgs(process.argv.slice(2));
    const result = runVerify(args);
    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: result.missionId, verificationStatus: result.verificationStatus, missionStatus: result.missionStatus, gaps: result.gaps, criteriaResults: result.criteriaResults }, null, 2));
    } else {
      console.log(`[mission-verify] verified | missionId=${result.missionId} | verification=${result.verificationStatus} | status=${result.missionStatus} | criteria=${result.criteriaResults.filter((r) => r.passed).length}/${result.criteriaResults.length}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-verify] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}

// Exported for testing
export { extractPlanCriteria, listArtifactFiles };
