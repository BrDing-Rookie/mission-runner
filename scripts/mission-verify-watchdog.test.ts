import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVerify } from './mission-verify.ts';
import { evaluateMission } from './mission-watchdog.ts';
import { DEFAULT_WATCHDOG_CONFIG, type Mission } from './lib/types.ts';
import { readMissionFile, readEvents, writeMissionFixture } from './test-helpers.ts';

const BASE_TS = '2026-03-28T00:00:00.000Z';

function verifyMissionFixture(mission: Mission): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-verify-watchdog-'));
  writeMissionFixture(missionsDir, mission);
  return { missionsDir, missionId: mission.missionId };
}

function baseMission(overrides: Partial<Mission> & { missionId: string }): Mission {
  return {
    title: 'Test mission',
    goal: 'Test goal',
    status: 'VERIFYING',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    ...overrides,
  };
}

const wdConfig = (overrides?: Partial<typeof DEFAULT_WATCHDOG_CONFIG>) => ({
  ...DEFAULT_WATCHDOG_CONFIG,
  missionsDir: './missions',
  ...overrides,
});

// ==================== runVerify tests ====================

test('runVerify ignores failed optional completion criteria when mission state is otherwise complete', () => {
  const missionId = 'mission-verify-optional-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [{ id: 'optional-artifact', description: 'Artifact deliverable exists', required: false }],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'PASS');
  assert.equal(result.missionStatus, 'COMPLETED');
  assert.deepEqual(result.gaps, []);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'COMPLETED');
  assert.equal(updatedMission.verification?.status, 'PASS');
});

test('runVerify returns RETRYABLE_GAP and increments iteration when tasks are pending', () => {
  const missionId = 'verify-retryable-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    currentIteration: 1,
    maxIterations: 5,
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' },
      { taskId: 'T2', title: 'Still going', type: 'code', status: 'RUNNING' },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(result.missionStatus, 'ITERATING');
  assert.ok(result.gaps.some((g) => g.includes('Pending non-terminal tasks')));

  const updated = readMissionFile(missionsDir, missionId);
  assert.equal(updated.currentIteration, 2);
  assert.equal(updated.status, 'ITERATING');
});

test('runVerify returns NONRETRYABLE_FAILURE when iteration limit reached', () => {
  const missionId = 'verify-nonretryable-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    currentIteration: 3,
    maxIterations: 3,
    tasks: [
      { taskId: 'T1', title: 'Failed', type: 'code', status: 'FAILED' },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'NONRETRYABLE_FAILURE');
  assert.equal(result.missionStatus, 'FAILED');
  assert.ok(result.gaps.some((g) => g.includes('Max iterations reached')));

  const updated = readMissionFile(missionsDir, missionId);
  assert.equal(updated.status, 'FAILED');
});

test('runVerify reports gap when plan.md is missing', () => {
  const missionId = 'verify-no-plan-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
  }));
  // Intentionally do NOT create plan.md

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.ok(result.gaps.some((g) => g.includes('Missing plan.md')));
});

test('runVerify reports gap when mission has no tasks', () => {
  const missionId = 'verify-no-tasks-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.ok(result.gaps.some((g) => g.includes('no planned tasks')));
});

test('runVerify reports gap when failed tasks are present', () => {
  const missionId = 'verify-failed-tasks-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [
      { taskId: 'T1', title: 'OK', type: 'analysis', status: 'COMPLETED' },
      { taskId: 'T2', title: 'Bad', type: 'code', status: 'FAILED' },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.ok(result.gaps.some((g) => g.includes('Failed tasks present')));
});

test('runVerify reports gap when required completion criterion fails', () => {
  const missionId = 'verify-required-criterion-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'All artifact deliverables present', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.ok(result.gaps.some((g) => g.includes('Completion criterion C1 not satisfied')));
  const c1 = result.criteriaResults.find((r) => r.criterionId === 'C1');
  assert.ok(c1);
  assert.equal(c1.passed, false);
});

test('runVerify dry-run does not persist changes', () => {
  const missionId = 'verify-dryrun-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(result.verificationStatus, 'PASS');

  // Disk state unchanged
  const onDisk = readMissionFile(missionsDir, missionId);
  assert.equal(onDisk.status, 'VERIFYING'); // still original
  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 0);
});

test('runVerify emits mission_verified event on success', () => {
  const missionId = 'verify-event-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  runVerify({ missionsDir, missionId, dryRun: false });

  const events = readEvents(missionsDir, missionId);
  const verifyEvent = events.find((e) => e.type === 'mission_verified');
  assert.ok(verifyEvent, 'Expected mission_verified event');
  assert.equal(verifyEvent.verificationStatus, 'PASS');
});

test('runVerify treats already-verified criterion (verified=true) as passed', () => {
  const missionId = 'verify-preverified-001';
  const { missionsDir } = verifyMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Artifact deliverable output present', required: true, verified: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'PASS');
  const c1 = result.criteriaResults.find((r) => r.criterionId === 'C1');
  assert.ok(c1);
  assert.equal(c1.passed, true);
});

// ==================== evaluateMission (watchdog) tests ====================

test('evaluateMission keeps WAITING_BACKGROUND missions idle until nextWakeAt when no finished process exists', () => {
  const nowMs = Date.parse('2026-03-28T01:00:00.000Z');
  const mission = baseMission({
    missionId: 'watchdog-waiting-background-001',
    status: 'WAITING_BACKGROUND',
    nextWakeAt: '2026-03-28T02:00:00.000Z',
    tasks: [
      { taskId: 'T-bg', title: 'Background task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P-bg' },
    ],
    backgroundProcesses: [
      { processId: 'P-bg', taskId: 'T-bg', status: 'RUNNING', startedAt: '2026-03-28T00:10:00.000Z' },
    ],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'NONE');
  assert.match(result.reason, /Waiting for nextWakeAt/);
  assert.deepEqual(result.relatedTaskIds, ['T-bg']);
});

test('evaluateMission prefers RETRY_TASK for idle RUNNING missions with retryable failures', () => {
  const nowMs = Date.parse('2026-03-28T05:00:00.000Z');
  const mission = baseMission({
    missionId: 'watchdog-retryable-001',
    status: 'RUNNING',
    tasks: [
      { taskId: 'T-active', title: 'Still running task', type: 'analysis', status: 'RUNNING' },
      { taskId: 'T-fail', title: 'Retryable fail', type: 'code', status: 'FAILED', retryCount: 0, maxRetries: 2 },
    ],
    backgroundProcesses: [],
  });

  const result = evaluateMission(mission, wdConfig({ maxIdleTimeMs: 60_000 }), nowMs);
  assert.equal(result.action, 'RETRY_TASK');
  assert.match(result.reason, /retryable failed tasks/);
  assert.deepEqual(result.relatedTaskIds, ['T-fail']);
});

test('evaluateMission returns TRIGGER_VERIFY when RUNNING and all tasks terminal', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-all-terminal-001',
    status: 'RUNNING',
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' },
      { taskId: 'T2', title: 'Skipped', type: 'code', status: 'SKIPPED' },
    ],
    backgroundProcesses: [],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'TRIGGER_VERIFY');
  assert.match(result.reason, /All tasks are terminal/);
});

test('evaluateMission returns ESCALATE_STUCK when WAITING_BACKGROUND with empty backgroundProcesses', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-stuck-001',
    status: 'WAITING_BACKGROUND',
    tasks: [
      { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND' },
    ],
    backgroundProcesses: [],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'ESCALATE_STUCK');
  assert.match(result.reason, /backgroundProcesses is empty/);
});

test('evaluateMission returns CHECK_BACKGROUND when WAITING_BACKGROUND with finished processes', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-finished-bg-001',
    status: 'WAITING_BACKGROUND',
    tasks: [
      { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
    ],
    backgroundProcesses: [
      { processId: 'P1', taskId: 'T1', status: 'COMPLETED', startedAt: BASE_TS, endedAt: BASE_TS },
    ],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'CHECK_BACKGROUND');
  assert.match(result.reason, /finished background process/);
  assert.deepEqual(result.relatedTaskIds, ['T1']);
});

test('evaluateMission returns ESCALATE_STUCK when RUNNING idle with no retryable tasks', () => {
  const nowMs = Date.parse('2026-03-28T05:00:00.000Z');
  const mission = baseMission({
    missionId: 'watchdog-idle-stuck-001',
    status: 'RUNNING',
    tasks: [
      { taskId: 'T1', title: 'Running', type: 'analysis', status: 'RUNNING' },
    ],
    backgroundProcesses: [],
  });

  const result = evaluateMission(mission, wdConfig({ maxIdleTimeMs: 60_000 }), nowMs);
  assert.equal(result.action, 'ESCALATE_STUCK');
  assert.match(result.reason, /idle.*no retryable tasks/i);
});

test('evaluateMission returns NOTIFY_ESCALATION for BLOCKED_HIGH_RISK', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-blocked-001',
    status: 'BLOCKED_HIGH_RISK',
    escalation: { level: 'CRITICAL', reason: 'Needs human approval' },
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'NOTIFY_ESCALATION');
  assert.match(result.reason, /blocked on high-risk/i);
});

test('evaluateMission returns NONE for CREATED and PLANNED missions', () => {
  const nowMs = Date.parse(BASE_TS);
  for (const status of ['CREATED', 'PLANNED'] as const) {
    const mission = baseMission({ missionId: `watchdog-${status.toLowerCase()}-001`, status });
    const result = evaluateMission(mission, wdConfig(), nowMs);
    assert.equal(result.action, 'NONE', `Expected NONE for ${status}`);
    assert.match(result.reason, new RegExp(`Mission is ${status}`));
  }
});

test('evaluateMission returns TRIGGER_VERIFY for VERIFYING status', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-verifying-001',
    status: 'VERIFYING',
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'TRIGGER_VERIFY');
  assert.match(result.reason, /already in VERIFYING/);
});

test('evaluateMission returns ESCALATE_MAX_RETRY when failed tasks exhausted retries', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-max-retry-001',
    status: 'RUNNING',
    // all tasks terminal so it won't hit TRIGGER_VERIFY first — use a non-RUNNING status
  });
  // ITERATING with past nextWakeAt returns RESUME_TASK first, so test the tail logic differently:
  // Use a mission that has no matching status branch — we need to test the tail fallthrough
  const tailMission: Mission = {
    ...mission,
    // After all status branches, retryable check, then exhausted check
    // The tail is reached when status doesn't match any explicit branch
    // Actually looking at code flow: ITERATING goes to RESUME_TASK. Let's use status that's not in branches.
    // ESCALATED is not handled → falls to tail
    status: 'ESCALATED' as any,
    tasks: [
      { taskId: 'T1', title: 'Exhausted', type: 'code', status: 'FAILED', retryCount: 3, maxRetries: 3 },
    ],
  };

  const result = evaluateMission(tailMission, wdConfig(), nowMs);
  assert.equal(result.action, 'ESCALATE_MAX_RETRY');
  assert.match(result.reason, /exhausted retry budget/);
  assert.deepEqual(result.relatedTaskIds, ['T1']);
});

test('evaluateMission returns RESUME_TASK for ITERATING mission past nextWakeAt', () => {
  const nowMs = Date.parse('2026-03-28T02:00:00.000Z');
  const mission = baseMission({
    missionId: 'watchdog-iterating-resume-001',
    status: 'ITERATING',
    nextWakeAt: '2026-03-28T01:00:00.000Z', // in the past
    tasks: [
      { taskId: 'T1', title: 'Pending', type: 'code', status: 'PENDING' },
    ],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'RESUME_TASK');
  assert.match(result.reason, /resume the next iteration/);
});

test('evaluateMission returns NONE for ITERATING mission before nextWakeAt', () => {
  const nowMs = Date.parse('2026-03-28T01:00:00.000Z');
  const mission = baseMission({
    missionId: 'watchdog-iterating-wait-001',
    status: 'ITERATING',
    nextWakeAt: '2026-03-28T02:00:00.000Z', // in the future
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'NONE');
  assert.match(result.reason, /waiting for scheduled wake time/);
});
