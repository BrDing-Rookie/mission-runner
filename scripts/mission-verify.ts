#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { loadTextIfExists, missionPath, parseMissionCliArgs, type MissionCliArgs, persistMissionUpdate, requireMission, setMissionStatus, setVerification, upsertArtifact } from './lib/mission-helpers.ts';
import type { CompletionCriterion, MissionStatus, VerificationStatus } from './lib/types.ts';

type CriterionResult = {
  criterionId: string;
  passed: boolean;
  reason: string;
};

function evaluateCriterion(criterion: CompletionCriterion, context: {
  hasPlan: boolean;
  hasArtifacts: boolean;
  hasPendingTasks: boolean;
  hasFailedTasks: boolean;
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
  const needsTerminalTasks = (criterion.required ?? false) || !mentionsPlan;

  const reasons: string[] = [];
  if (mentionsPlan && !context.hasPlan) reasons.push('plan.md artifact is missing');
  if (mentionsArtifact && !context.hasArtifacts) reasons.push('mission artifacts are missing deliverables beyond plan.md/verification.md');
  if (needsTerminalTasks && context.hasPendingTasks) reasons.push('not all tasks are in terminal states');
  if (context.hasFailedTasks) reasons.push('failed tasks are present');

  return {
    criterionId: criterion.id,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? 'Satisfied by current mission state under MVP verification rules.' : reasons.join('; '),
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

  if (!planText) gaps.push('Missing plan.md artifact.');
  if (tasks.length === 0) gaps.push('Mission has no planned tasks.');
  if (pendingTasks.length > 0) gaps.push(`Pending non-terminal tasks: ${pendingTasks.map((task) => `${task.taskId}:${task.status}`).join(', ')}`);
  if (failedTasks.length > 0) gaps.push(`Failed tasks present: ${failedTasks.map((task) => task.taskId).join(', ')}`);

  const criterionResults = completionCriteria.map((criterion) => evaluateCriterion(criterion, {
    hasPlan: Boolean(planText),
    hasArtifacts: nonMetaArtifacts.length > 0,
    hasPendingTasks: pendingTasks.length > 0,
    hasFailedTasks: failedTasks.length > 0,
  }));

  for (const criterion of completionCriteria) {
    if (criterion.required === false) continue;
    const result = criterionResults.find((item) => item.criterionId === criterion.id);
    if (result && !result.passed) {
      gaps.push(`Completion criterion ${criterion.id} not satisfied: ${result.reason}`);
    }
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
  const verificationMarkdown = [
    `# Verification for ${mission.missionId}`,
    '',
    `- status: ${verificationStatus}`,
    `- completedTasks: ${completedTasks}/${tasks.length}`,
    `- completionCriteriaSatisfied: ${criteriaPassed}/${completionCriteria.length}`,
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
  }, [{ path: verificationFile, content: verificationMarkdown }]);

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
