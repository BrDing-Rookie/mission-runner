/**
 * Mission Runner Agent Guardrails
 * 提供 dispatch 前和执行后的安全边界检查
 *
 * TODO(Phase 4): 将 validatePreDispatch 集成到 mission-dispatch.ts 流程中
 * TODO(Phase 4): 将 validatePostExecution 集成到 task-update.ts / mission-reconcile-background.ts 流程中
 * TODO(Phase 4): 实现 allowedFiles / deniedFiles 的 glob 匹配检查（validatePostExecution 中对 artifacts path）
 */

import type { Task } from './types.ts';

export interface GuardrailViolation {
  rule: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface GuardrailCheckResult {
  ok: boolean;
  violations: GuardrailViolation[];
}

/**
 * Dispatch 前检查：确认 task 可以被派发执行
 * - maxRetries: retryCount 是否已达上限
 */
export function validatePreDispatch(task: Task): GuardrailCheckResult {
  const violations: GuardrailViolation[] = [];
  const g = task.guardrails;

  if (!g) return { ok: true, violations: [] };

  // Check maxRetries
  if (g.maxRetries !== undefined && (task.retryCount ?? 0) >= g.maxRetries) {
    violations.push({
      rule: 'maxRetries',
      message: `Task ${task.taskId} has reached retry limit: ${task.retryCount ?? 0} >= ${g.maxRetries}`,
      severity: 'error',
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 执行完成后检查：审计 task 执行结果是否符合 guardrails
 * - maxDurationMs: 执行时长是否超限
 * - maxOutputTokens: 输出 token 是否超限
 * - requireArtifacts: 必要产物是否齐全
 */
export function validatePostExecution(task: Task): GuardrailCheckResult {
  const violations: GuardrailViolation[] = [];
  const g = task.guardrails;

  if (!g) return { ok: true, violations: [] };

  // Check maxDurationMs
  if (g.maxDurationMs !== undefined && task.startedAt && task.endedAt) {
    const durationMs = new Date(task.endedAt).getTime() - new Date(task.startedAt).getTime();
    if (durationMs > g.maxDurationMs) {
      violations.push({
        rule: 'maxDurationMs',
        message: `Task ${task.taskId} exceeded max duration: ${durationMs}ms > ${g.maxDurationMs}ms`,
        severity: 'warning',
      });
    }
  }

  // Check maxOutputTokens
  if (g.maxOutputTokens !== undefined && task.usage?.outputTokens !== undefined) {
    if (task.usage.outputTokens > g.maxOutputTokens) {
      violations.push({
        rule: 'maxOutputTokens',
        message: `Task ${task.taskId} exceeded output token limit: ${task.usage.outputTokens} > ${g.maxOutputTokens}`,
        severity: 'warning',
      });
    }
  }

  // Check requireArtifacts
  if (g.requireArtifacts && g.requireArtifacts.length > 0) {
    const artifactTypes = (task.artifacts ?? []).map((a) => a.type);
    for (const required of g.requireArtifacts) {
      if (!artifactTypes.includes(required)) {
        violations.push({
          rule: 'requireArtifacts',
          message: `Task ${task.taskId} missing required artifact type: ${required}`,
          severity: 'error',
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 格式化 violations 为可读字符串，用于写入 lastError 或 events
 */
export function formatViolations(result: GuardrailCheckResult): string {
  if (result.ok) return '';
  return result.violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}`).join('; ');
}
