import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVerify } from './mission-verify.ts';
import { evaluateMission } from './mission-watchdog.ts';
import { DEFAULT_WATCHDOG_CONFIG, type Mission } from './lib/types.ts';
import { readMissionFile, writeMissionFixture } from './test-helpers.ts';

function verifyMissionFixture(mission: Mission): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-verify-watchdog-'));
  writeMissionFixture(missionsDir, mission);
  return { missionsDir, missionId: mission.missionId };
}

test('runVerify ignores failed optional completion criteria when mission state is otherwise complete', () => {
  const missionId = 'mission-verify-optional-001';
  const { missionsDir } = verifyMissionFixture({
    missionId,
    title: 'Optional criterion mission',
    goal: 'Only required completion state should gate PASS',
    status: 'VERIFYING',
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: '2026-03-28T00:00:00.000Z',
    lastProgressAt: '2026-03-28T00:00:00.000Z',
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' },
    ],
    completionCriteria: [
      { id: 'optional-artifact', description: 'Artifact deliverable exists', required: false },
    ],
  });
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'PASS');
  assert.equal(result.missionStatus, 'COMPLETED');
  assert.deepEqual(result.gaps, []);

  const updatedMission = readMissionFile(missionsDir, missionId);
  assert.equal(updatedMission.status, 'COMPLETED');
  assert.equal(updatedMission.verification?.status, 'PASS');
});

test('evaluateMission keeps WAITING_BACKGROUND missions idle until nextWakeAt when no finished process exists', () => {
  const nowMs = Date.parse('2026-03-28T01:00:00.000Z');
  const mission: Mission = {
    missionId: 'watchdog-waiting-background-001',
    title: 'Waiting background mission',
    goal: 'Do not poll too early',
    status: 'WAITING_BACKGROUND',
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: '2026-03-28T00:00:00.000Z',
    lastProgressAt: '2026-03-28T00:00:00.000Z',
    nextWakeAt: '2026-03-28T02:00:00.000Z',
    tasks: [
      { taskId: 'T-bg', title: 'Background task', type: 'code', status: 'WAITING_BACKGROUND', backgroundProcessId: 'P-bg' },
    ],
    backgroundProcesses: [
      { processId: 'P-bg', taskId: 'T-bg', status: 'RUNNING', startedAt: '2026-03-28T00:10:00.000Z' },
    ],
  };

  const result = evaluateMission(mission, { ...DEFAULT_WATCHDOG_CONFIG, missionsDir: './missions' }, nowMs);
  assert.equal(result.action, 'NONE');
  assert.match(result.reason, /Waiting for nextWakeAt/);
  assert.deepEqual(result.relatedTaskIds, ['T-bg']);
});

test('evaluateMission prefers RETRY_TASK for idle RUNNING missions with retryable failures', () => {
  const nowMs = Date.parse('2026-03-28T05:00:00.000Z');
  const mission: Mission = {
    missionId: 'watchdog-retryable-001',
    title: 'Retryable mission',
    goal: 'Retry failed work before escalating',
    status: 'RUNNING',
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: '2026-03-28T00:00:00.000Z',
    lastProgressAt: '2026-03-28T00:00:00.000Z',
    tasks: [
      { taskId: 'T-active', title: 'Still running task', type: 'analysis', status: 'RUNNING' },
      { taskId: 'T-fail', title: 'Retryable fail', type: 'code', status: 'FAILED', retryCount: 0, maxRetries: 2 },
    ],
    backgroundProcesses: [],
  };

  const result = evaluateMission(mission, {
    ...DEFAULT_WATCHDOG_CONFIG,
    missionsDir: './missions',
    maxIdleTimeMs: 60_000,
  }, nowMs);
  assert.equal(result.action, 'RETRY_TASK');
  assert.match(result.reason, /retryable failed tasks/);
  assert.deepEqual(result.relatedTaskIds, ['T-fail']);
});
