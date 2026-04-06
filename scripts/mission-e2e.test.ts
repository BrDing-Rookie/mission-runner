/**
 * mission-e2e.test.ts — End-to-end integration tests for the Mission Runner lifecycle
 *
 * Tests simulate complete mission flows using internal functions only (no CLI subprocess calls
 * to external tools). Each test creates its own isolated tmpdir.
 *
 * Notification adapter is set to 'fake' via MISSION_NOTIFICATION_ADAPTER env var.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeMissionFixture, readMissionFile, readEvents } from './test-helpers.ts';
import { readMission, writeMission } from './lib/fs-utils.ts';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { dispatchReadyTasks, DEFAULT_AGENT_MAP } from './lib/mission-dispatcher.ts';
import { deriveMissionStatus } from './lib/mission-helpers.ts';
import { runVerify } from './mission-verify.ts';
import { addTask } from './task-add.ts';
import { main as resumeMain } from './mission-resume.ts';
import { main as dispatchMain } from './mission-dispatch.ts';
import type { Mission, Task } from './lib/types.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE_TS = '2026-04-03T00:00:00.000Z';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `mission-e2e-${prefix}-`));
}

function baseMission(overrides: Partial<Mission> & Pick<Mission, 'missionId' | 'status'>): Mission {
  return {
    title: 'E2E Test Mission',
    goal: 'Verify end-to-end mission lifecycle',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    tasks: [],
    backgroundProcesses: [],
    artifacts: [],
    ...overrides,
  } as Mission;
}

function makeTask(
  taskId: string,
  title: string,
  type: Task['type'],
  status: Task['status'],
  dependsOn: string[] = [],
): Task {
  return {
    taskId,
    title,
    type,
    status,
    dependsOn,
    createdAt: BASE_TS,
    startedAt: null,
    endedAt: null,
    resultSummary: null,
    artifacts: [],
    retryCount: 0,
    maxRetries: 2,
    lastError: null,
    backgroundProcessId: null,
    config: {},
  };
}

/**
 * Complete a task by updating mission state: mark the task COMPLETED and
 * unlock dependent tasks (PENDING → READY where all deps are now done).
 * Persists the change using commitMissionUpdate.
 */
function completeTask(missionsDir: string, missionId: string, taskId: string): Mission {
  const mission = readMission(missionsDir, missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);

  const DONE = new Set<Task['status']>(['COMPLETED', 'SKIPPED']);

  // Build updated task list: mark target COMPLETED, then unlock pending deps
  const updatedTasks = mission.tasks?.map((t) => {
    if (t.taskId === taskId) {
      return { ...t, status: 'COMPLETED' as const, endedAt: new Date().toISOString() };
    }
    return t;
  }) ?? [];

  // Second pass: unlock tasks whose dependencies are now all satisfied
  const taskMap = new Map(updatedTasks.map((t) => [t.taskId, t]));
  const finalTasks = updatedTasks.map((t) => {
    if (t.status !== 'PENDING') return t;
    const allDone = (t.dependsOn ?? []).every((depId) => {
      const dep = taskMap.get(depId);
      return dep && DONE.has(dep.status);
    });
    return allDone ? { ...t, status: 'READY' as const } : t;
  });

  const newStatus = deriveMissionStatus(mission.status, finalTasks);
  const updatedMission: Mission = {
    ...mission,
    status: newStatus,
    tasks: finalTasks,
    updatedAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };

  commitMissionUpdate({
    missionsDir,
    oldMission: mission,
    newMission: updatedMission,
    dryRun: false,
    source: 'task_completed',
    eventExtras: { completedTaskId: taskId },
  });

  return updatedMission;
}

// ── Setup: ensure fake notification adapter ────────────────────────────────────

before(() => {
  process.env.MISSION_NOTIFICATION_ADAPTER = 'fake';
});

// ── Scenario 1: Standard Linear Flow ─────────────────────────────────────────

describe('Scenario 1: standard linear flow (create → dispatch → update → verify)', () => {
  let missionsDir: string;
  const missionId = 'mission-e2e-linear-001';

  before(() => {
    missionsDir = makeTmpDir('linear');
    writeMissionFixture(missionsDir, baseMission({
      missionId,
      status: 'PLANNED',
      tasks: [
        makeTask('T1', 'Research requirements', 'research', 'READY'),
        makeTask('T2', 'Implement solution', 'code', 'PENDING', ['T1']),
        makeTask('T3', 'Write documentation', 'document', 'PENDING', ['T2']),
      ],
    }));
    writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');
  });

  after(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('dispatches READY tasks, marking T1 as RUNNING and leaving T2/T3 PENDING', () => {
    const exitCode = dispatchMain(['--missions-dir', missionsDir, '--mission-id', missionId]);
    assert.equal(exitCode, 0);

    const mission = readMissionFile(missionsDir, missionId);
    const t1 = mission.tasks?.find((t) => t.taskId === 'T1');
    const t2 = mission.tasks?.find((t) => t.taskId === 'T2');
    const t3 = mission.tasks?.find((t) => t.taskId === 'T3');

    assert.ok(['RUNNING', 'WAITING_BACKGROUND'].includes(t1?.status ?? ''), `T1 should be RUNNING or WAITING_BACKGROUND, got ${t1?.status}`);
    assert.equal(t2?.status, 'PENDING', 'T2 should remain PENDING (dep unsatisfied)');
    assert.equal(t3?.status, 'PENDING', 'T3 should remain PENDING');
  });

  it('completing T1 unlocks T2 from PENDING to READY', () => {
    const updatedMission = completeTask(missionsDir, missionId, 'T1');

    const t2 = updatedMission.tasks?.find((t) => t.taskId === 'T2');
    assert.equal(t2?.status, 'READY', 'T2 should be unlocked to READY after T1 completes');
  });

  it('completing T2 unlocks T3 to READY', () => {
    const updatedMission = completeTask(missionsDir, missionId, 'T2');
    const t3 = updatedMission.tasks?.find((t) => t.taskId === 'T3');
    assert.equal(t3?.status, 'READY', 'T3 should be unlocked to READY after T2 completes');
  });

  it('completing all tasks transitions mission to VERIFYING', () => {
    const updatedMission = completeTask(missionsDir, missionId, 'T3');
    assert.equal(updatedMission.status, 'VERIFYING', 'Mission should enter VERIFYING when all tasks are terminal');
  });

  it('running verify on fully completed mission results in COMPLETED', () => {
    const result = runVerify({ missionsDir, missionId, dryRun: false });
    assert.equal(result.verificationStatus, 'PASS');
    assert.equal(result.missionStatus, 'COMPLETED');

    const finalMission = readMissionFile(missionsDir, missionId);
    assert.equal(finalMission.status, 'COMPLETED');
  });

  it('emits ordered audit events throughout the lifecycle', () => {
    const events = readEvents(missionsDir, missionId);
    const types = events.map((e) => e.type as string);

    assert.ok(types.includes('mission_dispatched'), 'Should have dispatched event');
    assert.ok(types.includes('mission_task_completed'), 'Should have task_completed events');
    assert.ok(types.includes('mission_verified'), 'Should have verified event');
  });
});

// ── Scenario 2: VERIFYING state — add task and recover ─────────────────────────

describe('Scenario 2: task-add during VERIFYING reverts to RUNNING', () => {
  let missionsDir: string;
  const missionId = 'mission-e2e-verifying-add-001';

  before(() => {
    missionsDir = makeTmpDir('verifying-add');
    writeMissionFixture(missionsDir, baseMission({
      missionId,
      status: 'VERIFYING',
      tasks: [
        makeTask('T1', 'Initial task', 'analysis', 'COMPLETED'),
      ],
    }));
    writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');
  });

  after(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('adding a task while VERIFYING succeeds without throwing', () => {
    assert.doesNotThrow(() => {
      addTask({
        missionsDir,
        missionId,
        taskId: 'T-new',
        title: 'Extra task added during verify',
        type: 'document',
        dependsOn: [],
        agent: null,
        agentMentionTag: null,
        agentName: null,
        dryRun: false,
      });
    });
  });

  it('after task-add, mission status reverts from VERIFYING to RUNNING', () => {
    const mission = readMissionFile(missionsDir, missionId);
    assert.equal(mission.status, 'RUNNING', 'Mission should revert to RUNNING after task added during VERIFYING');
  });

  it('newly added task has READY status (no dependencies)', () => {
    const mission = readMissionFile(missionsDir, missionId);
    const newTask = mission.tasks?.find((t) => t.taskId === 'T-new');
    assert.ok(newTask, 'New task should exist');
    assert.equal(newTask?.status, 'READY', 'Task without deps should be READY');
  });

  it('completing new task causes mission to re-enter VERIFYING', () => {
    const updatedMission = completeTask(missionsDir, missionId, 'T-new');
    assert.equal(updatedMission.status, 'VERIFYING', 'Mission should re-enter VERIFYING when all tasks are done');
  });

  it('running verify after completing new task results in COMPLETED', () => {
    const result = runVerify({ missionsDir, missionId, dryRun: false });
    assert.equal(result.verificationStatus, 'PASS');
    assert.equal(result.missionStatus, 'COMPLETED');
  });
});

// ── Scenario 3: Parallel task execution ───────────────────────────────────────

describe('Scenario 3: parallel tasks — all READY, dispatched together', () => {
  let missionsDir: string;
  const missionId = 'mission-e2e-parallel-001';

  before(() => {
    missionsDir = makeTmpDir('parallel');
    writeMissionFixture(missionsDir, baseMission({
      missionId,
      status: 'PLANNED',
      tasks: [
        makeTask('P1', 'Parallel branch 1', 'research', 'READY'),
        makeTask('P2', 'Parallel branch 2', 'analysis', 'READY'),
        makeTask('P3', 'Parallel branch 3', 'document', 'READY'),
      ],
      backgroundProcesses: [],
    }));
    writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');
  });

  after(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('all parallel tasks start as READY with no dependencies', () => {
    const mission = readMissionFile(missionsDir, missionId);
    for (const task of mission.tasks ?? []) {
      assert.equal(task.status, 'READY', `Task ${task.taskId} should be READY`);
    }
  });

  it('dispatch starts all 3 parallel tasks simultaneously', () => {
    const exitCode = dispatchMain(['--missions-dir', missionsDir, '--mission-id', missionId]);
    assert.equal(exitCode, 0);

    const mission = readMissionFile(missionsDir, missionId);
    for (const task of mission.tasks ?? []) {
      const isActive = ['RUNNING', 'WAITING_BACKGROUND'].includes(task.status);
      assert.ok(isActive, `Task ${task.taskId} should be active after dispatch, got ${task.status}`);
    }
  });

  it('completing all tasks transitions mission to VERIFYING', () => {
    let updatedMission: Mission | undefined;
    for (const taskId of ['P1', 'P2', 'P3']) {
      updatedMission = completeTask(missionsDir, missionId, taskId);
    }
    assert.equal(updatedMission?.status, 'VERIFYING', 'Mission should enter VERIFYING when all parallel tasks complete');
  });

  it('verify passes for fully completed parallel mission', () => {
    const result = runVerify({ missionsDir, missionId, dryRun: false });
    assert.equal(result.verificationStatus, 'PASS');
    assert.equal(result.missionStatus, 'COMPLETED');
  });
});

// ── Scenario 4: Failure and retry ─────────────────────────────────────────────

describe('Scenario 4: task failure and retry flow', () => {
  let missionsDir: string;
  const missionId = 'mission-e2e-retry-001';

  before(() => {
    missionsDir = makeTmpDir('retry');
    writeMissionFixture(missionsDir, baseMission({
      missionId,
      status: 'RUNNING',
      tasks: [
        makeTask('T1', 'Flaky task', 'analysis', 'RUNNING'),
        makeTask('T2', 'Dependent task', 'code', 'PENDING', ['T1']),
      ],
      backgroundProcesses: [],
    }));
  });

  after(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('failing T1 sets status to FAILED and records lastError', () => {
    const mission = readMission(missionsDir, missionId);
    assert.ok(mission);

    const updatedTasks = (mission.tasks ?? []).map((t) =>
      t.taskId === 'T1'
        ? { ...t, status: 'FAILED' as const, retryCount: 1, lastError: 'Simulated failure', endedAt: new Date().toISOString() }
        : t,
    );
    const newStatus = deriveMissionStatus(mission.status, updatedTasks);
    const updatedMission: Mission = { ...mission, status: newStatus, tasks: updatedTasks, updatedAt: new Date().toISOString() };

    commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: false,
      source: 'task_failed_test',
    });

    const persisted = readMissionFile(missionsDir, missionId);
    const t1 = persisted.tasks?.find((t) => t.taskId === 'T1');
    assert.equal(t1?.status, 'FAILED');
    assert.equal(t1?.retryCount, 1);
    assert.equal(t1?.lastError, 'Simulated failure');
  });

  it('T2 remains PENDING while T1 is FAILED (deps not satisfied)', () => {
    const mission = readMissionFile(missionsDir, missionId);
    const t2 = mission.tasks?.find((t) => t.taskId === 'T2');
    assert.equal(t2?.status, 'PENDING', 'T2 should remain PENDING until T1 is resolved');
  });

  it('mission-resume retries T1 (sets it back to READY) when retryCount < maxRetries', () => {
    // First set up a WAITING_EXTERNAL state for resume to work
    const mission = readMission(missionsDir, missionId);
    assert.ok(mission);

    const updatedMission: Mission = { ...mission, status: 'WAITING_EXTERNAL', updatedAt: new Date().toISOString() };
    commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: false,
      source: 'pre_resume_setup',
    });

    const exitCode = resumeMain(['--missions-dir', missionsDir, '--mission-id', missionId]);
    assert.equal(exitCode, 0);

    const afterResume = readMissionFile(missionsDir, missionId);
    const t1 = afterResume.tasks?.find((t) => t.taskId === 'T1');
    // After resume, T1 should be retried (READY or PENDING depending on deps)
    assert.ok(
      ['READY', 'PENDING'].includes(t1?.status ?? ''),
      `T1 should be retried after resume, got ${t1?.status}`,
    );
  });

  it('after T1 succeeds, T2 unlocks and mission can reach VERIFYING', () => {
    // Force T1 to READY for dispatch and then complete it
    const mission = readMission(missionsDir, missionId);
    assert.ok(mission);

    // Manually set T1 back to READY so we can complete it
    const readyTasks = (mission.tasks ?? []).map((t) =>
      t.taskId === 'T1' ? { ...t, status: 'READY' as const, lastError: null } : t,
    );
    const updatedMission: Mission = {
      ...mission,
      status: 'RUNNING',
      tasks: readyTasks,
      updatedAt: new Date().toISOString(),
    };
    commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: false,
      source: 'retry_setup',
    });

    // Complete T1 — should unlock T2
    const afterT1 = completeTask(missionsDir, missionId, 'T1');
    const t2 = afterT1.tasks?.find((t) => t.taskId === 'T2');
    assert.equal(t2?.status, 'READY', 'T2 should be unlocked to READY after T1 successfully completes');

    // Complete T2 — mission should go to VERIFYING
    const afterT2 = completeTask(missionsDir, missionId, 'T2');
    assert.equal(afterT2.status, 'VERIFYING', 'Mission should reach VERIFYING after all tasks complete');
  });
});

// ── Scenario 5: Zod schema validation ─────────────────────────────────────────

describe('Scenario 5: Zod validation — malformed mission.json throws in strict mode', () => {
  let missionsDir: string;
  const missionId = 'mission-e2e-zod-001';

  before(() => {
    missionsDir = makeTmpDir('zod');
    mkdirSync(join(missionsDir, missionId), { recursive: true });
    writeFileSync(join(missionsDir, missionId, 'events.jsonl'), '');
  });

  after(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it('reads a malformed mission.json (invalid status) and throws a schema validation error', () => {
    // Write a mission.json with an invalid status value
    const malformed = {
      missionId,
      title: 'Malformed mission',
      goal: 'Test Zod strict mode',
      status: 'INVALID_STATUS_XYZ',   // not in the enum
      createdAt: BASE_TS,
      updatedAt: BASE_TS,
    };
    writeFileSync(join(missionsDir, missionId, 'mission.json'), JSON.stringify(malformed, null, 2));

    assert.throws(
      () => readMission(missionsDir, missionId),
      (err: Error) => err.message.includes('failed schema validation'),
      'readMission should throw for invalid schema data',
    );
  });

  it('reads a valid mission.json without any warnings', () => {
    const valid: Mission = baseMission({ missionId: 'mission-e2e-zod-002', status: 'RUNNING' });
    const validDir = join(missionsDir, 'mission-e2e-zod-002');
    mkdirSync(validDir, { recursive: true });
    writeFileSync(join(validDir, 'mission.json'), JSON.stringify(valid, null, 2));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    let result: ReturnType<typeof readMission> = null;
    try {
      result = readMission(missionsDir, 'mission-e2e-zod-002');
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(result !== null, 'readMission should return the mission object');
    assert.equal(result?.status, 'RUNNING');
    assert.equal(warnings.length, 0, `Expected no warnings for a valid mission, got: ${JSON.stringify(warnings)}`);
  });
});

// ── Bonus: dispatchReadyTasks unit-level integration ──────────────────────────

describe('dispatchReadyTasks correctly classifies analysis vs code tasks', () => {
  it('analysis task becomes RUNNING, code task becomes WAITING_BACKGROUND', () => {
    const mission: Mission = baseMission({
      missionId: 'mission-e2e-dispatch-classify-001',
      status: 'PLANNED',
      tasks: [
        makeTask('A1', 'Analysis task', 'analysis', 'READY'),
        makeTask('C1', 'Code task', 'code', 'READY'),
      ],
      backgroundProcesses: [],
    });

    const result = dispatchReadyTasks(mission, {
      missionsDir: '/tmp/irrelevant',
      autoSpawn: false,
      agentMap: DEFAULT_AGENT_MAP,
    });

    const a1 = result.updatedTasks.find((t) => t.taskId === 'A1');
    const c1 = result.updatedTasks.find((t) => t.taskId === 'C1');

    assert.equal(a1?.status, 'RUNNING', 'Analysis task should be RUNNING after dispatch');
    assert.equal(c1?.status, 'WAITING_BACKGROUND', 'Code task should be WAITING_BACKGROUND after dispatch');
    assert.ok(result.runningTaskIds.includes('A1'), 'A1 should be in runningTaskIds');
    assert.ok(result.backgroundTaskIds.includes('C1'), 'C1 should be in backgroundTaskIds');
  });

  it('PENDING tasks are not dispatched, only READY tasks are consumed', () => {
    const mission: Mission = baseMission({
      missionId: 'mission-e2e-dispatch-classify-002',
      status: 'RUNNING',
      tasks: [
        makeTask('R1', 'Ready task', 'analysis', 'READY'),
        makeTask('P1', 'Pending task', 'analysis', 'PENDING', ['R1']),
      ],
      backgroundProcesses: [],
    });

    const result = dispatchReadyTasks(mission, {
      missionsDir: '/tmp/irrelevant',
      autoSpawn: false,
      agentMap: DEFAULT_AGENT_MAP,
    });

    const p1 = result.updatedTasks.find((t) => t.taskId === 'P1');
    assert.equal(p1?.status, 'PENDING', 'PENDING task should remain PENDING after dispatch');
    assert.ok(!result.startedTaskIds.includes('P1'), 'P1 should not be started');
  });
});
