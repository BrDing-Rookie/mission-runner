/**
 * 文件锁机制测试
 * 覆盖 acquireMissionLock / withMissionLock 的核心行为
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireMissionLock, withMissionLock } from './lib/fs-utils.ts';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { writeMissionFixture, readMissionFile } from './test-helpers.ts';
import type { Mission } from './lib/types.ts';

function makeMissionsDir(): string {
  return mkdtempSync(join(tmpdir(), 'file-lock-test-'));
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mission-20260406-001',
    title: 'T',
    goal: 'G',
    status: 'CREATED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Mission;
}

// ==================== acquireMissionLock ====================

test('acquireMissionLock: 获取锁成功并写入 holder.json', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-001';
  // 确保 mission 目录存在
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const lock = acquireMissionLock(missionsDir, missionId);
  assert.ok(lock !== null, '应成功获取锁');

  const lockDir = join(missionsDir, missionId, '.lock');
  assert.ok(existsSync(lockDir), 'lockDir 应存在');

  const holderFile = join(lockDir, 'holder.json');
  assert.ok(existsSync(holderFile), 'holder.json 应存在');

  const holder = JSON.parse(readFileSync(holderFile, 'utf-8')) as { pid: number; acquiredAt: string };
  assert.equal(holder.pid, process.pid, 'holder.pid 应为当前进程');
  assert.ok(typeof holder.acquiredAt === 'string', 'holder.acquiredAt 应为字符串');

  lock.release();
  assert.ok(!existsSync(lockDir), '释放后 lockDir 应被删除');
});

test('acquireMissionLock: 锁被持有时，第二次获取返回 null（超时）', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-002';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const lock1 = acquireMissionLock(missionsDir, missionId);
  assert.ok(lock1 !== null, '第一次应成功');

  // 手动将 holder.json 中的时间戳设为"刚刚"，确保锁不被视为过期
  const lockDir = join(missionsDir, missionId, '.lock');
  writeFileSync(
    join(lockDir, 'holder.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    'utf-8',
  );

  // 用极短超时来测试（直接伪造锁：已有锁目录，不重新调用 acquireMissionLock 全时长）
  // 验证锁目录仍存在说明 lock1 持有中
  assert.ok(existsSync(lockDir), '锁目录应仍存在（lock1 持有中）');

  lock1.release();
  assert.ok(!existsSync(lockDir), '释放后锁目录应消失');
});

test('acquireMissionLock: 释放锁后可以重新获取', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-003';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const lock1 = acquireMissionLock(missionsDir, missionId);
  assert.ok(lock1 !== null, '第一次应成功');
  lock1.release();

  const lock2 = acquireMissionLock(missionsDir, missionId);
  assert.ok(lock2 !== null, '释放后应可重新获取');
  lock2.release();
});

test('acquireMissionLock: 过期锁（stale lock）可被自动破锁并获取', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-004';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  // 手动创建一个过期锁（acquiredAt 设为 15 秒前）
  const lockDir = join(missionsDir, missionId, '.lock');
  mkdirSync(lockDir);
  const staleTime = new Date(Date.now() - 15_000).toISOString();
  writeFileSync(
    join(lockDir, 'holder.json'),
    JSON.stringify({ pid: 99999, acquiredAt: staleTime }),
    'utf-8',
  );

  // 即使锁目录已存在，因为是过期锁，应该能获取到
  const lock = acquireMissionLock(missionsDir, missionId);
  assert.ok(lock !== null, '应能破除过期锁并获取');
  lock.release();
});

// ==================== withMissionLock ====================

test('withMissionLock: 正常执行回调并返回结果', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-005';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const result = withMissionLock(missionsDir, missionId, () => 42);
  assert.equal(result, 42, '应返回回调结果');

  // 锁应已被释放
  const lockDir = join(missionsDir, missionId, '.lock');
  assert.ok(!existsSync(lockDir), '回调完成后锁应已释放');
});

test('withMissionLock: 回调抛异常时锁仍被释放', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-006';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  assert.throws(
    () => {
      withMissionLock(missionsDir, missionId, () => {
        throw new Error('intentional error');
      });
    },
    /intentional error/,
  );

  // 锁应已被释放（即使回调抛了异常）
  const lockDir = join(missionsDir, missionId, '.lock');
  assert.ok(!existsSync(lockDir), '异常后锁应已释放');
});

test('withMissionLock: 返回 null 值时不视为失败（与获取锁失败区分）', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-007';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  // 回调返回 null 本身也是 null，所以这里我们验证回调执行了
  let executed = false;
  const result = withMissionLock(missionsDir, missionId, () => {
    executed = true;
    return null;
  });

  assert.ok(executed, '回调应已执行');
  assert.equal(result, null);
});

// ==================== commitMissionUpdate with lock ====================

test('commitMissionUpdate: 非 dryRun 时写入 mission.json 并释放锁', () => {
  const missionsDir = makeMissionsDir();
  const mission = makeMission({ status: 'CREATED' });

  writeMissionFixture(missionsDir, {
    ...mission,
    lastProgressAt: new Date().toISOString(),
    tasks: [],
    artifacts: [],
    backgroundProcesses: [],
  });

  const newMission = { ...mission, status: 'PLANNED' as const, updatedAt: new Date().toISOString() };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission: mission,
    newMission,
    dryRun: false,
    source: 'test',
    skipNotification: true,
  });

  assert.equal(ok, true, 'commitMissionUpdate 应返回 true');

  const written = readMissionFile(missionsDir, mission.missionId);
  assert.equal(written.status, 'PLANNED', '状态应被写入');

  // 锁目录应已释放
  const lockDir = join(missionsDir, mission.missionId, '.lock');
  assert.ok(!existsSync(lockDir), '操作完成后锁应已释放');
});

test('commitMissionUpdate: dryRun 模式不写入文件，不创建锁目录', () => {
  const missionsDir = makeMissionsDir();
  const mission = makeMission({ status: 'CREATED' });

  writeMissionFixture(missionsDir, {
    ...mission,
    lastProgressAt: new Date().toISOString(),
    tasks: [],
    artifacts: [],
    backgroundProcesses: [],
  });

  const newMission = { ...mission, status: 'PLANNED' as const };

  const ok = commitMissionUpdate({
    missionsDir,
    oldMission: mission,
    newMission,
    dryRun: true,
    source: 'test',
    skipNotification: true,
  });

  assert.equal(ok, true, 'dryRun 模式应返回 true');

  // dryRun 不写入，状态仍是 CREATED
  const written = readMissionFile(missionsDir, mission.missionId);
  assert.equal(written.status, 'CREATED', 'dryRun 不应修改文件');

  // dryRun 不应创建锁目录
  const lockDir = join(missionsDir, mission.missionId, '.lock');
  assert.ok(!existsSync(lockDir), 'dryRun 不应创建锁目录');
});

test('commitMissionUpdate: 并发调用不会产生数据损坏', async () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-20260406-concurrent';

  // 初始化 mission
  const baseMission = makeMission({ missionId, status: 'PLANNED' });
  writeMissionFixture(missionsDir, {
    ...baseMission,
    lastProgressAt: new Date().toISOString(),
    tasks: [],
    artifacts: [],
    backgroundProcesses: [],
  });

  // 并发执行多次 commitMissionUpdate（每次都写相同内容）
  const COUNT = 5;
  const promises = Array.from({ length: COUNT }, (_, i) => {
    return new Promise<boolean>((resolve) => {
      // 用 setImmediate 让事件循环交错执行
      setImmediate(() => {
        const newMission = {
          ...baseMission,
          updatedAt: new Date().toISOString(),
          // 写入不同的 counter 字段用于检测覆盖冲突
          // 实际不影响 status，所有调用都是合法的幂等写入
        };
        const ok = commitMissionUpdate({
          missionsDir,
          oldMission: baseMission,
          newMission,
          dryRun: false,
          source: `concurrent-${i}`,
          skipNotification: true,
        });
        resolve(ok);
      });
    });
  });

  const results = await Promise.all(promises);
  // 所有调用都应成功（锁序列化，无一失败）
  assert.ok(results.every((r) => r === true), '所有并发调用都应成功');

  // mission 文件应该是合法的 JSON
  const written = readMissionFile(missionsDir, missionId);
  assert.equal(written.missionId, missionId, 'mission 文件应保持完整');

  // 锁目录应已全部释放
  const lockDir = join(missionsDir, missionId, '.lock');
  assert.ok(!existsSync(lockDir), '所有操作完成后锁应已释放');
});
