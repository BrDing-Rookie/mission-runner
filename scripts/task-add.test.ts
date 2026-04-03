import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask } from './task-add.ts';
import { writeMissionFixture, readMissionFile, readEvents } from './test-helpers.ts';
import type { Mission } from './lib/types.ts';

function makeMissionsDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `task-add-${prefix}-`));
}

function baseMission(overrides: Partial<Mission> & Pick<Mission, 'missionId' | 'status'>): Mission {
  return {
    title: 'Test Mission',
    goal: 'Test task-add behaviour',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastProgressAt: '2026-04-03T00:00:00.000Z',
    tasks: [],
    backgroundProcesses: [],
    artifacts: [],
    ...overrides,
  } as Mission;
}

// TC1: VERIFYING 状态下 task-add 应成功（不抛错）
test('TC1: task-add succeeds when mission is in VERIFYING status', () => {
  const missionsDir = makeMissionsDir('tc1');
  const missionId = 'mission-tc1';

  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'VERIFYING' }));

  assert.doesNotThrow(() => {
    addTask({
      missionsDir,
      missionId,
      taskId: 'T-new',
      title: 'New task added during verify',
      type: 'analysis',
      dependsOn: [],
      agent: null,
      agentMentionTag: null,
      agentName: null,
      dryRun: false,
    });
  });
});

// TC2: task-add 后 mission 应自动回退到 RUNNING
test('TC2: task-add auto-reverts mission status from VERIFYING to RUNNING', () => {
  const missionsDir = makeMissionsDir('tc2');
  const missionId = 'mission-tc2';

  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'VERIFYING' }));

  const result = addTask({
    missionsDir,
    missionId,
    taskId: 'T-revert',
    title: 'Task that triggers revert',
    type: 'analysis',
    dependsOn: [],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  });

  // result.missionStatus should reflect the new status
  assert.equal(result.missionStatus, 'RUNNING');

  // Persisted mission.json must also reflect RUNNING
  const persisted = readMissionFile(missionsDir, missionId);
  assert.equal(persisted.status, 'RUNNING');
});

// TC3: 新增 task 应有正确的 status (READY 或 PENDING)
test('TC3: newly added task has correct initial status', () => {
  const missionsDir = makeMissionsDir('tc3');
  const missionId = 'mission-tc3';

  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'VERIFYING' }));

  // No dependencies → READY
  const resultReady = addTask({
    missionsDir,
    missionId,
    taskId: 'T-ready',
    title: 'Task with no deps',
    type: 'analysis',
    dependsOn: [],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  });
  assert.equal(resultReady.status, 'READY');

  // With an unfinished dependency → PENDING
  const missionsDir2 = makeMissionsDir('tc3b');
  const missionId2 = 'mission-tc3b';
  writeMissionFixture(missionsDir2, baseMission({
    missionId: missionId2,
    status: 'VERIFYING',
    tasks: [{
      taskId: 'T-existing',
      title: 'Pre-existing task',
      type: 'analysis',
      status: 'RUNNING',
      dependsOn: [],
      createdAt: '2026-04-03T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      resultSummary: null,
      artifacts: [],
      retryCount: 0,
      maxRetries: 2,
      lastError: null,
      backgroundProcessId: null,
      config: {},
      agent: null,
    }],
  }));

  const resultPending = addTask({
    missionsDir: missionsDir2,
    missionId: missionId2,
    taskId: 'T-pending',
    title: 'Task with unfinished dep',
    type: 'analysis',
    dependsOn: ['T-existing'],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  });
  assert.equal(resultPending.status, 'PENDING');
});

// TC4: 终态 (COMPLETED/FAILED) 下 task-add 应被拒绝
test('TC4: task-add is rejected when mission is in a terminal status', () => {
  for (const terminalStatus of ['COMPLETED', 'FAILED'] as const) {
    const missionsDir = makeMissionsDir(`tc4-${terminalStatus}`);
    const missionId = `mission-tc4-${terminalStatus}`;

    writeMissionFixture(missionsDir, baseMission({ missionId, status: terminalStatus }));

    assert.throws(
      () => addTask({
        missionsDir,
        missionId,
        taskId: 'T-blocked',
        title: 'Should be blocked',
        type: 'analysis',
        dependsOn: [],
        agent: null,
        agentMentionTag: null,
        agentName: null,
        dryRun: false,
      }),
      /Cannot add task to mission in status/,
      `Expected rejection for terminal status ${terminalStatus}`
    );
  }
});

// TC5: RUNNING 状態下 task-add は mission status を変更しない
test('TC5: task-add in RUNNING status keeps mission status as RUNNING', () => {
  const missionsDir = makeMissionsDir('tc5');
  const missionId = 'mission-tc5';

  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'RUNNING' }));

  const result = addTask({
    missionsDir,
    missionId,
    taskId: 'T-running',
    title: 'Task added during running',
    type: 'analysis',
    dependsOn: [],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  });

  assert.equal(result.missionStatus, 'RUNNING');

  const persisted = readMissionFile(missionsDir, missionId);
  assert.equal(persisted.status, 'RUNNING');
});

// TC6: VERIFYING 下 task-add 事件日志包含状态回退信息
test('TC6: task-add from VERIFYING emits event with missionStatusReverted', () => {
  const missionsDir = makeMissionsDir('tc6');
  const missionId = 'mission-tc6';

  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'VERIFYING' }));

  addTask({
    missionsDir,
    missionId,
    taskId: 'T-event',
    title: 'Task to check event',
    type: 'analysis',
    dependsOn: [],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  });

  const events = readEvents(missionsDir, missionId);
  assert.ok(events.length >= 1, 'At least one event should be recorded');

  // source='task_added' → type='mission_task_added' (not overridden by eventExtras.taskType)
  const taskAddedEvent = events.find((e) => e.type === 'mission_task_added');
  assert.ok(taskAddedEvent !== undefined, `mission_task_added event should exist, got: ${JSON.stringify(events)}`);
  assert.equal(taskAddedEvent?.missionStatusReverted, 'VERIFYING→RUNNING');
});
