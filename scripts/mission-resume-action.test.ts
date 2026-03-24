import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as runMissionActionMain } from './mission-run-action.ts';
import { readMissionFile, readEvents, writeMissionFixture } from './test-helpers.ts';

test('mission-run-action RESUME_TASK records action event and promotes ITERATING mission with unlocked work back to RUNNING', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-resume-action-'));
  const missionId = 'mission-resume-action-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Resume action test',
    goal: 'Ensure resume closes the verify -> iterate -> resume loop for next dispatch',
    status: 'ITERATING',
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
    lastProgressAt: '2026-03-23T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Completed prerequisite',
        type: 'analysis',
        status: 'COMPLETED',
      },
      {
        taskId: 'T2',
        title: 'Unlocked retry task',
        type: 'code',
        status: 'PENDING',
        dependsOn: ['T1'],
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = runMissionActionMain([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--action', 'RESUME_TASK',
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'RUNNING');
  assert.equal(updatedMission.tasks?.[1]?.status, 'READY');

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'mission_resumed');
  assert.equal(events[1]?.type, 'mission_action_executed');
  assert.equal(events[1]?.action, 'RESUME_TASK');
  assert.equal(events[1]?.success, true);
  assert.ok(events[1]?.changed);
  assert.match(String(events[1]?.summary ?? ''), /unlocked=T2/);
  assert.match(String(events[1]?.summary ?? ''), /status=RUNNING/);
});
