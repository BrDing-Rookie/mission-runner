/**
 * Zod Schema 运行时校验测试
 * 覆盖: MissionSchema / TaskSchema / validateMission / readMission / writeMission
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MissionSchema, TaskSchema, validateMission } from './lib/schemas.ts';
import { readMission, writeMission } from './lib/fs-utils.ts';
import type { Mission } from './lib/types.ts';

// ==================== Fixtures ====================

function makeValidMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mission-20260101-001',
    title: 'Schema Test Mission',
    goal: 'Verify Zod schema integration works correctly',
    status: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setupMissionDir(mission: Mission): string {
  const missionsDir = mkdtempSync(join(tmpdir(), 'schema-test-'));
  const missionDir = join(missionsDir, mission.missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(
    join(missionDir, 'mission.json'),
    JSON.stringify(mission, null, 2),
    'utf-8'
  );
  writeFileSync(join(missionDir, 'events.jsonl'), '', 'utf-8');
  return missionsDir;
}

// ==================== TC1: 合法 Mission 对象通过校验 ====================

test('TC1: valid Mission object passes MissionSchema validation', () => {
  const mission = makeValidMission();
  const result = MissionSchema.safeParse(mission);
  assert.equal(result.success, true);
});

test('TC1b: valid Mission with all optional fields passes validation', () => {
  const mission = makeValidMission({
    status: 'RUNNING',
    owner: {
      sessionKey: 'session-abc',
      channel: 'discord',
      chatId: '12345',
    },
    tasks: [
      {
        taskId: 'T1',
        title: 'Research task',
        type: 'research',
        status: 'READY',
        dependsOn: [],
        retryCount: 0,
        maxRetries: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        phase: 'research',
      },
    ],
    completionCriteria: [
      { id: 'C1', description: 'All tests pass', required: true, verified: false },
    ],
    flags: {
      notifiedStart: true,
      notifiedComplete: false,
    },
  });
  const result = MissionSchema.safeParse(mission);
  assert.equal(result.success, true);
});

// ==================== TC2: 缺少 required 字段时校验失败 ====================

test('TC2: missing missionId causes validation failure', () => {
  const invalid = {
    title: 'No ID Mission',
    goal: 'Some goal',
    status: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = MissionSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('missionId')),
    'Should report missing missionId'
  );
});

test('TC2b: missing title causes validation failure', () => {
  const invalid = {
    missionId: 'mission-20260101-001',
    goal: 'Some goal',
    status: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = MissionSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('title')),
    'Should report missing title'
  );
});

test('TC2c: missing createdAt causes validation failure', () => {
  const invalid = {
    missionId: 'mission-20260101-001',
    title: 'Test',
    goal: 'Some goal',
    status: 'CREATED',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = MissionSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('createdAt')),
    'Should report missing createdAt'
  );
});

// ==================== TC3: status 不在枚举范围的对象校验失败 ====================

test('TC3: invalid mission status causes validation failure', () => {
  const invalid = makeValidMission({ status: 'INVALID_STATUS' as never });
  const result = MissionSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('status')),
    'Should report invalid status'
  );
});

test('TC3b: invalid task status causes validation failure', () => {
  const invalidTask = {
    taskId: 'T1',
    title: 'Test Task',
    type: 'code',
    status: 'UNKNOWN_STATUS',
  };
  const result = TaskSchema.safeParse(invalidTask);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('status')),
    'Should report invalid task status'
  );
});

test('TC3c: invalid task type causes validation failure', () => {
  const invalidTask = {
    taskId: 'T1',
    title: 'Test Task',
    type: 'invalid_type',
    status: 'READY',
  };
  const result = TaskSchema.safeParse(invalidTask);
  assert.equal(result.success, false);
  assert.ok(
    result.error?.errors.some((e) => e.path.includes('type')),
    'Should report invalid task type'
  );
});

// ==================== TC4: 包含未知字段的对象通过校验（passthrough）====================

test('TC4: unknown fields in Mission are allowed (passthrough)', () => {
  const missionWithExtra = {
    ...makeValidMission(),
    unknownField: 'some value',
    anotherExtra: 42,
  };
  const result = MissionSchema.safeParse(missionWithExtra);
  assert.equal(result.success, true);
  // passthrough preserves unknown fields
  assert.equal((result.data as Record<string, unknown>)['unknownField'], 'some value');
});

test('TC4b: unknown fields in nested Task are allowed (passthrough)', () => {
  const taskWithExtra = {
    taskId: 'T1',
    title: 'Test Task',
    type: 'code',
    status: 'READY',
    extraMetadata: { key: 'value' },
  };
  const result = TaskSchema.safeParse(taskWithExtra);
  assert.equal(result.success, true);
  assert.deepEqual(
    (result.data as Record<string, unknown>)['extraMetadata'],
    { key: 'value' }
  );
});

// ==================== TC5: validateMission 返回正确的 success/errors ====================

test('TC5: validateMission returns success=true for valid mission', () => {
  const mission = makeValidMission();
  const result = validateMission(mission);
  assert.equal(result.success, true);
  assert.ok(result.mission, 'mission should be returned on success');
  assert.equal(result.errors, undefined);
});

test('TC5b: validateMission returns success=false with error paths for invalid data', () => {
  const invalid = {
    title: 'Missing missionId',
    goal: 'goal',
    status: 'BAD_STATUS',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = validateMission(invalid);
  assert.equal(result.success, false);
  assert.ok(Array.isArray(result.errors), 'errors should be an array');
  assert.ok((result.errors?.length ?? 0) > 0, 'should have at least one error');
  // Check that errors contain path info
  const errorStr = result.errors?.join(' ') ?? '';
  assert.ok(
    errorStr.includes('missionId') || errorStr.includes('status'),
    `Errors should reference field paths: ${errorStr}`
  );
});

test('TC5c: validateMission errors include path:message format', () => {
  const invalid = { status: 'CREATED' }; // missing missionId, title, goal, createdAt, updatedAt
  const result = validateMission(invalid);
  assert.equal(result.success, false);
  assert.ok(result.errors && result.errors.length >= 1);
  // Each error should follow "path: message" format
  for (const err of result.errors ?? []) {
    assert.ok(err.includes(':'), `Error should contain ':' separator: "${err}"`);
  }
});

// ==================== TC6: readMission 读取畸形数据时 warn 但仍返回 ====================

test('TC6: readMission throws for malformed mission.json (strict mode)', () => {
  const malformed = {
    // Missing required fields: missionId, title, goal, status, createdAt, updatedAt
    someField: 'only this field',
  };
  const missionsDir = mkdtempSync(join(tmpdir(), 'schema-read-test-'));
  const missionId = 'mission-malformed-001';
  const missionDir = join(missionsDir, missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(malformed, null, 2), 'utf-8');

  assert.throws(
    () => readMission(missionsDir, missionId),
    (err: Error) => err.message.includes('failed schema validation'),
    'readMission should throw for malformed data in strict mode',
  );
});

test('TC6b: readMission returns null for non-existent file (no crash)', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'schema-read-missing-'));
  const result = readMission(missionsDir, 'mission-does-not-exist');
  assert.equal(result, null);
});

test('TC6c: readMission does not warn for valid mission data', () => {
  const mission = makeValidMission();
  const missionsDir = setupMissionDir(mission);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

  try {
    const result = readMission(missionsDir, mission.missionId);
    assert.ok(result !== null, 'Should read valid mission successfully');
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnings.length, 0, 'No warnings should be emitted for a valid mission');
});

// ==================== TC7: writeMission 写入畸形数据时 warn 但仍写入 ====================

test('TC7: writeMission blocks write for schema-invalid mission data (strict mode)', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'schema-write-test-'));

  // Construct an object that violates the schema (invalid status)
  const invalidMission = {
    missionId: 'mission-write-invalid-001',
    title: 'Invalid Mission',
    goal: 'Test writeMission strict behavior',
    status: 'NOT_A_REAL_STATUS' as never,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Mission;

  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };

  let writeResult: boolean;
  try {
    writeResult = writeMission(missionsDir, invalidMission);
  } finally {
    console.error = origError;
  }

  // Should block the write (strict mode)
  assert.equal(writeResult, false, 'writeMission should return false for invalid data');

  // File should NOT exist on disk
  assert.equal(
    existsSync(join(missionsDir, invalidMission.missionId, 'mission.json')),
    false,
    'mission.json should not have been written',
  );

  // Should emit an error
  assert.ok(errors.length > 0, 'Should have emitted at least one error');
  assert.ok(
    errors.some((e) => e.includes('[ERROR]') && e.includes(invalidMission.missionId)),
    `Error should mention mission ID. Got: ${errors.join(', ')}`,
  );
});

test('TC7b: writeMission does not warn for valid mission data', () => {
  const mission = makeValidMission({ missionId: 'mission-write-valid-001' });
  const missionsDir = mkdtempSync(join(tmpdir(), 'schema-write-valid-'));

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

  let writeResult: boolean;
  try {
    writeResult = writeMission(missionsDir, mission);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(writeResult, true);
  assert.equal(warnings.length, 0, 'No warnings should be emitted for a valid mission');
});
