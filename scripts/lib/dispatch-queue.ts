/**
 * dispatch-queue.ts — Dispatch queue fallback (Level 3)
 *
 * When Level 1 (mention) and Level 2 (create session + mention) both fail,
 * write a queue entry to disk for the orchestrator to pick up via sessions_spawn.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Task } from './types.ts';

const HOME = process.env.HOME ?? '/home/ubuntu';

/**
 * 获取 dispatch queue 目录路径。
 * P1 修复：基于 missionsDir 而非硬编码 HOME 路径。
 */
export function getDispatchQueueDir(missionsDir?: string): string {
  if (missionsDir) {
    return join(missionsDir, '.dispatch-queue');
  }
  return join(HOME, '.openclaw/extensions/mission-runner/dispatch-queue');
}

/**
 * sessions_spawn 兜底派发 — 仅当 Level 1 和 Level 2 均失败时使用。
 *
 * 写入 dispatch queue 文件，由 orchestrator 异步拾取执行。
 *
 * @param task - 待派发的 task
 * @param missionId - 所属 mission ID
 * @param missionsDir - missions 目录路径（可选，用于确定 queue 目录）
 * @returns queue file path on success, null on failure
 */
export function spawnFallback(task: Task, missionId: string, missionsDir?: string): string | null {
  console.log(`[dispatch-queue] spawnFallback: writing dispatch queue entry | taskId=${task.taskId}`);

  const agentId = task.agent ?? (task.config?.agentId as string | undefined) ?? '';
  const queueEntry = {
    taskId: task.taskId,
    missionId,
    agentId,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    queuedAt: new Date().toISOString(),
    status: 'pending',
  };

  const queueDir = getDispatchQueueDir(missionsDir);
  const queueFile = join(queueDir, `${missionId}-${task.taskId}.json`);

  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(queueFile, JSON.stringify(queueEntry, null, 2), 'utf-8');
    console.log(`[dispatch-queue] spawnFallback: queued to ${queueFile}`);
    return queueFile;
  } catch (err) {
    console.error(`[dispatch-queue] spawnFallback failed: ${err}`);
    return null;
  }
}
