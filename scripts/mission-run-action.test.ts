import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as runMissionActionMain } from './mission-run-action.ts';
import type { Mission } from './lib/types.ts';

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
