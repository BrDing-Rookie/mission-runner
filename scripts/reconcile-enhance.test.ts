import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileBackgroundMission } from './mission-reconcile-background.ts';
import { readMissionFile, writeMissionFixture } from './test-helpers.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function thirtyMinutesAgo(): string {
  return new Date(Date.now() - 30 * 60 * 1000).toISOString();
}

function baseMission(missionsDir: string, missionId: string, overrides: Partial<Mission> = {}): void {
  const mission: Mission = {
    missionId,
    title: 'Test mission',
    goal: 'Test goal',
    status: 'WAITING_BACKGROUND',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastProgressAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    backgroundProcesses: [],
    ...overrides,
  };
  writeMissionFixture(missionsDir, mission);
}

// ---------------------------------------------------------------------------
// 1. Timeout detection: RUNNING process older than threshold → marked TIMEOUT
// ---------------------------------------------------------------------------

test('timed-out RUNNING process is auto-marked TIMEOUT and reconciled as FAILED', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-timeout-'));
  const missionId = 'timeout-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt: twoHoursAgo() },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 3_600_000, // 1 hour — process is 2 h old
  });

  assert.deepEqual(result.timedOutProcessIds, ['P1']);
  assert.deepEqual(result.failedTaskIds, ['T1']);
  assert.equal(result.changed, true);
  assert.equal(result.progressed, true);

  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.backgroundProcesses?.[0]?.status, 'TIMEOUT');
  assert.equal(saved.tasks?.[0]?.status, 'FAILED');
});

// ---------------------------------------------------------------------------
// 2. Non-timed-out RUNNING process is left alone
// ---------------------------------------------------------------------------

test('RUNNING process within timeout window is not affected', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-no-timeout-'));
  const missionId = 'no-timeout-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt: thirtyMinutesAgo() },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 3_600_000, // 1 hour — process is only 30 min old
  });

  assert.deepEqual(result.timedOutProcessIds, []);
  assert.deepEqual(result.reconciledTaskIds, []);
  assert.equal(result.changed, false);

  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.backgroundProcesses?.[0]?.status, 'RUNNING');
  assert.equal(saved.tasks?.[0]?.status, 'WAITING_BACKGROUND');
});

// ---------------------------------------------------------------------------
// 3. Orphan detection: process with no matching task → warning, no state change
// ---------------------------------------------------------------------------

test('orphan process is detected and reported but its status is not modified', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-orphan-'));
  const missionId = 'orphan-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Normal task', type: 'code', status: 'COMPLETED' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P_ORPHAN', taskId: 'T_NONEXISTENT', status: 'RUNNING', startedAt: thirtyMinutesAgo() },
  ];

  baseMission(missionsDir, missionId, {
    status: 'RUNNING',
    tasks,
    backgroundProcesses,
  });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 3_600_000,
  });

  assert.deepEqual(result.orphanProcessIds, ['P_ORPHAN']);
  // Orphan process status must NOT be changed
  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.backgroundProcesses?.[0]?.status, 'RUNNING');
});

// ---------------------------------------------------------------------------
// 4. Force mode: RUNNING processes beyond timeout window are forced to TIMEOUT
// ---------------------------------------------------------------------------

test('force mode marks all RUNNING processes as TIMEOUT regardless of age', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-force-'));
  const missionId = 'force-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    // Only 5 minutes old — normally far within the 1-hour timeout
    { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 3_600_000,
    force: true,
  });

  assert.deepEqual(result.timedOutProcessIds, ['P1']);
  assert.deepEqual(result.failedTaskIds, ['T1']);
  assert.equal(result.changed, true);

  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.backgroundProcesses?.[0]?.status, 'TIMEOUT');
  assert.equal(saved.tasks?.[0]?.status, 'FAILED');
});

// ---------------------------------------------------------------------------
// 5. Custom --process-timeout-ms is respected
// ---------------------------------------------------------------------------

test('custom processTimeoutMs shorter than default triggers timeout for recently started process', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-custom-timeout-'));
  const missionId = 'custom-timeout-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
  ];
  // 35 minutes old — would NOT trigger the default 1-hour timeout
  const startedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 30 * 60 * 1000, // 30-minute threshold → 35-min-old process should timeout
  });

  assert.deepEqual(result.timedOutProcessIds, ['P1']);
  assert.equal(result.changed, true);
});

// ---------------------------------------------------------------------------
// 6. Result includes new fields timedOutProcessIds and orphanProcessIds
// ---------------------------------------------------------------------------

test('result always contains timedOutProcessIds and orphanProcessIds arrays', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-result-fields-'));
  const missionId = 'result-fields-001';

  baseMission(missionsDir, missionId, {
    status: 'WAITING_BACKGROUND',
    tasks: [{ taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' }],
    backgroundProcesses: [
      { processId: 'P1', taskId: 'T1', status: 'COMPLETED', startedAt: thirtyMinutesAgo(), endedAt: new Date().toISOString() },
    ],
  });

  const result = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });

  assert.ok(Array.isArray(result.timedOutProcessIds), 'timedOutProcessIds should be an array');
  assert.ok(Array.isArray(result.orphanProcessIds), 'orphanProcessIds should be an array');
  assert.deepEqual(result.timedOutProcessIds, []);
  assert.deepEqual(result.orphanProcessIds, []);
});

// ---------------------------------------------------------------------------
// 7. dry-run mode: no writes, but result is still computed correctly
// ---------------------------------------------------------------------------

test('dry-run does not persist changes but reports them in result', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-dryrun-'));
  const missionId = 'dryrun-001';
  const originalUpdatedAt = '2026-01-01T00:00:00.000Z';

  baseMission(missionsDir, missionId, {
    updatedAt: originalUpdatedAt,
    tasks: [{ taskId: 'T1', title: 'Bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' }],
    backgroundProcesses: [
      { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt: twoHoursAgo() },
    ],
  });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: true,
    processTimeoutMs: 3_600_000,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.timedOutProcessIds, ['P1']);
  assert.equal(result.changed, true);

  // File should be unchanged
  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.updatedAt, originalUpdatedAt);
  assert.equal(saved.backgroundProcesses?.[0]?.status, 'RUNNING');
});

// ---------------------------------------------------------------------------
// 8. Regression: original behavior (COMPLETED/FAILED process reconciliation) is unchanged
// ---------------------------------------------------------------------------

test('regression: COMPLETED background process reconciles task to COMPLETED and mission to VERIFYING', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-regression-'));
  const missionId = 'regression-001';

  const initialUpdatedAt = '2026-03-19T00:00:00.000Z';

  baseMission(missionsDir, missionId, {
    updatedAt: initialUpdatedAt,
    lastProgressAt: initialUpdatedAt,
    tasks: [
      { taskId: 'T1', title: 'Wait for background work', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
    ],
    backgroundProcesses: [
      {
        processId: 'P1',
        taskId: 'T1',
        status: 'COMPLETED',
        startedAt: '2026-03-19T00:00:01.000Z',
        endedAt: '2026-03-19T00:00:02.000Z',
      },
    ],
  });

  const first = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });

  assert.equal(first.changed, true);
  assert.equal(first.progressed, true);
  assert.deepEqual(first.reconciledTaskIds, ['T1']);
  assert.deepEqual(first.completedTaskIds, ['T1']);
  assert.deepEqual(first.timedOutProcessIds, []);
  assert.deepEqual(first.orphanProcessIds, []);

  const afterFirst = readMissionFile(missionsDir, missionId);
  assert.equal(afterFirst.tasks?.[0]?.status, 'COMPLETED');
  assert.equal(afterFirst.status, 'VERIFYING');
  assert.notEqual(afterFirst.updatedAt, initialUpdatedAt);

  // Second run is a no-op
  const second = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(second.progressed, false);
  assert.deepEqual(second.reconciledTaskIds, []);
  assert.deepEqual(second.timedOutProcessIds, []);
});

test('regression: FAILED background process reconciles task to FAILED', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-regression-failed-'));
  const missionId = 'regression-failed-001';

  baseMission(missionsDir, missionId, {
    tasks: [
      { taskId: 'T1', title: 'Failing bg task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
    ],
    backgroundProcesses: [
      { processId: 'P1', taskId: 'T1', status: 'FAILED', startedAt: '2026-03-19T00:00:01.000Z', endedAt: '2026-03-19T00:00:05.000Z' },
    ],
  });

  const result = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });

  assert.deepEqual(result.failedTaskIds, ['T1']);
  assert.deepEqual(result.completedTaskIds, []);
  assert.equal(result.changed, true);

  const saved = readMissionFile(missionsDir, missionId);
  assert.equal(saved.tasks?.[0]?.status, 'FAILED');
});

// ---------------------------------------------------------------------------
// 9. Multiple processes: only the timed-out ones are marked
// ---------------------------------------------------------------------------

test('only timed-out RUNNING processes are marked TIMEOUT; others are untouched', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-multi-'));
  const missionId = 'multi-001';

  const tasks: Task[] = [
    { taskId: 'T1', title: 'Old task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P_OLD' },
    { taskId: 'T2', title: 'New task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P_NEW' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P_OLD', taskId: 'T1', status: 'RUNNING', startedAt: twoHoursAgo() },
    { processId: 'P_NEW', taskId: 'T2', status: 'RUNNING', startedAt: thirtyMinutesAgo() },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  const result = reconcileBackgroundMission({
    missionsDir,
    missionId,
    dryRun: false,
    processTimeoutMs: 3_600_000,
  });

  assert.deepEqual(result.timedOutProcessIds, ['P_OLD']);
  assert.deepEqual(result.failedTaskIds, ['T1']);

  const saved = readMissionFile(missionsDir, missionId);
  const p_old = saved.backgroundProcesses?.find((p) => p.processId === 'P_OLD');
  const p_new = saved.backgroundProcesses?.find((p) => p.processId === 'P_NEW');
  assert.equal(p_old?.status, 'TIMEOUT');
  assert.equal(p_new?.status, 'RUNNING'); // untouched

  assert.equal(saved.tasks?.find((t) => t.taskId === 'T1')?.status, 'FAILED');
  assert.equal(saved.tasks?.find((t) => t.taskId === 'T2')?.status, 'WAITING_BACKGROUND');
});

// ---------------------------------------------------------------------------
// 10. Default processTimeoutMs is 1 hour when not specified
// ---------------------------------------------------------------------------

test('default processTimeoutMs of 1 hour is applied when not specified', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'reconcile-enhance-default-timeout-'));
  const missionId = 'default-timeout-001';

  // 90 minutes old — should exceed 1-hour default
  const startedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const tasks: Task[] = [
    { taskId: 'T1', title: 'Old task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' },
  ];
  const backgroundProcesses: BackgroundProcess[] = [
    { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt },
  ];

  baseMission(missionsDir, missionId, { tasks, backgroundProcesses });

  // No processTimeoutMs → should default to 1 hour
  const result = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });

  assert.deepEqual(result.timedOutProcessIds, ['P1']);
  assert.equal(result.changed, true);
});
