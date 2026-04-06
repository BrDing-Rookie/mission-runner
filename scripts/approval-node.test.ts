import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  needsApproval,
  getTasksPendingApproval,
  hasPendingApprovals,
  processApproval,
} from './lib/mission-approval.ts';
import { TaskSchema } from './lib/schemas.ts';
import { updateTask } from './task-update.ts';
import { writeMissionFixture, readMissionFile } from './test-helpers.ts';
import type { Mission, Task } from './lib/types.ts';

// ==================== Helpers ====================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'T1',
    title: 'Test task',
    type: 'code',
    status: 'READY',
    ...overrides,
  };
}

function makeMission(tasks: Task[] = []): Mission {
  return {
    missionId: 'M1',
    title: 'Test Mission',
    goal: 'Test goal',
    status: 'RUNNING',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    tasks,
  };
}

function createApprovalFixture(): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-approval-test-'));
  const missionId = 'approval-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Approval test',
    goal: 'Verify approval flow',
    status: 'RUNNING',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Needs approval task',
        type: 'code',
        status: 'READY',
        requiresApproval: true,
      },
      {
        taskId: 'T2',
        title: 'Normal task',
        type: 'code',
        status: 'RUNNING',
      },
    ],
  });

  return { missionsDir, missionId };
}

// ==================== needsApproval tests ====================

test('needsApproval: returns true when requiresApproval=true and no approvalStatus', () => {
  const task = makeTask({ requiresApproval: true });
  assert.equal(needsApproval(task), true);
});

test('needsApproval: returns true when requiresApproval=true and PENDING_APPROVAL', () => {
  const task = makeTask({ requiresApproval: true, approvalStatus: 'PENDING_APPROVAL' });
  assert.equal(needsApproval(task), true);
});

test('needsApproval: returns false when requiresApproval=true and APPROVED', () => {
  const task = makeTask({ requiresApproval: true, approvalStatus: 'APPROVED' });
  assert.equal(needsApproval(task), false);
});

test('needsApproval: returns false when requiresApproval is not set', () => {
  const task = makeTask();
  assert.equal(needsApproval(task), false);
});

test('needsApproval: returns false when requiresApproval=false', () => {
  const task = makeTask({ requiresApproval: false });
  assert.equal(needsApproval(task), false);
});

// ==================== getTasksPendingApproval tests ====================

test('getTasksPendingApproval: returns READY tasks with requiresApproval and no/pending approvalStatus', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
    makeTask({ taskId: 'T2', requiresApproval: true, status: 'READY', approvalStatus: 'PENDING_APPROVAL' }),
    makeTask({ taskId: 'T3', requiresApproval: true, status: 'READY', approvalStatus: 'APPROVED' }),
    makeTask({ taskId: 'T4', requiresApproval: true, status: 'RUNNING' }),
    makeTask({ taskId: 'T5', status: 'READY' }),
  ]);

  const pending = getTasksPendingApproval(mission);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((t) => t.taskId), ['T1', 'T2']);
});

test('getTasksPendingApproval: returns empty array when no tasks', () => {
  const mission = makeMission([]);
  assert.deepEqual(getTasksPendingApproval(mission), []);
});

test('getTasksPendingApproval: returns empty when mission has no tasks field', () => {
  const mission = makeMission();
  assert.deepEqual(getTasksPendingApproval(mission), []);
});

// ==================== hasPendingApprovals tests ====================

test('hasPendingApprovals: true when there are pending tasks', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);
  assert.equal(hasPendingApprovals(mission), true);
});

test('hasPendingApprovals: false when no pending approval tasks', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY', approvalStatus: 'APPROVED' }),
    makeTask({ taskId: 'T2', status: 'READY' }),
  ]);
  assert.equal(hasPendingApprovals(mission), false);
});

test('hasPendingApprovals: false for empty mission', () => {
  const mission = makeMission([]);
  assert.equal(hasPendingApprovals(mission), false);
});

// ==================== processApproval tests ====================

test('processApproval: approve success sets approvalStatus=APPROVED', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);

  const result = processApproval(mission, 'T1', true, 'Looks good');
  assert.equal(result.changed, true);
  assert.equal(result.error, undefined);

  const task = result.mission.tasks?.[0];
  assert.equal(task?.approvalStatus, 'APPROVED');
  assert.equal(task?.approvalNote, 'Looks good');
  assert.equal(task?.status, 'READY'); // status unchanged on approve
});

test('processApproval: approve without note sets approvalNote=null', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);

  const result = processApproval(mission, 'T1', true);
  assert.equal(result.changed, true);
  const task = result.mission.tasks?.[0];
  assert.equal(task?.approvalNote, null);
});

test('processApproval: reject sets approvalStatus=REJECTED and status=SKIPPED', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);

  const result = processApproval(mission, 'T1', false, 'Not ready yet');
  assert.equal(result.changed, true);
  assert.equal(result.error, undefined);

  const task = result.mission.tasks?.[0];
  assert.equal(task?.approvalStatus, 'REJECTED');
  assert.equal(task?.approvalNote, 'Not ready yet');
  assert.equal(task?.status, 'SKIPPED');
});

test('processApproval: returns error when task not found', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);

  const result = processApproval(mission, 'nonexistent', true);
  assert.equal(result.changed, false);
  assert.match(result.error ?? '', /Task not found/);
});

test('processApproval: returns error when task does not require approval', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', status: 'READY' }), // no requiresApproval
  ]);

  const result = processApproval(mission, 'T1', true);
  assert.equal(result.changed, false);
  assert.match(result.error ?? '', /does not require approval/);
});

test('processApproval: returns error when task already APPROVED', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY', approvalStatus: 'APPROVED' }),
  ]);

  const result = processApproval(mission, 'T1', true);
  assert.equal(result.changed, false);
  assert.match(result.error ?? '', /already APPROVED/);
});

test('processApproval: returns error when task already REJECTED', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'SKIPPED', approvalStatus: 'REJECTED' }),
  ]);

  const result = processApproval(mission, 'T1', false);
  assert.equal(result.changed, false);
  assert.match(result.error ?? '', /already REJECTED/);
});

test('processApproval: updatedAt is updated on change', () => {
  const mission = makeMission([
    makeTask({ taskId: 'T1', requiresApproval: true, status: 'READY' }),
  ]);
  const before = mission.updatedAt;

  const result = processApproval(mission, 'T1', true);
  assert.notEqual(result.mission.updatedAt, before);
});

// ==================== TaskSchema: approval fields ====================

test('TaskSchema: accepts task with requiresApproval fields', () => {
  const data = {
    taskId: 'T1',
    title: 'My task',
    type: 'code',
    status: 'READY',
    requiresApproval: true,
    approvalStatus: 'PENDING_APPROVAL',
    approvalNote: 'Please review',
  };

  const result = TaskSchema.safeParse(data);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.requiresApproval, true);
    assert.equal(result.data.approvalStatus, 'PENDING_APPROVAL');
    assert.equal(result.data.approvalNote, 'Please review');
  }
});

test('TaskSchema: accepts task without approval fields (optional)', () => {
  const data = {
    taskId: 'T1',
    title: 'My task',
    type: 'code',
    status: 'READY',
  };

  const result = TaskSchema.safeParse(data);
  assert.equal(result.success, true);
});

test('TaskSchema: rejects invalid approvalStatus value', () => {
  const data = {
    taskId: 'T1',
    title: 'My task',
    type: 'code',
    status: 'READY',
    approvalStatus: 'MAYBE',
  };

  const result = TaskSchema.safeParse(data);
  assert.equal(result.success, false);
});

test('TaskSchema: accepts null approvalNote', () => {
  const data = {
    taskId: 'T1',
    title: 'My task',
    type: 'code',
    status: 'READY',
    requiresApproval: true,
    approvalStatus: 'APPROVED',
    approvalNote: null,
  };

  const result = TaskSchema.safeParse(data);
  assert.equal(result.success, true);
});

// ==================== task-update: --approve / --reject flow ====================

test('task-update --approve sets approvalStatus=APPROVED in mission.json', () => {
  const { missionsDir, missionId } = createApprovalFixture();

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED', // ignored for approval path
    summary: '',
    artifacts: [],
    dryRun: false,
    approve: true,
    approvalNote: 'LGTM',
  });

  assert.equal(result.changed, true);

  const mission = readMissionFile(missionsDir, missionId);
  const task = mission.tasks?.find((t) => t.taskId === 'T1');
  assert.equal(task?.approvalStatus, 'APPROVED');
  assert.equal(task?.approvalNote, 'LGTM');
  assert.equal(task?.status, 'READY'); // status unchanged on approve
});

test('task-update --reject sets approvalStatus=REJECTED and status=SKIPPED', () => {
  const { missionsDir, missionId } = createApprovalFixture();

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED', // ignored for approval path
    summary: '',
    artifacts: [],
    dryRun: false,
    reject: true,
    approvalNote: 'Blocked',
  });

  assert.equal(result.changed, true);
  assert.equal(result.taskStatusTo, 'SKIPPED');

  const mission = readMissionFile(missionsDir, missionId);
  const task = mission.tasks?.find((t) => t.taskId === 'T1');
  assert.equal(task?.approvalStatus, 'REJECTED');
  assert.equal(task?.approvalNote, 'Blocked');
  assert.equal(task?.status, 'SKIPPED');
});

test('task-update --approve dry-run does not persist changes', () => {
  const { missionsDir, missionId } = createApprovalFixture();

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED',
    summary: '',
    artifacts: [],
    dryRun: true,
    approve: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);

  // File should be unchanged
  const mission = readMissionFile(missionsDir, missionId);
  const task = mission.tasks?.find((t) => t.taskId === 'T1');
  assert.equal(task?.approvalStatus, undefined);
});
