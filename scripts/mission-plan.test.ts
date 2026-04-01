import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as missionPlanMain } from './mission-plan.ts';
import { buildParallelTasks, buildSerialTasks, buildTasksFromJSON } from './lib/mission-helpers.ts';
import type { Mission } from './lib/types.ts';
import { readMissionFile, writeMissionFixture } from './test-helpers.ts';

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mission-test-001',
    title: 'Test Mission',
    goal: 'Test goal for unit testing',
    status: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ==================== Unit tests for helper functions ====================

test('buildParallelTasks generates N tasks with no dependencies', () => {
  const mission = makeMission();
  const tasks = buildParallelTasks(4, mission);

  assert.equal(tasks.length, 4);
  for (const task of tasks) {
    assert.deepEqual(task.dependsOn, []);
    assert.equal(task.status, 'READY');
    assert.ok(task.phase); // phase is set
  }
  // All taskIds should be unique
  const ids = tasks.map((t) => t.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

test('buildSerialTasks generates dependent chain', () => {
  const mission = makeMission();
  const tasks = buildSerialTasks(['调研', '实现', '测试'], mission);

  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0].dependsOn, []);
  assert.equal(tasks[0].status, 'READY');
  assert.ok(tasks[1].dependsOn?.includes(tasks[0].taskId));
  assert.equal(tasks[1].status, 'PENDING');
  assert.ok(tasks[2].dependsOn?.includes(tasks[1].taskId));
  assert.equal(tasks[2].status, 'PENDING');
});

test('buildTasksFromJSON parses valid JSON and fills defaults', () => {
  const mission = makeMission();
  const json = JSON.stringify([
    { taskId: 'T1', title: 'Research', type: 'research', dependsOn: [] },
    { taskId: 'T2', title: 'Build', type: 'code', dependsOn: ['T1'] },
  ]);

  const tasks = buildTasksFromJSON(json, mission);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'READY');
  assert.equal(tasks[0].priority, 10);
  assert.equal(tasks[0].retryCount, 0);
  assert.equal(tasks[0].maxRetries, 2);
  assert.ok(tasks[0].createdAt);
  assert.ok(tasks[0].phase);
  assert.equal(tasks[1].status, 'PENDING');
});

test('buildTasksFromJSON preserves explicit status', () => {
  const mission = makeMission();
  const json = JSON.stringify([
    { taskId: 'T1', title: 'Task', type: 'code', dependsOn: [], status: 'RUNNING' },
  ]);

  const tasks = buildTasksFromJSON(json, mission);
  assert.equal(tasks[0].status, 'RUNNING');
});

test('buildTasksFromJSON throws on invalid JSON', () => {
  const mission = makeMission();
  assert.throws(() => buildTasksFromJSON('not json', mission), /Failed to parse/);
});

test('buildTasksFromJSON throws on non-array', () => {
  const mission = makeMission();
  assert.throws(() => buildTasksFromJSON('{"a":1}', mission), /must be an array/);
});

test('buildTasksFromJSON throws on missing taskId', () => {
  const mission = makeMission();
  const json = JSON.stringify([{ title: 'No ID', type: 'code' }]);
  assert.throws(() => buildTasksFromJSON(json, mission), /missing taskId/);
});

test('buildTasksFromJSON throws on missing title', () => {
  const mission = makeMission();
  const json = JSON.stringify([{ taskId: 'T1', type: 'code' }]);
  assert.throws(() => buildTasksFromJSON(json, mission), /missing title/);
});

test('buildTasksFromJSON throws on missing type', () => {
  const mission = makeMission();
  const json = JSON.stringify([{ taskId: 'T1', title: 'No Type' }]);
  assert.throws(() => buildTasksFromJSON(json, mission), /missing type/);
});

// ==================== Integration tests for mission-plan main ====================

function runPlan(args: string[]): { exitCode: number; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  let exitCode: number;
  try {
    exitCode = missionPlanMain(args);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { exitCode, logs, errors };
}

function setupMission(): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'plan-test-'));
  const mission = makeMission();
  writeMissionFixture(missionsDir, mission);
  return { missionsDir, missionId: mission.missionId };
}

test('mission-plan with --template parallel-research', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'parallel-research',
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.status, 'PLANNED');
  assert.equal(mission.tasks?.length, 5);
  // T1, T2, T3 should have no dependencies (parallel)
  assert.deepEqual(mission.tasks![0].dependsOn, []);
  assert.deepEqual(mission.tasks![1].dependsOn, []);
  assert.deepEqual(mission.tasks![2].dependsOn, []);
  // T4 depends on T1, T2, T3
  assert.deepEqual(mission.tasks![3].dependsOn, ['T1-researcher-1', 'T2-researcher-2', 'T3-researcher-3']);
  // T5 depends on T4
  assert.deepEqual(mission.tasks![4].dependsOn, ['T4-synthesis']);
});

test('mission-plan with --template parallel-build', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'parallel-build',
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.length, 5);
  // T2 and T3 both depend on T1 (fan-out)
  assert.deepEqual(mission.tasks![1].dependsOn, ['T1-design']);
  assert.deepEqual(mission.tasks![2].dependsOn, ['T1-design']);
  // T4 depends on both T2 and T3 (fan-in)
  assert.deepEqual(mission.tasks![3].dependsOn, ['T2-frontend', 'T3-backend']);
});

test('mission-plan with --template serial-3', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'serial-3',
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.length, 3);
  assert.deepEqual(mission.tasks![0].dependsOn, []);
  assert.deepEqual(mission.tasks![1].dependsOn, ['T1-context']);
  assert.deepEqual(mission.tasks![2].dependsOn, ['T2-execute']);
});

test('mission-plan with --template unknown fails', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode, errors } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'nonexistent',
  ]);

  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('Unknown template')));
});

test('mission-plan with --tasks-json custom input', () => {
  const { missionsDir, missionId } = setupMission();
  const tasksJson = JSON.stringify([
    { taskId: 'T1-custom', title: 'Custom Task', type: 'research', dependsOn: [] },
  ]);
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--tasks-json', tasksJson,
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.length, 1);
  assert.equal(mission.tasks![0].taskId, 'T1-custom');
  assert.equal(mission.tasks![0].phase, 'research');
});

test('mission-plan with --tasks-file reads from file', () => {
  const { missionsDir, missionId } = setupMission();
  const tasksFile = join(missionsDir, 'custom-tasks.json');
  writeFileSync(tasksFile, JSON.stringify([
    { taskId: 'T1-file', title: 'File Task', type: 'code', dependsOn: [] },
  ]));

  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--tasks-file', tasksFile,
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.length, 1);
  assert.equal(mission.tasks![0].taskId, 'T1-file');
});

test('mission-plan with --parallel N', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--parallel', '3',
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.length, 3);
  for (const task of mission.tasks!) {
    assert.deepEqual(task.dependsOn, []);
    assert.equal(task.status, 'READY');
  }
});

test('mission-plan rejects combining --template and --parallel', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode, errors } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'serial-3',
    '--parallel', '3',
  ]);

  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('only one')));
});

test('mission-plan with no custom args uses default plan (backward compat)', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.status, 'PLANNED');
  assert.ok((mission.tasks?.length ?? 0) > 0);
});

test('all tasks get phase set via derivePhaseFromTask', () => {
  const { missionsDir, missionId } = setupMission();
  const { exitCode } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--template', 'parallel-build',
  ]);

  assert.equal(exitCode, 0);
  const mission = readMissionFile(missionsDir, missionId);
  for (const task of mission.tasks ?? []) {
    assert.ok(task.phase, `Task ${task.taskId} should have phase set`);
  }
});

test('task graph with cycle is rejected', () => {
  const { missionsDir, missionId } = setupMission();
  const tasksJson = JSON.stringify([
    { taskId: 'T1', title: 'A', type: 'code', dependsOn: ['T2'] },
    { taskId: 'T2', title: 'B', type: 'code', dependsOn: ['T1'] },
  ]);
  const { exitCode, errors } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--tasks-json', tasksJson,
  ]);

  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('cyclic')));
});

test('task depending on missing task is rejected', () => {
  const { missionsDir, missionId } = setupMission();
  const tasksJson = JSON.stringify([
    { taskId: 'T1', title: 'A', type: 'code', dependsOn: ['MISSING'] },
  ]);
  const { exitCode, errors } = runPlan([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
    '--tasks-json', tasksJson,
  ]);

  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('missing taskId')));
});
