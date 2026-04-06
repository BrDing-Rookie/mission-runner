/**
 * enforce-transition.test.ts
 *
 * 测试 commitMissionUpdate() 的状态迁移强制校验逻辑：
 * - 合法迁移正常通过
 * - 非法迁移被拦截（return false，不写文件）
 * - 非法迁移记录 illegal_transition_blocked 审计事件
 * - 同状态写入不被拦截
 * - 终态（COMPLETED/FAILED）不允许迁移到任何状态
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { writeMission } from './lib/fs-utils.ts';
import type { Mission } from './lib/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMissionsDir(): string {
  return mkdtempSync(join(tmpdir(), 'enforce-transition-'));
}

function makeMission(overrides: Partial<Mission> & { missionId: string; status: Mission['status'] }): Mission {
  return {
    title: 'Test',
    goal: 'Test goal',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setupMission(missionsDir: string, mission: Mission): void {
  const missionDir = join(missionsDir, mission.missionId);
  mkdirSync(missionDir, { recursive: true });
  // Write via writeMission (bypasses commitMissionUpdate checks — correct for setup)
  writeMission(missionsDir, mission);
  // Initialise events.jsonl
  const eventsPath = join(missionDir, 'events.jsonl');
  try { readFileSync(eventsPath, 'utf-8'); } catch { /* file doesn't exist yet, will be created on first append */ }
}

function readMissionOnDisk(missionsDir: string, missionId: string): Mission {
  return JSON.parse(readFileSync(join(missionsDir, missionId, 'mission.json'), 'utf-8')) as Mission;
}

function readEvents(missionsDir: string, missionId: string): Array<Record<string, unknown>> {
  const eventsPath = join(missionsDir, missionId, 'events.jsonl');
  try {
    const content = readFileSync(eventsPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('commitMissionUpdate: legal transition (CREATED → PLANNED) succeeds', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-001';
  const oldMission = makeMission({ missionId, status: 'CREATED' });
  setupMission(missionsDir, oldMission);

  const newMission: Mission = { ...oldMission, status: 'PLANNED', updatedAt: new Date().toISOString() };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: false,
    source: 'test_plan',
    skipNotification: true,
  });

  assert.equal(ok, true, 'Expected commitMissionUpdate to return true for legal transition');

  const onDisk = readMissionOnDisk(missionsDir, missionId);
  assert.equal(onDisk.status, 'PLANNED', 'Expected status on disk to be PLANNED');
});

test('commitMissionUpdate: illegal transition (CREATED → COMPLETED) returns false and does not write', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-002';
  const oldMission = makeMission({ missionId, status: 'CREATED' });
  setupMission(missionsDir, oldMission);

  const newMission: Mission = { ...oldMission, status: 'COMPLETED', updatedAt: new Date().toISOString() };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: false,
    source: 'test_bad',
    skipNotification: true,
  });

  assert.equal(ok, false, 'Expected commitMissionUpdate to return false for illegal transition');

  const onDisk = readMissionOnDisk(missionsDir, missionId);
  assert.equal(onDisk.status, 'CREATED', 'Expected status on disk to remain CREATED (write was blocked)');
});

test('commitMissionUpdate: illegal transition records illegal_transition_blocked event', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-003';
  const oldMission = makeMission({ missionId, status: 'CREATED' });
  setupMission(missionsDir, oldMission);

  const newMission: Mission = { ...oldMission, status: 'VERIFYING', updatedAt: new Date().toISOString() };

  commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: false,
    source: 'test_illegal',
    skipNotification: true,
  });

  const events = readEvents(missionsDir, missionId);
  const blocked = events.find((e) => e.type === 'illegal_transition_blocked');
  assert.ok(blocked, 'Expected an illegal_transition_blocked event');
  assert.equal(blocked.from, 'CREATED');
  assert.equal(blocked.to, 'VERIFYING');
  assert.equal(blocked.source, 'test_illegal');
});

test('commitMissionUpdate: same-status write (no status change) is not blocked', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-004';
  const oldMission = makeMission({ missionId, status: 'RUNNING' });
  setupMission(missionsDir, oldMission);

  // Only update a metadata field, not status
  const newMission: Mission = {
    ...oldMission,
    updatedAt: new Date().toISOString(),
    metadata: { note: 'progress update' },
  };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: false,
    source: 'test_noop',
    skipNotification: true,
  });

  assert.equal(ok, true, 'Expected same-status write to succeed');

  const onDisk = readMissionOnDisk(missionsDir, missionId);
  assert.equal(onDisk.status, 'RUNNING');
  assert.deepEqual(onDisk.metadata, { note: 'progress update' });
});

test('commitMissionUpdate: terminal status COMPLETED cannot transition to any state', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-005';
  const oldMission = makeMission({ missionId, status: 'COMPLETED' });
  setupMission(missionsDir, oldMission);

  for (const targetStatus of ['RUNNING', 'PLANNED', 'ITERATING', 'FAILED'] as const) {
    const newMission: Mission = { ...oldMission, status: targetStatus, updatedAt: new Date().toISOString() };

    const ok = commitMissionUpdate({
      missionsDir,
      oldMission,
      newMission,
      dryRun: false,
      source: 'test_terminal',
      skipNotification: true,
    });

    assert.equal(ok, false, `Expected COMPLETED → ${targetStatus} to be blocked`);
  }

  const onDisk = readMissionOnDisk(missionsDir, missionId);
  assert.equal(onDisk.status, 'COMPLETED', 'Status on disk should remain COMPLETED');
});

test('commitMissionUpdate: terminal status FAILED cannot transition to any state', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-006';
  const oldMission = makeMission({ missionId, status: 'FAILED' });
  setupMission(missionsDir, oldMission);

  const newMission: Mission = { ...oldMission, status: 'RUNNING', updatedAt: new Date().toISOString() };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: false,
    source: 'test_from_failed',
    skipNotification: true,
  });

  assert.equal(ok, false, 'Expected FAILED → RUNNING to be blocked');

  const onDisk = readMissionOnDisk(missionsDir, missionId);
  assert.equal(onDisk.status, 'FAILED', 'Status on disk should remain FAILED');
});

test('commitMissionUpdate: illegal transition is also blocked in dryRun mode', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-enforce-007';
  const oldMission = makeMission({ missionId, status: 'PLANNED' });
  setupMission(missionsDir, oldMission);

  const newMission: Mission = { ...oldMission, status: 'COMPLETED', updatedAt: new Date().toISOString() };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission,
    newMission,
    dryRun: true,
    source: 'test_dryrun_illegal',
    skipNotification: true,
  });

  assert.equal(ok, false, 'Expected illegal transition to be blocked even in dryRun mode');
});
