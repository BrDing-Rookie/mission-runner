/**
 * Mission Runner 核心类型定义
 * 对应 schemas/*.schema.json 的 TypeScript 类型
 *
 * TODO(Phase 2): 与 Zod schema 整合做运行时校验
 */

// ==================== Mission Status ====================

export type MissionStatus =
  | 'CREATED'
  | 'PLANNED'
  | 'RUNNING'
  | 'WAITING_BACKGROUND'
  | 'WAITING_EXTERNAL'
  | 'VERIFYING'
  | 'ITERATING'
  | 'BLOCKED_HIGH_RISK'
  | 'ESCALATED'
  | 'FAILED'
  | 'COMPLETED';

/** 终态列表：这些状态的任务不再需要 watchdog 处理 */
export const TERMINAL_STATUSES: MissionStatus[] = [
  'COMPLETED',
  'FAILED',
  'ESCALATED',
];

/** 活跃状态列表：需要 watchdog 持续监控 */
export const ACTIVE_STATUSES: MissionStatus[] = [
  'CREATED',
  'PLANNED',
  'RUNNING',
  'WAITING_BACKGROUND',
  'WAITING_EXTERNAL',
  'VERIFYING',
  'ITERATING',
  'BLOCKED_HIGH_RISK',
];

// ==================== Task Status ====================

export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_BACKGROUND'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export type TaskType =
  | 'research'
  | 'analysis'
  | 'code'
  | 'document'
  | 'review'
  | 'test'
  | 'deploy'
  | 'verification'
  | 'notification'
  | 'external_wait';

// ==================== Verification ====================

export type VerificationStatus =
  | 'PENDING'
  | 'PASS'
  | 'RETRYABLE_GAP'
  | 'NONRETRYABLE_FAILURE'
  | 'NEEDS_HUMAN_DECISION';

export type EscalationLevel = 'INFO' | 'WARNING' | 'CRITICAL' | null;

// ==================== Core Interfaces ====================

export interface MissionOwner {
  sessionKey: string;
  channel?: 'discord' | 'slack' | 'cli' | 'web' | 'api';
  chatId?: string;               // 群聊 ID（Discord guild/channel, Slack channel 等）
  requestMessageId?: string;
  userMentionTag?: string;        // 用户在渠道内的 @mention 标记
}

export interface CompletionCriterion {
  id: string;
  description: string;
  required?: boolean;
  verified?: boolean;
}

export interface RiskPolicy {
  autoAllowed?: string[];
  askOnce?: string[];
  mustConfirm?: string[];
}

export interface Task {
  taskId: string;
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  agent?: string | null;
  sessionKey?: string | null;
  dependsOn?: string[];
  priority?: number;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  estimatedDuration?: number | null;
  timeout?: number | null;
  resultSummary?: string | null;
  artifacts?: TaskArtifact[];
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
  backgroundProcessId?: string | null;
  config?: Record<string, unknown>;
}

export interface TaskArtifact {
  path: string;
  type: string;
  description?: string;
}

export interface MissionArtifact {
  path: string;
  type: 'document' | 'code' | 'data' | 'image' | 'log' | 'summary';
  description?: string;
  generatedAt?: string;
}

export interface BackgroundProcess {
  processId: string;
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  startedAt: string;
  endedAt?: string | null;
  outputPath?: string | null;
}

export interface ActiveSession {
  sessionKey: string;
  agentType?: string;
  startedAt?: string;
  purpose?: string;
}

export interface VerificationCriterionResult {
  criterionId: string;
  passed: boolean;
  reason?: string | null;
}

export interface Verification {
  status: VerificationStatus;
  lastCheckedAt?: string | null;
  gaps?: string[];
  summary?: string | null;
  criteriaResults?: VerificationCriterionResult[];
}

export interface Escalation {
  level?: EscalationLevel;
  reason?: string | null;
  escalatedAt?: string | null;
}

export interface MissionFlags {
  notifiedStart?: boolean;
  notifiedComplete?: boolean;
  notifiedEscalation?: boolean;
  userUpdated?: boolean;
  notifiedTransitions?: Record<string, boolean>;  // 幂等去重：key 如 "PLANNED->RUNNING" 或 "task:T1:READY->RUNNING"
}

/**
 * 核心 Mission 数据结构
 * 对应 mission.schema.json
 */
export interface Mission {
  missionId: string;
  title: string;
  goal: string;
  status: MissionStatus;
  owner?: MissionOwner;
  createdAt: string;
  updatedAt: string;
  lastProgressAt?: string;
  nextWakeAt?: string | null;
  currentIteration?: number;
  maxIterations?: number;
  completionCriteria?: CompletionCriterion[];
  riskPolicy?: RiskPolicy;
  tasks?: Task[];
  artifacts?: MissionArtifact[];
  backgroundProcesses?: BackgroundProcess[];
  activeSessions?: ActiveSession[];
  verification?: Verification;
  escalation?: Escalation;
  flags?: MissionFlags;
  metadata?: Record<string, unknown>;
}

// ==================== Watchdog Types ====================

/** Watchdog 检查结果的分类 */
export type MissionAction =
  | 'NONE'
  | 'CHECK_BACKGROUND'
  | 'RESUME_TASK'
  | 'TRIGGER_VERIFY'
  | 'RETRY_TASK'
  | 'ITERATE'
  | 'ESCALATE_STUCK'
  | 'ESCALATE_MAX_RETRY'
  | 'NOTIFY_COMPLETE'
  | 'NOTIFY_ESCALATION';

export interface WatchdogCheckResult {
  missionId: string;
  currentStatus: MissionStatus;
  action: MissionAction;
  reason: string;
  /** 建议的下次检查时间 */
  suggestedNextWakeAt?: string;
  /** 相关任务IDs */
  relatedTaskIds?: string[];
  /** 额外上下文信息 */
  context?: Record<string, unknown>;
}

/** Watchdog 配置选项 */
export interface WatchdogConfig {
  /** 扫描的 missions 目录路径 */
  missionsDir: string;
  /** 任务超时阈值（毫秒），默认 5 分钟 */
  taskTimeoutMs: number;
  /** 后台进程检查间隔（毫秒），默认 30 秒 */
  backgroundCheckIntervalMs: number;
  /** 最大允许的空转时间（毫秒），默认 10 分钟 */
  maxIdleTimeMs: number;
  /** 是否 dry-run 模式 */
  dryRun: boolean;
  /** 详细日志 */
  verbose: boolean;
}

/** 默认配置 */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  missionsDir: './missions',
  taskTimeoutMs: 5 * 60 * 1000, // 5 minutes
  backgroundCheckIntervalMs: 30 * 1000, // 30 seconds
  maxIdleTimeMs: 10 * 60 * 1000, // 10 minutes
  dryRun: false,
  verbose: false,
};

// ==================== State Transition ====================

/** 状态迁移函数类型 - 用于 Phase 2 状态机实现 */
export type StateTransition = (
  mission: Mission,
  context: { checkResult: WatchdogCheckResult; config: WatchdogConfig }
) => Promise<Mission>;

/** 允许的状态迁移映射 */
export const ALLOWED_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  CREATED: ['PLANNED', 'FAILED'],
  PLANNED: ['RUNNING', 'FAILED'],
  RUNNING: ['WAITING_BACKGROUND', 'WAITING_EXTERNAL', 'VERIFYING', 'BLOCKED_HIGH_RISK', 'ITERATING', 'FAILED'],
  WAITING_BACKGROUND: ['RUNNING', 'VERIFYING', 'FAILED'],
  WAITING_EXTERNAL: ['RUNNING', 'VERIFYING', 'FAILED'],
  VERIFYING: ['COMPLETED', 'ITERATING', 'BLOCKED_HIGH_RISK', 'ESCALATED', 'FAILED'],
  ITERATING: ['RUNNING', 'FAILED'],
  BLOCKED_HIGH_RISK: ['RUNNING', 'ESCALATED', 'FAILED'],
  ESCALATED: ['RUNNING', 'FAILED', 'COMPLETED'], // 人工介入后可恢复
  FAILED: [], // 终态
  COMPLETED: [], // 终态
};

/**
 * 检查状态迁移是否允许
 */
export function isTransitionAllowed(
  from: MissionStatus,
  to: MissionStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
