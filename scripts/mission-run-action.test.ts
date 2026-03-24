import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as runMissionActionMain } from './mission-run-action.ts';
import type { Mission } from './lib/types.ts';

function runTriggerVerify(
  missionsDir: string,
  missionId: string
): { exitCode: number; output: Record<string, unknown> } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  let exitCode: number;
  try {
    exitCode = runMissionActionMain([
      '--missions-dir', missionsDir,
      '--mission-id', missionId,
      '--action', 'TRIGGER_VERIFY',
    ]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 1);
  return { exitCode, output: JSON.parse(logs[0] ?? '{}') as Record<string, unknown> };
}

function writeMissionFixture(missionsDir: string, mission: Mission): void {
  const missionDir = join(missionsDir, mission.missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(mission, null, 2), { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(join(missionDir, 'events.jsonl'), '', { encoding: 'utf-8', flag: 'wx' });
}

function readMissionFile(missionsDir: string, missionId: string): Mission {
  return JSON.parse(readFileSync(join(missionsDir, missionId, 'mission.json'), 'utf-8')) as Mission;
}

function readEvents(missionsDir: string, missionId: string): Array<Record<string, unknown>> {
  const eventsPath = join(missionsDir, missionId, 'events.jsonl');
  const content = readFileSync(eventsPath, 'utf-8').trim();
  if (!content) {
    return [];
  }

  return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runMissionAction(
  missionsDir: string,
  missionId: string
): { exitCode: number; output: Record<string, unknown> } {
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };

  try {
    const exitCode = runMissionActionMain([
      '--missions-dir',
      missionsDir,
      '--mission-id',
      missionId,
      '--action',
      'CHECK_BACKGROUND',
    ]);

    assert.equal(logs.length, 1);
    return {
      exitCode,
      output: JSON.parse(logs[0] ?? '{}') as Record<string, unknown>,
    };
  } finally {
    console.log = originalLog;
  }
}

test('mission-run-action records a real CHECK_BACKGROUND progression once, then stays quiet on no-op', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-run-action-'));
  const missionId = 'mission-action-test-001';
  const initialUpdatedAt = '2026-03-19T00:00:00.000Z';
  const initialLastProgressAt = '2026-03-19T00:00:00.000Z';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Action wrapper reconcile test',
    goal: 'Verify CHECK_BACKGROUND only emits action execution on real progress',
    status: 'WAITING_BACKGROUND',
    createdAt: initialUpdatedAt,
    updatedAt: initialUpdatedAt,
    lastProgressAt: initialLastProgressAt,
    tasks: [
      {
        taskId: 'T1',
        title: 'Wait for background work',
        type: 'code',
        status: 'WAITING_BACKGROUND',
        backgroundProcessId: 'P1',
      },
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

  const first = runMissionAction(missionsDir, missionId);
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.action, 'CHECK_BACKGROUND');
  assert.equal(first.output.statusFrom, 'WAITING_BACKGROUND');
  assert.equal(first.output.finalStatus, 'VERIFYING');
  assert.equal(first.output.changed, true);
  assert.equal(first.output.progressed, true);
  assert.deepEqual(first.output.reconciledTaskIds, ['T1']);
  assert.deepEqual(first.output.completedTaskIds, ['T1']);
  assert.deepEqual(first.output.failedTaskIds, []);

  const afterFirst = readMissionFile(missionsDir, missionId);
  assert.equal(afterFirst.status, 'VERIFYING');
  assert.equal(afterFirst.tasks?.[0]?.status, 'COMPLETED');
  assert.notEqual(afterFirst.updatedAt, initialUpdatedAt);
  assert.notEqual(afterFirst.lastProgressAt, initialLastProgressAt);

  const firstEvents = readEvents(missionsDir, missionId);
  assert.equal(firstEvents.length, 2);
  assert.equal(firstEvents[0]?.type, 'mission_background_reconciled');
  assert.equal(firstEvents[1]?.type, 'mission_action_executed');
  assert.equal(firstEvents[1]?.action, 'CHECK_BACKGROUND');
  assert.equal(firstEvents[1]?.changed, true);
  assert.equal(firstEvents[1]?.progressed, true);

  const second = runMissionAction(missionsDir, missionId);
  assert.equal(second.exitCode, 0);
  assert.equal(second.output.action, 'CHECK_BACKGROUND');
  assert.equal(second.output.statusFrom, 'VERIFYING');
  assert.equal(second.output.finalStatus, 'VERIFYING');
  assert.equal(second.output.changed, false);
  assert.equal(second.output.progressed, false);
  assert.deepEqual(second.output.reconciledTaskIds, []);
  assert.deepEqual(second.output.completedTaskIds, []);
  assert.deepEqual(second.output.failedTaskIds, []);

  const afterSecond = readMissionFile(missionsDir, missionId);
  assert.equal(afterSecond.updatedAt, afterFirst.updatedAt);
  assert.equal(afterSecond.lastProgressAt, afterFirst.lastProgressAt);

  const secondEvents = readEvents(missionsDir, missionId);
  assert.equal(secondEvents.length, 2);
  assert.equal(secondEvents[1]?.type, 'mission_action_executed');
  assert.equal(secondEvents.filter((event) => event.type === 'mission_action_executed').length, 1);
});

test('mission-run-action reconciles TIMEOUT background work into a failed task progression', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-run-action-timeout-'));
  const missionId = 'mission-action-timeout-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Action wrapper timeout test',
    goal: 'Verify CHECK_BACKGROUND handles timeout outcomes',
    status: 'WAITING_BACKGROUND',
    createdAt: '2026-03-19T01:00:00.000Z',
    updatedAt: '2026-03-19T01:00:00.000Z',
    lastProgressAt: '2026-03-19T01:00:00.000Z',
    tasks: [
      {
        taskId: 'T-timeout',
        title: 'Wait for timed out background work',
        type: 'code',
        status: 'WAITING_BACKGROUND',
        backgroundProcessId: 'P-timeout',
      },
    ],
    backgroundProcesses: [
      {
        processId: 'P-timeout',
        taskId: 'T-timeout',
        status: 'TIMEOUT',
        startedAt: '2026-03-19T01:00:01.000Z',
        endedAt: '2026-03-19T01:00:30.000Z',
      },
    ],
  });

  const result = runMissionAction(missionsDir, missionId);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.changed, true);
  assert.equal(result.output.progressed, true);
  assert.deepEqual(result.output.completedTaskIds, []);
  assert.deepEqual(result.output.failedTaskIds, ['T-timeout']);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'VERIFYING');
  assert.equal(updatedMission.tasks?.[0]?.status, 'FAILED');
  assert.match(updatedMission.tasks?.[0]?.resultSummary ?? '', /timed out/i);

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'mission_background_reconciled');
  assert.deepEqual(events[0]?.failedTaskIds, ['T-timeout']);
  assert.equal(events[1]?.type, 'mission_action_executed');
  assert.equal(events[1]?.changed, true);
  assert.equal(events[1]?.progressed, true);
});

test('mission-run-action TRIGGER_VERIFY: all tasks completed with plan → PASS → mission COMPLETED', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-run-action-verify-'));
  const missionId = 'mission-verify-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Verify trigger test',
    goal: 'Verify that TRIGGER_VERIFY produces PASS when all tasks are done and plan exists',
    status: 'VERIFYING',
    createdAt: '2026-03-21T00:00:00.000Z',
    updatedAt: '2026-03-21T00:00:00.000Z',
    lastProgressAt: '2026-03-21T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Completed task',
        type: 'code',
        status: 'COMPLETED',
      },
    ],
    completionCriteria: [],
  });

  // runVerify checks for plan.md existence via loadTextIfExists
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n\nsome plan content\n');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  let exitCode: number;
  try {
    exitCode = runMissionActionMain([
      '--missions-dir', missionsDir,
      '--mission-id', missionId,
      '--action', 'TRIGGER_VERIFY',
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(exitCode!, 0);
  assert.equal(logs.length, 1);
  const output = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;

  assert.equal(output.action, 'TRIGGER_VERIFY');
  assert.equal(output.verificationStatus, 'PASS');
  assert.equal(output.missionStatus, 'COMPLETED');
  assert.equal(output.success, true);
  assert.equal(output.changed, true);
  assert.deepEqual(output.gaps, []);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'COMPLETED');

  const events = readEvents(missionsDir, missionId);
  // persistMissionUpdate writes mission_verified, then mission-run-action appends mission_action_executed
  assert.ok(events.length >= 2, `expected ≥2 events, got ${events.length}`);
  const verifiedEvent = events.find((e) => e.type === 'mission_verified');
  assert.ok(verifiedEvent, 'mission_verified event should be present');
  assert.equal(verifiedEvent?.verificationStatus, 'PASS');
  const actionEvent = events.find((e) => e.type === 'mission_action_executed');
  assert.ok(actionEvent, 'mission_action_executed event should be present');
  assert.equal(actionEvent?.action, 'TRIGGER_VERIFY');
  assert.equal(actionEvent?.verificationStatus, 'PASS');
  assert.equal(actionEvent?.changed, true);
});

test('TRIGGER_VERIFY: failed task, no iteration cap → RETRYABLE_GAP → mission ITERATING, iteration incremented', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-verify-retryable-'));
  const missionId = 'mission-verify-retryable-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Retryable gap test',
    goal: 'Verify TRIGGER_VERIFY produces RETRYABLE_GAP when failed task exists and iteration limit not reached',
    status: 'VERIFYING',
    createdAt: '2026-03-21T00:00:00.000Z',
    updatedAt: '2026-03-21T00:00:00.000Z',
    lastProgressAt: '2026-03-21T00:00:00.000Z',
    currentIteration: 1,
    // maxIterations not set → defaults to MAX_SAFE_INTEGER, never reached
    tasks: [
      {
        taskId: 'T-ok',
        title: 'Completed task',
        type: 'code',
        status: 'COMPLETED',
      },
      {
        taskId: 'T-fail',
        title: 'Failed task',
        type: 'code',
        status: 'FAILED',
        resultSummary: 'Build error',
      },
    ],
    completionCriteria: [],
  });
  // Provide plan.md so "Missing plan.md" is not a gap, isolating the failed-task gap
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\nsome plan\n');

  const result = runTriggerVerify(missionsDir, missionId);

  // ── output contract ──
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.action, 'TRIGGER_VERIFY');
  assert.equal(result.output.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(result.output.missionStatus, 'ITERATING');
  assert.equal(result.output.success, true);
  assert.equal(result.output.changed, true);

  const gaps = result.output.gaps as string[];
  assert.ok(gaps.length > 0, 'gaps must be non-empty for RETRYABLE_GAP');
  assert.ok(gaps.some((g) => /T-fail/i.test(g)), `gaps should mention T-fail; got: ${JSON.stringify(gaps)}`);

  // ── mission.json state ──
  const updated = readMissionFile(missionsDir, missionId);
  assert.equal(updated.status, 'ITERATING');
  assert.equal(updated.verification?.status, 'RETRYABLE_GAP');
  // currentIteration must be incremented by 1 (was 1, now 2)
  assert.equal(updated.currentIteration, 2, 'currentIteration should be incremented on RETRYABLE_GAP');

  // ── events ──
  const events = readEvents(missionsDir, missionId);
  assert.ok(events.length >= 2, `expected ≥2 events, got ${events.length}`);

  const verifiedEvent = events.find((e) => e.type === 'mission_verified');
  assert.ok(verifiedEvent, 'mission_verified event must be present');
  assert.equal(verifiedEvent?.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(verifiedEvent?.missionStatus, 'ITERATING');

  const actionEvent = events.find((e) => e.type === 'mission_action_executed');
  assert.ok(actionEvent, 'mission_action_executed event must be present');
  assert.equal(actionEvent?.action, 'TRIGGER_VERIFY');
  assert.equal(actionEvent?.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(actionEvent?.changed, true);
});

test('TRIGGER_VERIFY: iteration limit reached → NONRETRYABLE_FAILURE → mission FAILED, no further iteration', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-verify-nonretryable-'));
  const missionId = 'mission-verify-nonretryable-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Non-retryable failure test',
    goal: 'Verify TRIGGER_VERIFY produces NONRETRYABLE_FAILURE when iteration limit is reached',
    status: 'VERIFYING',
    createdAt: '2026-03-21T00:00:00.000Z',
    updatedAt: '2026-03-21T00:00:00.000Z',
    lastProgressAt: '2026-03-21T00:00:00.000Z',
    currentIteration: 3,
    maxIterations: 3, // currentIteration >= maxIterations → limit reached
    tasks: [
      {
        taskId: 'T-ok',
        title: 'Completed task',
        type: 'code',
        status: 'COMPLETED',
      },
      {
        taskId: 'T-fail',
        title: 'Persistently failed task',
        type: 'code',
        status: 'FAILED',
        resultSummary: 'Repeated failure',
      },
    ],
    completionCriteria: [],
  });
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\nsome plan\n');

  const result = runTriggerVerify(missionsDir, missionId);

  // ── output contract ──
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.action, 'TRIGGER_VERIFY');
  assert.equal(result.output.verificationStatus, 'NONRETRYABLE_FAILURE');
  assert.equal(result.output.missionStatus, 'FAILED');
  assert.equal(result.output.success, true);
  assert.equal(result.output.changed, true);

  const gaps = result.output.gaps as string[];
  assert.ok(gaps.length > 0, 'gaps must be non-empty for NONRETRYABLE_FAILURE');
  assert.ok(gaps.some((g) => /max iterations/i.test(g)), `gaps should mention max iterations; got: ${JSON.stringify(gaps)}`);
  assert.ok(gaps.some((g) => /T-fail/i.test(g)), `gaps should mention the failed task; got: ${JSON.stringify(gaps)}`);

  // ── mission.json state ──
  const updated = readMissionFile(missionsDir, missionId);
  assert.equal(updated.status, 'FAILED');
  assert.equal(updated.verification?.status, 'NONRETRYABLE_FAILURE');
  // currentIteration must NOT be incremented on NONRETRYABLE_FAILURE
  assert.equal(updated.currentIteration, 3, 'currentIteration must not change on NONRETRYABLE_FAILURE');

  // ── events ──
  const events = readEvents(missionsDir, missionId);
  assert.ok(events.length >= 2, `expected ≥2 events, got ${events.length}`);

  const verifiedEvent = events.find((e) => e.type === 'mission_verified');
  assert.ok(verifiedEvent, 'mission_verified event must be present');
  assert.equal(verifiedEvent?.verificationStatus, 'NONRETRYABLE_FAILURE');
  assert.equal(verifiedEvent?.missionStatus, 'FAILED');

  const actionEvent = events.find((e) => e.type === 'mission_action_executed');
  assert.ok(actionEvent, 'mission_action_executed event must be present');
  assert.equal(actionEvent?.action, 'TRIGGER_VERIFY');
  assert.equal(actionEvent?.verificationStatus, 'NONRETRYABLE_FAILURE');
  assert.equal(actionEvent?.changed, true);
});

test('NOTIFY_COMPLETE writes delivery metadata via discord adapter without breaking notify flag flow', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-notify-discord-'));
  const missionId = 'mission-notify-discord-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Discord notify complete test',
    goal: 'Verify discord adapter metadata is persisted',
    status: 'COMPLETED',
    createdAt: '2026-03-24T00:00:00.000Z',
    updatedAt: '2026-03-24T00:00:00.000Z',
    lastProgressAt: '2026-03-24T00:00:00.000Z',
    tasks: [],
  });

  const logs: string[] = [];
  const originalLog = console.log;
  const originalAdapter = process.env.MISSION_NOTIFICATION_ADAPTER;
  const originalChannel = process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL;
  process.env.MISSION_NOTIFICATION_ADAPTER = 'discord';
  process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL = 'discord-channel-123';
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

  try {
    const exitCode = runMissionActionMain([
      '--missions-dir', missionsDir,
      '--mission-id', missionId,
      '--action', 'NOTIFY_COMPLETE',
    ]);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    if (originalAdapter === undefined) delete process.env.MISSION_NOTIFICATION_ADAPTER; else process.env.MISSION_NOTIFICATION_ADAPTER = originalAdapter;
    if (originalChannel === undefined) delete process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL; else process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL = originalChannel;
  }

  assert.equal(logs.length, 1);
  const output = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
  assert.equal(output.flag, 'notifiedComplete');
  assert.equal((output.delivery as Record<string, unknown>).adapter, 'discord');
  assert.equal((output.delivery as Record<string, unknown>).target, 'discord-channel-123');

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.flags?.notifiedComplete, true);
  const delivery = ((updatedMission.metadata ?? {}).notificationDelivery as Record<string, unknown>);
  assert.equal(((delivery.complete as Record<string, unknown>).adapter), 'discord');
  assert.equal(((delivery.complete as Record<string, unknown>).target), 'discord-channel-123');

  const events = readEvents(missionsDir, missionId);
  assert.ok(events.some((event) => event.type === 'mission_notified_complete'));
  const notifyEvent = events.find((event) => event.type === 'mission_notified_complete');
  assert.equal(((notifyEvent?.delivery as Record<string, unknown>).adapter), 'discord');
});
