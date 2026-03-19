/**
 * 文件系统工具函数
 * 用于安全地读写 mission 工件
 *
 * TODO(Phase 2): 考虑添加文件锁机制防止并发冲突
 * TODO(Phase 3): 考虑添加与 OpenClaw runtime 的集成
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Mission } from './types.ts';

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
 * 读取 mission.json
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
    return JSON.parse(content) as Mission;
  } catch (error) {
    console.error(`[ERROR] Failed to read mission ${missionId}:`, error);
    return null;
  }
}

/**
 * 写入 mission.json
 * @param missionsDir missions 根目录
 * @param mission Mission 对象
 * @returns 是否成功
 */
export function writeMission(missionsDir: string, mission: Mission): boolean {
  const missionDir = join(missionsDir, mission.missionId);
  const missionPath = join(missionDir, 'mission.json');

  try {
    ensureDir(missionDir);
    writeFileSync(missionPath, JSON.stringify(mission, null, 2), 'utf-8');
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
 * 安全地写入文件
 * TODO(Phase 3): 考虑添加原子写入（先写临时文件再重命名）
 */
export function safeWriteFile(filePath: string, content: string): boolean {
  try {
    ensureDir(dirname(filePath));
    writeFileSync(filePath, content, 'utf-8');
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
