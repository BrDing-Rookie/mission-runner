/**
 * Zod strict 模式测试
 * 验证 readMission/writeMission 在 strict 模式下的行为
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMission, writeMission } from './lib/fs-utils.ts';
import type { Mission } from './lib/types.ts';

const BASE_TS = '2026-04-06T00:00:00.000Z';

function makeValidMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mission-20260406-001',
    title: 'Test',
    goal: 'Test goal',
    status: 'CREATED',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    ...overrides,
  };
}

function writeMissionJson(missionsDir: string, missionId: string, data: unknown): void {
  const missionDir = join(missionsDir, missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// ==================== readMission tests ====================

test('readMission returns Mission object for valid mission.json', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const missionId = 'mission-20260406-001';
  const mission = makeValidMission({ missionId });
  writeMissionJson(missionsDir, missionId, mission);

  const result = readMission(missionsDir, missionId);
  assert.ok(result !== null);
  assert.equal(result.missionId, missionId);
  assert.equal(result.status, 'CREATED');
  assert.equal(result.title, 'Test');
});

test('readMission throws when mission.json is missing required status field', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const missionId = 'mission-20260406-002';
  // Missing status field — required by MissionSchema
  const invalid = {
    missionId,
    title: 'Test',
    goal: 'Test goal',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
  };
  writeMissionJson(missionsDir, missionId, invalid);

  assert.throws(
    () => readMission(missionsDir, missionId),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('failed schema validation'));
      return true;
    }
  );
});

test('readMission throws when mission.json has invalid status value', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const missionId = 'mission-20260406-003';
  const invalid = {
    missionId,
    title: 'Test',
    goal: 'Test goal',
    status: 'INVALID_STATUS',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
  };
  writeMissionJson(missionsDir, missionId, invalid);

  assert.throws(
    () => readMission(missionsDir, missionId),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('failed schema validation'));
      return true;
    }
  );
});

test('readMission returns null when mission file does not exist', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const result = readMission(missionsDir, 'mission-nonexistent');
  assert.equal(result, null);
});

test('readMission returns null (not throw) for JSON parse errors', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const missionId = 'mission-20260406-bad-json';
  const missionDir = join(missionsDir, missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), 'not valid json!!!', 'utf-8');

  // JSON parse errors should return null, not throw
  const result = readMission(missionsDir, missionId);
  assert.equal(result, null);
});

// ==================== writeMission tests ====================

test('writeMission writes file and returns true for valid mission', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const mission = makeValidMission();

  const result = writeMission(missionsDir, mission);
  assert.equal(result, true);

  const missionPath = join(missionsDir, mission.missionId, 'mission.json');
  assert.ok(existsSync(missionPath), 'mission.json should exist after write');
});

test('writeMission returns false and does not write when status is invalid', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const invalid = makeValidMission({ status: 'INVALID' as Mission['status'] });

  const result = writeMission(missionsDir, invalid);
  assert.equal(result, false);

  const missionPath = join(missionsDir, invalid.missionId, 'mission.json');
  assert.ok(!existsSync(missionPath), 'mission.json should NOT exist when write is blocked');
});

test('writeMission returns false and does not overwrite existing file when invalid data provided', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
  const missionId = 'mission-20260406-001';

  // Write a valid mission first
  const validMission = makeValidMission({ missionId });
  const firstWrite = writeMission(missionsDir, validMission);
  assert.equal(firstWrite, true);

  // Attempt to overwrite with invalid data
  const invalid = makeValidMission({ missionId, status: 'BOGUS' as Mission['status'] });
  const secondWrite = writeMission(missionsDir, invalid);
  assert.equal(secondWrite, false);

  // Original file should be unchanged
  const missionPath = join(missionsDir, missionId, 'mission.json');
  assert.ok(existsSync(missionPath), 'original mission.json should still exist');
  const onDisk = JSON.parse(readFileSync(missionPath, 'utf-8')) as Mission;
  assert.equal(onDisk.status, 'CREATED');
});

test('writeMission succeeds for all valid MissionStatus values', () => {
  const validStatuses: Mission['status'][] = [
    'CREATED', 'PLANNED', 'RUNNING', 'WAITING_BACKGROUND', 'WAITING_EXTERNAL',
    'VERIFYING', 'ITERATING', 'BLOCKED_HIGH_RISK', 'ESCALATED', 'FAILED', 'COMPLETED',
  ];

  for (const status of validStatuses) {
    const missionsDir = mkdtempSync(join(tmpdir(), 'zod-strict-'));
    const mission = makeValidMission({ missionId: 'mission-20260406-001', status });
    const result = writeMission(missionsDir, mission);
    assert.equal(result, true, `Expected writeMission to succeed for status=${status}`);
  }
});
