import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileBackgroundMission } from './mission-reconcile-background.ts';
import type { Mission } from './lib/types.ts';

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

test('reconcile background is effectively idempotent for already-terminal tasks', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-reconcile-background-'));
  const missionId = 'mission-test-001';
  const missionDir = join(missionsDir, missionId);
  const initialUpdatedAt = '2026-03-19T00:00:00.000Z';
  const initialLastProgressAt = '2026-03-19T00:00:00.000Z';

  mkdirSync(missionDir, { recursive: true });

  const mission: Mission = {
    missionId,
    title: 'Reconcile background mission',
    goal: 'Ensure repeated background reconciliation is a no-op after convergence',
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
  };

  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(mission, null, 2), { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(join(missionDir, 'events.jsonl'), '', { encoding: 'utf-8', flag: 'wx' });

  const first = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });
  assert.equal(first.changed, true);
  assert.equal(first.progressed, true);
  assert.deepEqual(first.reconciledTaskIds, ['T1']);
  assert.deepEqual(first.completedTaskIds, ['T1']);

  const afterFirst = readMissionFile(missionsDir, missionId);
  assert.equal(afterFirst.tasks?.[0]?.status, 'COMPLETED');
  assert.notEqual(afterFirst.updatedAt, initialUpdatedAt);
  assert.notEqual(afterFirst.lastProgressAt, initialLastProgressAt);

  const firstEvents = readEvents(missionsDir, missionId);
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0]?.type, 'mission_background_reconciled');
  assert.deepEqual(firstEvents[0]?.reconciledTaskIds, ['T1']);

  const second = reconcileBackgroundMission({ missionsDir, missionId, dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(second.progressed, false);
  assert.deepEqual(second.reconciledTaskIds, []);
  assert.deepEqual(second.completedTaskIds, []);
  assert.deepEqual(second.failedTaskIds, []);

  const afterSecond = readMissionFile(missionsDir, missionId);
  assert.equal(afterSecond.updatedAt, afterFirst.updatedAt);
  assert.equal(afterSecond.lastProgressAt, afterFirst.lastProgressAt);

  const secondEvents = readEvents(missionsDir, missionId);
  assert.equal(secondEvents.length, 1);
  assert.equal(secondEvents[0]?.type, 'mission_background_reconciled');
});
