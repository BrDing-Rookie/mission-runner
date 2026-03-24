import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as dispatchMain } from './mission-dispatch.ts';
import { main as resumeMain } from './mission-resume.ts';
import { writeMissionFixture, readMissionFile, readEvents } from './test-helpers.ts';

test('mission-dispatch consumes all READY tasks in one pass', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-dispatch-'));
  const missionId = 'mission-dispatch-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Dispatch parallel ready tasks',
    goal: 'Verify multiple READY tasks are dispatched together',
    status: 'PLANNED',
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Run foreground analysis',
        type: 'analysis',
        status: 'READY',
      },
      {
        taskId: 'T2',
        title: 'Run background code task',
        type: 'code',
        status: 'READY',
      },
      {
        taskId: 'T3',
        title: 'Wait for upstream tasks',
        type: 'verification',
        status: 'PENDING',
        dependsOn: ['T1', 'T2'],
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = dispatchMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'WAITING_BACKGROUND');
  assert.equal(updatedMission.tasks?.[0]?.status, 'RUNNING');
  assert.equal(updatedMission.tasks?.[1]?.status, 'WAITING_BACKGROUND');
  assert.equal(updatedMission.tasks?.[2]?.status, 'PENDING');
  assert.equal(updatedMission.backgroundProcesses?.length, 1);
  assert.equal(updatedMission.backgroundProcesses?.[0]?.taskId, 'T2');

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'mission_dispatched');
  assert.deepEqual(events[0]?.startedTaskIds, ['T1', 'T2']);
  assert.deepEqual(events[0]?.runningTaskIds, ['T1']);
  assert.deepEqual(events[0]?.backgroundTaskIds, ['T2']);
  assert.equal(events[0]?.statusTo, 'WAITING_BACKGROUND');
});

test('mission-resume unlocks dependency-ready pending tasks without dropping background-wait semantics', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-resume-'));
  const missionId = 'mission-resume-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Resume unlocked pending tasks',
    goal: 'Verify completed dependencies unlock pending work on resume',
    status: 'WAITING_EXTERNAL',
    createdAt: '2026-03-20T01:00:00.000Z',
    updatedAt: '2026-03-20T01:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Completed prerequisite one',
        type: 'analysis',
        status: 'COMPLETED',
      },
      {
        taskId: 'T2',
        title: 'Completed prerequisite two',
        type: 'test',
        status: 'SKIPPED',
      },
      {
        taskId: 'T3',
        title: 'Newly unblocked task',
        type: 'review',
        status: 'PENDING',
        dependsOn: ['T1', 'T2'],
      },
      {
        taskId: 'T4',
        title: 'Still waiting on background work',
        type: 'code',
        status: 'WAITING_BACKGROUND',
        backgroundProcessId: 'P1',
      },
    ],
    backgroundProcesses: [
      {
        processId: 'P1',
        taskId: 'T4',
        status: 'RUNNING',
        startedAt: '2026-03-20T01:00:01.000Z',
      },
    ],
  });

  const exitCode = resumeMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.tasks?.[2]?.status, 'READY');
  assert.equal(updatedMission.tasks?.[3]?.status, 'WAITING_BACKGROUND');
  assert.equal(updatedMission.status, 'WAITING_BACKGROUND');

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'mission_resumed');
  assert.deepEqual(events[0]?.resumedTaskIds, []);
  assert.deepEqual(events[0]?.unlockedTaskIds, ['T3']);
  assert.equal(events[0]?.statusTo, 'WAITING_BACKGROUND');
});
