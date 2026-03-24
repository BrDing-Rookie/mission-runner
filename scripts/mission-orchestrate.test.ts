import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as orchestrateMain } from './mission-orchestrate.ts';
import { readEvents, readMissionFile, writeMissionFixture } from './test-helpers.ts';

test('mission-orchestrate executes CHECK_BACKGROUND and then verification path', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-orchestrate-bg-'));
  const missionId = 'mission-orchestrate-bg-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Background reconcile mission',
    goal: 'Drive finished background work into verification',
    status: 'WAITING_BACKGROUND',
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
    lastProgressAt: '2026-03-23T00:00:00.000Z',
    tasks: [{ taskId: 'T1', title: 'Background task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P1' }],
    backgroundProcesses: [{ processId: 'P1', taskId: 'T1', status: 'COMPLETED', startedAt: '2026-03-23T00:00:01.000Z', endedAt: '2026-03-23T00:00:02.000Z' }],
    completionCriteria: [],
  });
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const exitCode = orchestrateMain(['--missions-dir', missionsDir, '--mission-id', missionId]);
  assert.equal(exitCode, 0);

  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.status, 'COMPLETED');

  const events = readEvents(missionsDir, missionId);
  assert.ok(events.some((event) => event.type === 'mission_background_reconciled'));
  assert.ok(events.some((event) => event.type === 'mission_action_executed' && event.action === 'CHECK_BACKGROUND'));
  assert.ok(events.some((event) => event.type === 'mission_action_executed' && event.action === 'TRIGGER_VERIFY'));
  assert.ok(events.some((event) => event.type === 'mission_orchestrated'));
});

test('mission-orchestrate executes RESUME_TASK and auto-dispatches unlocked READY work', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-orchestrate-resume-'));
  const missionId = 'mission-orchestrate-resume-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Resume mission',
    goal: 'Continue iterating without manual commands',
    status: 'ITERATING',
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
    lastProgressAt: '2026-03-23T00:00:00.000Z',
    nextWakeAt: '2026-03-23T00:00:00.000Z',
    tasks: [
      { taskId: 'T1', title: 'Done prerequisite', type: 'analysis', status: 'COMPLETED' },
      { taskId: 'T2', title: 'Unlocked code task', type: 'code', status: 'PENDING', dependsOn: ['T1'] },
    ],
    backgroundProcesses: [],
    completionCriteria: [],
  });

  const exitCode = orchestrateMain(['--missions-dir', missionsDir, '--mission-id', missionId]);
  assert.equal(exitCode, 0);

  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.status, 'WAITING_BACKGROUND');
  assert.equal(mission.tasks?.[1]?.status, 'WAITING_BACKGROUND');

  const events = readEvents(missionsDir, missionId);
  assert.ok(events.some((event) => event.type === 'mission_resumed'));
  assert.ok(events.some((event) => event.type === 'mission_dispatched'));
  assert.ok(events.some((event) => event.type === 'mission_orchestrated'));
});
