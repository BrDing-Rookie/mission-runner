/**
 * orchestration-service.ts — Mission Runner 编排服务
 *
 * 事件驱动的长期运行服务，替代 cron + orchestrate --auto 轮询模式。
 * 通过订阅 MissionEventBus 事件来实时响应 mission 状态变更。
 *
 * 支持通过 MISSION_POLLING_FALLBACK=true 环境变量回退到轮询模式。
 */

import { listMissionIds, readMission } from './fs-utils.ts';
import { main as runActionMain } from '../mission-run-action.ts';
import { main as dispatchMain } from '../mission-dispatch.ts';
import { evaluateMission } from '../mission-watchdog-lib.ts';
import { DEFAULT_WATCHDOG_CONFIG, TERMINAL_STATUSES, type MissionStatus, type WatchdogConfig } from './types.ts';
import type { MissionEventBus } from './event-bus.ts';

// ==================== Service Interface ====================

export interface OrchestrationService {
  name: string;
  description: string;
  /** 启动服务：加载活跃 mission 状态，开始监听事件 */
  start(): Promise<void>;
  /** 停止服务：清理 interval，取消所有事件订阅 */
  stop(): Promise<void>;
}

// ==================== Internal Types ====================

interface ActiveMissionState {
  missionId: string;
  status: MissionStatus;
  lastCheckedAt: number;
}

interface ServiceState {
  activeMissions: Map<string, ActiveMissionState>;
  started: boolean;
  startedAt: number | null;
  healthCheckCount: number;
  eventsHandled: number;
}

// ==================== Constants ====================

/** 健康检查间隔：5 分钟（兜底处理遗漏事件） */
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** 轮询回退间隔：30 秒 */
const POLLING_FALLBACK_INTERVAL_MS = 30 * 1000;

/** 最大 orchestrate 步数 */
const DEFAULT_MAX_STEPS = 3;

// ==================== Helpers ====================

function buildWatchdogConfig(missionsDir: string): WatchdogConfig {
  return { ...DEFAULT_WATCHDOG_CONFIG, missionsDir, dryRun: false };
}

/**
 * 静默执行 main 函数，捕获 console.log 输出，不影响外部日志。
 * 支持同步和异步 main 函数。
 */
async function runSilentAsync(fn: () => number | Promise<number>): Promise<{ exitCode: number; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    const result = fn();
    const exitCode = result instanceof Promise ? await result : result;
    return { exitCode, logs };
  } finally {
    console.log = originalLog;
  }
}

/**
 * 对单个 mission 执行 watchdog 评估并根据结果触发 action。
 * 不抛出异常，返回是否有进展。
 */
async function advanceMission(missionsDir: string, missionId: string): Promise<boolean> {
  const mission = readMission(missionsDir, missionId);
  if (!mission) return false;
  if (TERMINAL_STATUSES.includes(mission.status)) return false;

  const config = buildWatchdogConfig(missionsDir);
  const decision = evaluateMission(mission, config, Date.now());

  if (decision.action === 'NONE') return false;

  const actionableActions = new Set([
    'CHECK_BACKGROUND',
    'COLLECT_RESULTS',
    'TRIGGER_VERIFY',
    'RESUME_TASK',
    'RETRY_TASK',
    'ESCALATE_STUCK',
    'ESCALATE_MAX_RETRY',
    'NOTIFY_COMPLETE',
    'NOTIFY_ESCALATION',
  ]);

  let progressed = false;

  if (actionableActions.has(decision.action)) {
    const actionArgv = [
      '--missions-dir', missionsDir,
      '--mission-id', missionId,
      '--action', decision.action,
    ];
    if (decision.relatedTaskIds && decision.relatedTaskIds.length > 0) {
      actionArgv.push('--task-ids', decision.relatedTaskIds.join(','));
    }
    const { exitCode } = await runSilentAsync(() =>
      runActionMain(actionArgv)
    );
    if (exitCode !== 0) {
      console.error(`[orchestration-service] action failed | missionId=${missionId} | action=${decision.action} | exitCode=${exitCode}`);
      return false;
    }
    progressed = true;
    console.log(`[orchestration-service] action executed | missionId=${missionId} | action=${decision.action}`);
  }

  // 检查是否有 READY task 需要派发
  const postMission = readMission(missionsDir, missionId) ?? mission;
  const readyTasks = (postMission.tasks ?? []).filter((t) => t.status === 'READY');
  const dispatchableStatuses = new Set(['PLANNED', 'RUNNING', 'ITERATING', 'WAITING_EXTERNAL']);

  if (readyTasks.length > 0 && dispatchableStatuses.has(postMission.status)) {
    const { exitCode } = await runSilentAsync(() =>
      dispatchMain([
        '--missions-dir', missionsDir,
        '--mission-id', missionId,
      ])
    );
    if (exitCode === 0) {
      progressed = true;
      console.log(`[orchestration-service] dispatch executed | missionId=${missionId} | readyTasks=${readyTasks.length}`);
    } else {
      console.error(`[orchestration-service] dispatch failed | missionId=${missionId} | exitCode=${exitCode}`);
    }
  }

  return progressed;
}

// ==================== Factory Function ====================

/**
 * 创建 Orchestration Service 实例。
 *
 * @param missionsDir missions 目录路径
 * @param eventBus 内部事件总线
 * @returns OrchestrationService 实例
 */
export function createOrchestrationService(
  missionsDir: string,
  eventBus: MissionEventBus
): OrchestrationService {
  const state: ServiceState = {
    activeMissions: new Map(),
    started: false,
    startedAt: null,
    healthCheckCount: 0,
    eventsHandled: 0,
  };

  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;

  // 取消订阅函数列表
  const unsubscribers: Array<() => void> = [];

  const isPollingFallback = process.env['MISSION_POLLING_FALLBACK'] === 'true';

  // ── Internal: Load active missions ────────────────────────────────────────

  function loadActiveMissions(): void {
    const ids = listMissionIds(missionsDir);
    state.activeMissions.clear();

    for (const missionId of ids) {
      const mission = readMission(missionsDir, missionId);
      if (!mission) continue;
      if (TERMINAL_STATUSES.includes(mission.status)) continue;

      state.activeMissions.set(missionId, {
        missionId,
        status: mission.status,
        lastCheckedAt: Date.now(),
      });
    }

    console.log(`[orchestration-service] loaded ${state.activeMissions.size} active missions`);
  }

  // ── Internal: Handle mission event ────────────────────────────────────────

  function handleMissionEvent(missionId: string, reason: string): void {
    state.eventsHandled += 1;
    console.log(`[orchestration-service] event received | missionId=${missionId} | reason=${reason}`);

    // Fire-and-forget async chain with error capture
    (async () => {
      try {
        let steps = 0;
        while (steps < DEFAULT_MAX_STEPS) {
          const progressed = await advanceMission(missionsDir, missionId);
          steps += 1;
          if (!progressed) break;
        }

        // 刷新 activeMissions 缓存
        const updated = readMission(missionsDir, missionId);
        if (updated && !TERMINAL_STATUSES.includes(updated.status)) {
          state.activeMissions.set(missionId, {
            missionId,
            status: updated.status,
            lastCheckedAt: Date.now(),
          });
        } else {
          state.activeMissions.delete(missionId);
        }
      } catch (err) {
        console.error(`[orchestration-service] event handler error | missionId=${missionId} | ${(err as Error)?.message ?? err}`);
      }
    })();
  }

  // ── Internal: Health check ─────────────────────────────────────────────────

  function runHealthCheck(): void {
    state.healthCheckCount += 1;
    console.log(`[orchestration-service] health check #${state.healthCheckCount} | activeMissions=${state.activeMissions.size}`);

    // 重新扫描所有活跃 mission（兜底处理遗漏事件）
    loadActiveMissions();

    for (const [missionId] of state.activeMissions) {
      advanceMission(missionsDir, missionId).catch((err: unknown) => {
        console.error(`[orchestration-service] health check error | missionId=${missionId} | ${(err as Error)?.message ?? err}`);
      });
    }
  }

  // ── Internal: Polling fallback ─────────────────────────────────────────────

  function runPollingRound(): void {
    loadActiveMissions();

    for (const [missionId] of state.activeMissions) {
      advanceMission(missionsDir, missionId).catch((err: unknown) => {
        console.error(`[orchestration-service] polling error | missionId=${missionId} | ${(err as Error)?.message ?? err}`);
      });
    }
  }

  // ── Service object ────────────────────────────────────────────────────────

  return {
    name: 'mission-orchestrator',
    description: 'Mission state machine orchestration service (event-driven + health-check fallback)',

    async start(): Promise<void> {
      if (state.started) {
        console.warn('[orchestration-service] already started, ignoring duplicate start()');
        return;
      }

      state.started = true;
      state.startedAt = Date.now();

      console.log(`[orchestration-service] starting | pollingFallback=${isPollingFallback}`);

      // 1. 加载所有活跃 mission 状态
      loadActiveMissions();

      if (isPollingFallback) {
        // ── 轮询回退模式 ───────────────────────────────────────────────────
        console.log(`[orchestration-service] polling fallback mode | intervalMs=${POLLING_FALLBACK_INTERVAL_MS}`);
        pollingTimer = setInterval(() => runPollingRound(), POLLING_FALLBACK_INTERVAL_MS);
        // 立即执行一轮
        runPollingRound();
      } else {
        // ── 事件驱动模式 ───────────────────────────────────────────────────

        // 2. 订阅 task:completed → 推进 mission 状态机
        const unsubTaskCompleted = eventBus.on('task:completed', (event) => {
          handleMissionEvent(event.missionId, `task:completed taskId=${event.taskId}`);
        });
        unsubscribers.push(unsubTaskCompleted);

        // 3. 订阅 task:failed → 检查是否可重试或需要上报
        const unsubTaskFailed = eventBus.on('task:failed', (event) => {
          handleMissionEvent(event.missionId, `task:failed taskId=${event.taskId}`);
        });
        unsubscribers.push(unsubTaskFailed);

        // 4. 订阅 mission:state-changed → 刷新内部缓存
        const unsubStateChanged = eventBus.on('mission:state-changed', (event) => {
          const { missionId, to } = event;
          if (TERMINAL_STATUSES.includes(to)) {
            state.activeMissions.delete(missionId);
            console.log(`[orchestration-service] mission reached terminal state | missionId=${missionId} | status=${to}`);
          } else {
            const existing = state.activeMissions.get(missionId);
            if (existing) {
              existing.status = to;
              existing.lastCheckedAt = Date.now();
            } else {
              state.activeMissions.set(missionId, {
                missionId,
                status: to,
                lastCheckedAt: Date.now(),
              });
            }
          }
        });
        unsubscribers.push(unsubStateChanged);

        // 5. 订阅 agent:session-ended → 触发 reconcile（如未被 hook 直接处理）
        const unsubSessionEnded = eventBus.on('agent:session-ended', (_event) => {
          // sessionKey 到 missionId 的查找已在 event-hooks.ts 的 subagent_ended hook 中处理
          // 此处作为二次兜底：重新扫描所有 WAITING_BACKGROUND mission
          for (const [missionId, missionState] of state.activeMissions) {
            if (missionState.status === 'WAITING_BACKGROUND') {
              handleMissionEvent(missionId, 'agent:session-ended fallback check');
            }
          }
        });
        unsubscribers.push(unsubSessionEnded);

        // 6. 启动低频健康检查（5 分钟兜底）
        healthCheckTimer = setInterval(() => runHealthCheck(), HEALTH_CHECK_INTERVAL_MS);

        console.log(`[orchestration-service] started | subscriptions=${unsubscribers.length} | healthCheckIntervalMs=${HEALTH_CHECK_INTERVAL_MS}`);
      }
    },

    async stop(): Promise<void> {
      if (!state.started) {
        console.warn('[orchestration-service] not started, ignoring stop()');
        return;
      }

      console.log(`[orchestration-service] stopping | eventsHandled=${state.eventsHandled} | healthChecks=${state.healthCheckCount}`);

      // 清理定时器
      if (healthCheckTimer !== null) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
      }

      if (pollingTimer !== null) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }

      // 取消所有事件订阅
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;

      state.started = false;
      state.activeMissions.clear();

      console.log('[orchestration-service] stopped');
    },
  };
}
