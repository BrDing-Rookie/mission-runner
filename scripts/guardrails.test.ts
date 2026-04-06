/**
 * Guardrails 测试套件
 * 覆盖 Zod Schema 校验 + validatePreDispatch + validatePostExecution + formatViolations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardrailConfigSchema, TaskSchema } from './lib/schemas.ts';
import {
  validatePreDispatch,
  validatePostExecution,
  formatViolations,
} from './lib/guardrails.ts';
import type { Task } from './lib/types.ts';

// ==================== Zod Schema 测试 ====================

test('GuardrailConfigSchema: 完整对象校验', () => {
  const result = GuardrailConfigSchema.safeParse({
    maxDurationMs: 60000,
    maxRetries: 3,
    allowedFiles: ['src/**/*.ts'],
    deniedFiles: ['secrets/**'],
    maxOutputTokens: 4096,
    requireArtifacts: ['code', 'document'],
  });
  assert.ok(result.success, `parse failed: ${JSON.stringify(result)}`);
  const data = result.data;
  assert.equal(data.maxDurationMs, 60000);
  assert.equal(data.maxRetries, 3);
  assert.deepEqual(data.allowedFiles, ['src/**/*.ts']);
  assert.deepEqual(data.deniedFiles, ['secrets/**']);
  assert.equal(data.maxOutputTokens, 4096);
  assert.deepEqual(data.requireArtifacts, ['code', 'document']);
});

test('GuardrailConfigSchema: 空对象', () => {
  const result = GuardrailConfigSchema.safeParse({});
  assert.ok(result.success);
});

test('GuardrailConfigSchema: partial — 只有部分字段', () => {
  const result = GuardrailConfigSchema.safeParse({ maxRetries: 2 });
  assert.ok(result.success);
  assert.equal(result.data.maxRetries, 2);
  assert.equal(result.data.maxDurationMs, undefined);
});

test('GuardrailConfigSchema: 非法值 — 负数 maxDurationMs', () => {
  const result = GuardrailConfigSchema.safeParse({ maxDurationMs: -1 });
  assert.ok(!result.success, 'should fail for negative maxDurationMs');
});

test('GuardrailConfigSchema: 非法值 — 负数 maxOutputTokens', () => {
  const result = GuardrailConfigSchema.safeParse({ maxOutputTokens: -100 });
  assert.ok(!result.success, 'should fail for negative maxOutputTokens');
});

test('GuardrailConfigSchema: 非法值 — 负数 maxRetries', () => {
  const result = GuardrailConfigSchema.safeParse({ maxRetries: -1 });
  assert.ok(!result.success, 'should fail for negative maxRetries');
});

test('GuardrailConfigSchema: 零值 maxRetries 合法', () => {
  const result = GuardrailConfigSchema.safeParse({ maxRetries: 0 });
  assert.ok(result.success);
  assert.equal(result.data.maxRetries, 0);
});

test('GuardrailConfigSchema: passthrough — 允许额外字段', () => {
  const result = GuardrailConfigSchema.safeParse({ maxRetries: 1, customField: 'hello' });
  assert.ok(result.success);
  assert.equal((result.data as Record<string, unknown>)['customField'], 'hello');
});

test('TaskSchema: 带 guardrails 字段的 task 校验', () => {
  const result = TaskSchema.safeParse({
    taskId: 'T1',
    title: 'Test task',
    type: 'code',
    status: 'PENDING',
    guardrails: {
      maxDurationMs: 30000,
      maxRetries: 2,
      requireArtifacts: ['code'],
    },
  });
  assert.ok(result.success, `parse failed: ${JSON.stringify(result)}`);
  assert.equal(result.data.guardrails?.maxDurationMs, 30000);
  assert.equal(result.data.guardrails?.maxRetries, 2);
});

test('TaskSchema: 无 guardrails 字段 — 向后兼容', () => {
  const result = TaskSchema.safeParse({
    taskId: 'T2',
    title: 'Legacy task',
    type: 'research',
    status: 'PENDING',
  });
  assert.ok(result.success);
  assert.equal(result.data.guardrails, undefined);
});

test('TaskSchema: 带 usage 字段的 task 校验', () => {
  const result = TaskSchema.safeParse({
    taskId: 'T3',
    title: 'Task with usage',
    type: 'code',
    status: 'COMPLETED',
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  });
  assert.ok(result.success);
  assert.equal(result.data.usage?.outputTokens, 200);
});

// ==================== validatePreDispatch 测试 ====================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'T1',
    title: 'Test task',
    type: 'code',
    status: 'READY',
    ...overrides,
  };
}

test('validatePreDispatch: 无 guardrails 的 task → ok', () => {
  const task = makeTask();
  const result = validatePreDispatch(task);
  assert.ok(result.ok);
  assert.equal(result.violations.length, 0);
});

test('validatePreDispatch: retryCount < maxRetries → ok', () => {
  const task = makeTask({
    retryCount: 1,
    guardrails: { maxRetries: 3 },
  });
  const result = validatePreDispatch(task);
  assert.ok(result.ok);
  assert.equal(result.violations.length, 0);
});

test('validatePreDispatch: retryCount >= maxRetries → violation error', () => {
  const task = makeTask({
    retryCount: 3,
    guardrails: { maxRetries: 3 },
  });
  const result = validatePreDispatch(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, 'maxRetries');
  assert.equal(result.violations[0].severity, 'error');
});

test('validatePreDispatch: retryCount 未设置（默认 0）→ ok when maxRetries > 0', () => {
  const task = makeTask({
    guardrails: { maxRetries: 2 },
  });
  const result = validatePreDispatch(task);
  assert.ok(result.ok);
});

test('validatePreDispatch: maxRetries = 0 → 第一次就阻止（retryCount 默认 0）', () => {
  const task = makeTask({
    guardrails: { maxRetries: 0 },
  });
  const result = validatePreDispatch(task);
  assert.ok(!result.ok);
  assert.equal(result.violations[0].rule, 'maxRetries');
  assert.equal(result.violations[0].severity, 'error');
});

test('validatePreDispatch: retryCount 超出 maxRetries → violation', () => {
  const task = makeTask({
    retryCount: 5,
    guardrails: { maxRetries: 2 },
  });
  const result = validatePreDispatch(task);
  assert.ok(!result.ok);
});

// ==================== validatePostExecution 测试 ====================

test('validatePostExecution: 无 guardrails → ok', () => {
  const task = makeTask({ status: 'COMPLETED' });
  const result = validatePostExecution(task);
  assert.ok(result.ok);
  assert.equal(result.violations.length, 0);
});

test('validatePostExecution: 执行时间在限制内 → ok', () => {
  const task = makeTask({
    startedAt: '2026-04-06T10:00:00.000Z',
    endedAt: '2026-04-06T10:00:05.000Z',   // 5s
    guardrails: { maxDurationMs: 10000 },    // 10s limit
  });
  const result = validatePostExecution(task);
  assert.ok(result.ok);
});

test('validatePostExecution: 执行时间超限 → violation warning', () => {
  const task = makeTask({
    startedAt: '2026-04-06T10:00:00.000Z',
    endedAt: '2026-04-06T10:00:15.000Z',   // 15s
    guardrails: { maxDurationMs: 10000 },    // 10s limit
  });
  const result = validatePostExecution(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, 'maxDurationMs');
  assert.equal(result.violations[0].severity, 'warning');
});

test('validatePostExecution: maxDurationMs 但缺少 startedAt → no violation', () => {
  const task = makeTask({
    endedAt: '2026-04-06T10:00:15.000Z',
    guardrails: { maxDurationMs: 1000 },
  });
  const result = validatePostExecution(task);
  assert.ok(result.ok);
});

test('validatePostExecution: outputTokens 在限制内 → ok', () => {
  const task = makeTask({
    usage: { outputTokens: 500 },
    guardrails: { maxOutputTokens: 1000 },
  });
  const result = validatePostExecution(task);
  assert.ok(result.ok);
});

test('validatePostExecution: outputTokens 超限 → violation warning', () => {
  const task = makeTask({
    usage: { outputTokens: 2000 },
    guardrails: { maxOutputTokens: 1000 },
  });
  const result = validatePostExecution(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, 'maxOutputTokens');
  assert.equal(result.violations[0].severity, 'warning');
});

test('validatePostExecution: requireArtifacts 全部满足 → ok', () => {
  const task = makeTask({
    artifacts: [
      { path: 'src/foo.ts', type: 'code' },
      { path: 'docs/api.md', type: 'document' },
    ],
    guardrails: { requireArtifacts: ['code', 'document'] },
  });
  const result = validatePostExecution(task);
  assert.ok(result.ok);
});

test('validatePostExecution: requireArtifacts 部分缺失 → violation error', () => {
  const task = makeTask({
    artifacts: [
      { path: 'src/foo.ts', type: 'code' },
    ],
    guardrails: { requireArtifacts: ['code', 'document'] },
  });
  const result = validatePostExecution(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, 'requireArtifacts');
  assert.equal(result.violations[0].severity, 'error');
  assert.ok(result.violations[0].message.includes('document'));
});

test('validatePostExecution: requireArtifacts 全部缺失 → multiple violations', () => {
  const task = makeTask({
    artifacts: [],
    guardrails: { requireArtifacts: ['code', 'document', 'test'] },
  });
  const result = validatePostExecution(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 3);
});

test('validatePostExecution: 多条 violation 同时存在 → 全部报告', () => {
  const task = makeTask({
    startedAt: '2026-04-06T10:00:00.000Z',
    endedAt: '2026-04-06T10:01:00.000Z',   // 60s - over limit
    usage: { outputTokens: 5000 },          // over token limit
    artifacts: [],                           // missing required artifact
    guardrails: {
      maxDurationMs: 10000,
      maxOutputTokens: 1000,
      requireArtifacts: ['code'],
    },
  });
  const result = validatePostExecution(task);
  assert.ok(!result.ok);
  assert.equal(result.violations.length, 3);
  const rules = result.violations.map((v) => v.rule);
  assert.ok(rules.includes('maxDurationMs'));
  assert.ok(rules.includes('maxOutputTokens'));
  assert.ok(rules.includes('requireArtifacts'));
});

// ==================== formatViolations 测试 ====================

test('formatViolations: ok 结果 → 空字符串', () => {
  const result = { ok: true, violations: [] };
  assert.equal(formatViolations(result), '');
});

test('formatViolations: 有 violation → 格式化字符串', () => {
  const result = {
    ok: false,
    violations: [
      { rule: 'maxRetries', message: 'Task T1 has reached retry limit: 3 >= 3', severity: 'error' as const },
      { rule: 'maxDurationMs', message: 'Task T1 exceeded max duration: 15000ms > 10000ms', severity: 'warning' as const },
    ],
  };
  const formatted = formatViolations(result);
  assert.ok(formatted.includes('[error] maxRetries:'));
  assert.ok(formatted.includes('[warning] maxDurationMs:'));
  assert.ok(formatted.includes('; '));
});

test('formatViolations: 单个 violation — 无分隔符', () => {
  const result = {
    ok: false,
    violations: [
      { rule: 'requireArtifacts', message: 'Task T1 missing required artifact type: code', severity: 'error' as const },
    ],
  };
  const formatted = formatViolations(result);
  assert.ok(formatted.startsWith('[error] requireArtifacts:'));
  assert.ok(!formatted.includes('; '));
});
