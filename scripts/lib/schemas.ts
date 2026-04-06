/**
 * Zod 运行时校验 Schema
 * 对应 types.ts 中的核心接口定义
 *
 * 设计决策:
 * - 所有 object schema 使用 .passthrough()，允许未知字段通过，保持向前兼容性
 * - readMission 校验失败抛出异常，writeMission 校验失败阻止写入（strict 模式）
 */

import { z } from 'zod';
import type { Mission } from './types.ts';

// ==================== Status Enums ====================

export const MissionStatusSchema = z.enum([
  'CREATED',
  'PLANNED',
  'RUNNING',
  'WAITING_BACKGROUND',
  'WAITING_EXTERNAL',
  'VERIFYING',
  'ITERATING',
  'BLOCKED_HIGH_RISK',
  'ESCALATED',
  'FAILED',
  'COMPLETED',
]);

export const TaskStatusSchema = z.enum([
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING_BACKGROUND',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
]);

export const TaskTypeSchema = z.enum([
  'research',
  'analysis',
  'code',
  'document',
  'review',
  'test',
  'deploy',
  'verification',
  'notification',
  'external_wait',
]);

export const VerificationStatusSchema = z.enum([
  'PENDING',
  'PASS',
  'RETRYABLE_GAP',
  'NONRETRYABLE_FAILURE',
  'NEEDS_HUMAN_DECISION',
]);

export const EscalationLevelSchema = z.enum(['INFO', 'WARNING', 'CRITICAL']).nullable();

// ==================== Nested Type Schemas ====================

export const MissionOwnerSchema = z.object({
  sessionKey: z.string(),
  channel: z.enum(['discord', 'slack', 'cli', 'web', 'api']).optional(),
  chatId: z.string().optional(),
  requestMessageId: z.string().optional(),
  userMentionTag: z.string().optional(),
}).passthrough();

export const CompletionCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  required: z.boolean().optional(),
  verified: z.boolean().optional(),
}).passthrough();

export const RiskPolicySchema = z.object({
  autoAllowed: z.array(z.string()).optional(),
  askOnce: z.array(z.string()).optional(),
  mustConfirm: z.array(z.string()).optional(),
}).passthrough();

export const TaskArtifactSchema = z.object({
  path: z.string(),
  type: z.string(),
  description: z.string().optional(),
}).passthrough();

export const MissionArtifactSchema = z.object({
  path: z.string(),
  type: z.enum(['document', 'code', 'data', 'image', 'log', 'summary']),
  description: z.string().optional(),
  generatedAt: z.string().optional(),
}).passthrough();

export const BackgroundProcessSchema = z.object({
  processId: z.string(),
  taskId: z.string(),
  status: z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT']),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  outputPath: z.string().nullable().optional(),
}).passthrough();

export const ActiveSessionSchema = z.object({
  sessionKey: z.string(),
  agentType: z.string().optional(),
  startedAt: z.string().optional(),
  purpose: z.string().optional(),
}).passthrough();

export const VerificationCriterionResultSchema = z.object({
  criterionId: z.string(),
  passed: z.boolean(),
  reason: z.string().nullable().optional(),
}).passthrough();

export const VerificationSchema = z.object({
  status: VerificationStatusSchema,
  lastCheckedAt: z.string().nullable().optional(),
  gaps: z.array(z.string()).optional(),
  summary: z.string().nullable().optional(),
  criteriaResults: z.array(VerificationCriterionResultSchema).optional(),
}).passthrough();

export const EscalationSchema = z.object({
  level: EscalationLevelSchema.optional(),
  reason: z.string().nullable().optional(),
  escalatedAt: z.string().nullable().optional(),
}).passthrough();

export const MissionFlagsSchema = z.object({
  notifiedStart: z.boolean().optional(),
  notifiedComplete: z.boolean().optional(),
  notifiedEscalation: z.boolean().optional(),
  userUpdated: z.boolean().optional(),
  notifiedTransitions: z.record(z.string(), z.boolean()).optional(),
}).passthrough();

// ==================== Task Schema ====================

export const TaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: TaskTypeSchema,
  status: TaskStatusSchema,
  agent: z.string().nullable().optional(),
  sessionKey: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  priority: z.number().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  estimatedDuration: z.number().nullable().optional(),
  timeout: z.number().nullable().optional(),
  resultSummary: z.string().nullable().optional(),
  artifacts: z.array(TaskArtifactSchema).optional(),
  retryCount: z.number().optional(),
  maxRetries: z.number().optional(),
  lastError: z.string().nullable().optional(),
  backgroundProcessId: z.string().nullable().optional(),
  phase: z.string().optional(),
  fileBoundary: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ==================== Mission Schema ====================

export const MissionSchema = z.object({
  missionId: z.string(),
  title: z.string(),
  goal: z.string(),
  status: MissionStatusSchema,
  owner: MissionOwnerSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastProgressAt: z.string().optional(),
  nextWakeAt: z.string().nullable().optional(),
  currentIteration: z.number().optional(),
  maxIterations: z.number().optional(),
  completionCriteria: z.array(CompletionCriterionSchema).optional(),
  riskPolicy: RiskPolicySchema.optional(),
  tasks: z.array(TaskSchema).optional(),
  artifacts: z.array(MissionArtifactSchema).optional(),
  backgroundProcesses: z.array(BackgroundProcessSchema).optional(),
  activeSessions: z.array(ActiveSessionSchema).optional(),
  verification: VerificationSchema.optional(),
  escalation: EscalationSchema.optional(),
  flags: MissionFlagsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ==================== validateMission 辅助函数 ====================

/**
 * 校验 mission 数据
 * @param data 待校验的原始数据
 * @returns success + mission（成功时）或 errors（失败时）
 */
export function validateMission(data: unknown): {
  success: boolean;
  mission?: Mission;
  errors?: string[];
} {
  const result = MissionSchema.safeParse(data);

  if (result.success) {
    return { success: true, mission: result.data as Mission };
  }

  const errors = result.error.errors.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
  );

  return { success: false, errors };
}
