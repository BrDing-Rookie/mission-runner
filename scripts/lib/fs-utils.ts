/**
 * 文件系统工具函数
 * 用于安全地读写 mission 工件
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Mission } from './types.ts';
import { MissionSchema } from './schemas.ts';

/**
 * 原子写入文件：先写临时文件，再用 renameSync 替换目标文件
 * rename 在同一文件系统上是 POSIX 原子操作，保证不会产生半写文件
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * 确保目录存在
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 列出所有 mission 目录
 * @param missionsDir missions 根目录
 * @returns mission ID 列表
 */
export function listMissionIds(missionsDir: string): string[] {
  if (!existsSync(missionsDir)) {
    return [];
  }

  return readdirSync(missionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('mission-'))
    .map((d) => d.name);
}

/**
 * 读取 mission.json（strict 模式：校验失败抛出异常）
 * @param missionsDir missions 根目录
 * @param missionId mission ID
 * @returns Mission 对象或 null
 */
export function readMission(missionsDir: string, missionId: string): Mission | null {
  const missionPath = join(missionsDir, missionId, 'mission.json');

  if (!existsSync(missionPath)) {
    return null;
  }

  try {
    const content = readFileSync(missionPath, 'utf-8');
    const parsed = JSON.parse(content);
    const validation = MissionSchema.safeParse(parsed);
    if (!validation.success) {
      const errorDetails = validation.error.errors
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Mission ${missionId} failed schema validation: ${errorDetails}`);
    }
    return validation.data as Mission;
  } catch (error) {
    if (error instanceof Error && error.message.includes('failed schema validation')) {
      throw error;  // Zod 校验失败向上抛出
    }
    console.error(`[ERROR] Failed to read mission ${missionId}:`, error);
    return null;
  }
}

/**
 * 写入 mission.json（strict 模式 + 原子写入）
 * @param missionsDir missions 根目录
 * @param mission Mission 对象
 * @returns 是否成功
 */
export function writeMission(missionsDir: string, mission: Mission): boolean {
  const missionDir = join(missionsDir, mission.missionId);
  const missionPath = join(missionDir, 'mission.json');

  try {
    const validation = MissionSchema.safeParse(mission);
    if (!validation.success) {
      const errorDetails = validation.error.errors
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      console.error(`[ERROR] Mission ${mission.missionId} schema validation failed, write blocked: ${errorDetails}`);
      return false;
    }
    ensureDir(missionDir);
    atomicWriteFileSync(missionPath, JSON.stringify(mission, null, 2));
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to write mission ${mission.missionId}:`, error);
    return false;
  }
}

/**
 * 更新 mission 时间戳
 */
export function updateMissionTimestamps(mission: Mission): Mission {
  const now = new Date().toISOString();
  return {
    ...mission,
    updatedAt: now,
  };
}

/**
 * 安全地写入文件（原子写入：先写临时文件再重命名）
 */
export function safeWriteFile(filePath: string, content: string): boolean {
  try {
    ensureDir(dirname(filePath));
    atomicWriteFileSync(filePath, content);
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to write file ${filePath}:`, error);
    return false;
  }
}

/**
 * 追加事件到 events.jsonl
 * @param missionsDir missions 根目录
 * @param missionId mission ID
 * @param event 事件对象
 */
export function appendEvent(
  missionsDir: string,
  missionId: string,
  event: Record<string, unknown>
): boolean {
  const eventsPath = join(missionsDir, missionId, 'events.jsonl');
  const line = JSON.stringify({
    ...event,
    _timestamp: new Date().toISOString(),
  });

  try {
    ensureDir(dirname(eventsPath));
    appendFileSync(eventsPath, line + '\n', 'utf-8');
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to append event for ${missionId}:`, error);
    return false;
  }
}

export function appendEventSync(
  missionsDir: string,
  missionId: string,
  event: Record<string, unknown>
): boolean {
  return appendEvent(missionsDir, missionId, event);
}

/**
 * 初始化 mission 目录结构
 */
export function initMissionDirectory(missionsDir: string, missionId: string): void {
  const missionDir = join(missionsDir, missionId);
  ensureDir(missionDir);
  ensureDir(join(missionDir, 'artifacts'));
}

// ==================== 文件锁机制 ====================

const LOCK_TIMEOUT_MS = 10_000;   // 锁超时 10 秒
const LOCK_RETRY_INTERVAL_MS = 50; // 重试间隔 50ms

export interface LockHandle {
  lockDir: string;
  release: () => void;
}

/**
 * 获取 mission 级文件锁（基于 mkdirSync 原子性）
 * @param missionsDir missions 根目录
 * @param missionId mission ID
 * @returns LockHandle 或 null（超时获取失败）
 */
export function acquireMissionLock(missionsDir: string, missionId: string): LockHandle | null {
  const lockDir = join(missionsDir, missionId, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      // 锁获取成功，写入 holder 信息用于调试和 stale lock 检测
      const holderFile = join(lockDir, 'holder.json');
      writeFileSync(
        holderFile,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
        'utf-8',
      );
      return {
        lockDir,
        release: () => {
          try {
            const hp = join(lockDir, 'holder.json');
            if (existsSync(hp)) unlinkSync(hp);
            rmdirSync(lockDir);
          } catch {
            // best-effort release
          }
        },
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // 锁已被持有，检查是否为过期锁（stale lock）
        const holderFile = join(lockDir, 'holder.json');
        try {
          const holder = JSON.parse(readFileSync(holderFile, 'utf-8')) as { pid: number; acquiredAt: string };
          const age = Date.now() - new Date(holder.acquiredAt).getTime();
          if (age > LOCK_TIMEOUT_MS) {
            console.warn(
              `[fs-utils] Breaking stale lock for ${missionId} (age=${age}ms, holder pid=${holder.pid})`,
            );
            try { unlinkSync(holderFile); } catch { /* ignore */ }
            try { rmdirSync(lockDir); } catch { /* ignore */ }
            continue; // 重试获取
          }
        } catch {
          // holder.json 读取失败，可能锁目录存在但无 holder 文件（异常状态），尝试破锁
          try { rmdirSync(lockDir); } catch { /* ignore */ }
          continue;
        }
        // 锁仍有效，等待后重试
        const sleepMs = Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now());
        if (sleepMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
        }
        continue;
      }
      // 其他非 EEXIST 错误（如权限问题）
      console.error(`[fs-utils] Failed to acquire lock for ${missionId}:`, err);
      return null;
    }
  }

  console.error(`[fs-utils] Lock timeout for ${missionId} after ${LOCK_TIMEOUT_MS}ms`);
  return null;
}

/**
 * 在文件锁保护下执行操作，确保锁始终被释放（含异常路径）
 */
export function withMissionLock<T>(
  missionsDir: string,
  missionId: string,
  fn: () => T,
): T | null {
  const lock = acquireMissionLock(missionsDir, missionId);
  if (!lock) {
    console.error(`[fs-utils] Could not acquire lock for ${missionId}, skipping operation`);
    return null;
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}
