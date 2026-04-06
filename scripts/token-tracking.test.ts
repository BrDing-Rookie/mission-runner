/**
 * token-tracking.test.ts — Token/成本追踪机制测试
 *
 * 覆盖:
 * - TokenUsage Zod 校验
 * - Task / Mission 支持 usage / totalUsage 字段
 * - aggregateUsage 汇总逻辑
 * - task-update CLI 参数解析
 * - 向后兼容性
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TokenUsageSchema, TaskSchema, MissionSchema } from './lib/schemas.ts';
import { aggregateUsage } from './lib/mission-helpers.ts';
import { updateTask } from './task-update.ts';
import type { Mission, Task, TokenUsage } from './lib/types.ts';

// ==================== Helpers ====================

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'M1',
    title: 'Test Mission',
    goal: 'Test goal',
    status: 'RUNNING',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
    tasks: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'T1',
    title: 'Test Task',
    type: 'analysis',
    status: 'RUNNING',
    ...overrides,
  };
}

function writeMissionFixture(missionsDir: string, mission: Mission): void {
  const missionDir = join(missionsDir, mission.missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(mission, null, 2), { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(join(missionDir, 'events.jsonl'), '', { encoding: 'utf-8', flag: 'wx' });
}

// ==================== TokenUsage Zod 校验 ====================

test('TokenUsageSchema: validates a fully populated usage object', () => {
  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    model: 'claude-sonnet-4-6',
    calls: 3,
    estimatedCostUsd: 0.0015,
  };
  const result = TokenUsageSchema.safeParse(usage);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.inputTokens, 100);
    assert.equal(result.data.model, 'claude-sonnet-4-6');
  }
});

test('TokenUsageSchema: accepts empty object (all fields optional)', () => {
  const result = TokenUsageSchema.safeParse({});
  assert.equal(result.success, true);
});

test('TokenUsageSchema: accepts partial fields', () => {
  const result = TokenUsageSchema.safeParse({ inputTokens: 42, model: 'gpt-4o' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.inputTokens, 42);
    assert.equal(result.data.outputTokens, undefined);
  }
});

test('TokenUsageSchema: rejects non-numeric token fields', () => {
  const result = TokenUsageSchema.safeParse({ inputTokens: 'a lot' });
  assert.equal(result.success, false);
});

test('TokenUsageSchema: passthrough preserves unknown fields', () => {
  const result = TokenUsageSchema.safeParse({ inputTokens: 10, customField: 'extra' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>).customField, 'extra');
  }
});

// ==================== Task Zod 校验支持 usage 字段 ====================

test('TaskSchema: accepts task with usage field', () => {
  const task = {
    taskId: 'T1',
    title: 'My Task',
    type: 'analysis',
    status: 'COMPLETED',
    usage: {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      model: 'claude-3-haiku',
      calls: 1,
    },
  };
  const result = TaskSchema.safeParse(task);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.usage?.inputTokens, 200);
  }
});

test('TaskSchema: accepts task without usage field (backward compat)', () => {
  const task = {
    taskId: 'T1',
    title: 'My Task',
    type: 'code',
    status: 'PENDING',
  };
  const result = TaskSchema.safeParse(task);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.usage, undefined);
  }
});

// ==================== Mission Zod 校验支持 totalUsage 字段 ====================

test('MissionSchema: accepts mission with totalUsage field', () => {
  const mission = {
    missionId: 'M1',
    title: 'Test',
    goal: 'Goal',
    status: 'RUNNING',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
    totalUsage: {
      inputTokens: 500,
      outputTokens: 250,
      totalTokens: 750,
      calls: 5,
    },
  };
  const result = MissionSchema.safeParse(mission);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.totalUsage?.totalTokens, 750);
  }
});

test('MissionSchema: accepts mission without totalUsage (backward compat)', () => {
  const mission = {
    missionId: 'M1',
    title: 'Test',
    goal: 'Goal',
    status: 'COMPLETED',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
  };
  const result = MissionSchema.safeParse(mission);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.totalUsage, undefined);
  }
});

// ==================== aggregateUsage ====================

test('aggregateUsage: returns undefined for mission with no tasks', () => {
  const mission = makeMission({ tasks: [] });
  assert.equal(aggregateUsage(mission), undefined);
});

test('aggregateUsage: returns undefined when all tasks have no usage', () => {
  const mission = makeMission({
    tasks: [makeTask({ taskId: 'T1' }), makeTask({ taskId: 'T2' })],
  });
  assert.equal(aggregateUsage(mission), undefined);
});

test('aggregateUsage: returns usage for a single task', () => {
  const mission = makeMission({
    tasks: [
      makeTask({
        taskId: 'T1',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'claude-sonnet-4-6', calls: 1 },
      }),
    ],
  });
  const result = aggregateUsage(mission);
  assert.ok(result !== undefined);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.totalTokens, 150);
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.calls, 1);
});

test('aggregateUsage: sums tokens across multiple tasks', () => {
  const mission = makeMission({
    tasks: [
      makeTask({
        taskId: 'T1',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'claude-sonnet-4-6', calls: 2 },
      }),
      makeTask({
        taskId: 'T2',
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280, model: 'claude-sonnet-4-6', calls: 3 },
      }),
    ],
  });
  const result = aggregateUsage(mission);
  assert.ok(result !== undefined);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 130);
  assert.equal(result.totalTokens, 430);
  assert.equal(result.calls, 5);
  assert.equal(result.model, 'claude-sonnet-4-6');
});

test('aggregateUsage: skips tasks without usage when summing', () => {
  const mission = makeMission({
    tasks: [
      makeTask({ taskId: 'T1' }),
      makeTask({
        taskId: 'T2',
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, calls: 1 },
      }),
    ],
  });
  const result = aggregateUsage(mission);
  assert.ok(result !== undefined);
  assert.equal(result.inputTokens, 50);
  assert.equal(result.calls, 1);
});

test('aggregateUsage: picks most frequent model', () => {
  const mission = makeMission({
    tasks: [
      makeTask({ taskId: 'T1', usage: { model: 'model-A', calls: 1 } }),
      makeTask({ taskId: 'T2', usage: { model: 'model-B', calls: 1 } }),
      makeTask({ taskId: 'T3', usage: { model: 'model-B', calls: 1 } }),
    ],
  });
  const result = aggregateUsage(mission);
  assert.ok(result !== undefined);
  assert.equal(result.model, 'model-B');
});

test('aggregateUsage: includes estimatedCostUsd sum', () => {
  const mission = makeMission({
    tasks: [
      makeTask({ taskId: 'T1', usage: { estimatedCostUsd: 0.001, calls: 1 } }),
      makeTask({ taskId: 'T2', usage: { estimatedCostUsd: 0.002, calls: 1 } }),
    ],
  });
  const result = aggregateUsage(mission);
  assert.ok(result !== undefined);
  assert.ok(Math.abs((result.estimatedCostUsd ?? 0) - 0.003) < 1e-9);
});

// ==================== task-update CLI 参数解析 ====================

test('task-update: --input-tokens, --output-tokens, --model are written to task.usage', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'token-tracking-test-'));
  const missionId = 'M-usage-01';
  const mission = makeMission({
    missionId,
    status: 'RUNNING',
    tasks: [makeTask({ taskId: 'T1', status: 'RUNNING' })],
  });
  writeMissionFixture(missionsDir, mission);

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED',
    summary: 'done',
    artifacts: [],
    dryRun: false,
    inputTokens: 300,
    outputTokens: 150,
    model: 'claude-haiku',
  });

  assert.equal(result.changed, true);
  assert.equal(result.taskStatusTo, 'COMPLETED');
});

test('task-update: usage fields absent when no token args passed', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'token-tracking-test-'));
  const missionId = 'M-nousage-01';
  const mission = makeMission({
    missionId,
    status: 'RUNNING',
    tasks: [makeTask({ taskId: 'T1', status: 'RUNNING' })],
  });
  writeMissionFixture(missionsDir, mission);

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED',
    summary: 'done',
    artifacts: [],
    dryRun: false,
  });

  assert.equal(result.changed, true);
});

test('task-update: totalUsage is set on mission when usage reported', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'token-tracking-test-'));
  const missionId = 'M-total-usage-01';
  const mission = makeMission({
    missionId,
    status: 'RUNNING',
    tasks: [
      makeTask({ taskId: 'T1', status: 'RUNNING' }),
    ],
  });
  writeMissionFixture(missionsDir, mission);

  updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED',
    summary: 'done',
    artifacts: [],
    dryRun: false,
    inputTokens: 400,
    outputTokens: 200,
    model: 'claude-sonnet-4-6',
  });

  const written = JSON.parse(readFileSync(join(missionsDir, missionId, 'mission.json'), 'utf-8')) as Mission;
  assert.ok(written.totalUsage !== undefined);
  assert.equal(written.totalUsage.inputTokens, 400);
  assert.equal(written.totalUsage.outputTokens, 200);
  assert.equal(written.totalUsage.model, 'claude-sonnet-4-6');
});

// ==================== 向后兼容 ====================

test('backward compat: mission without totalUsage field still processes normally', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'token-tracking-compat-'));
  const missionId = 'M-compat-01';
  const mission = makeMission({
    missionId,
    status: 'RUNNING',
    tasks: [makeTask({ taskId: 'T1', status: 'RUNNING' })],
  });
  writeMissionFixture(missionsDir, mission);

  const result = updateTask({
    missionsDir,
    missionId,
    taskId: 'T1',
    status: 'COMPLETED',
    summary: 'done',
    artifacts: [],
    dryRun: false,
  });

  assert.equal(result.changed, true);
  assert.equal(result.taskStatusTo, 'COMPLETED');
});

test('backward compat: task without usage field is not affected', () => {
  const task = makeTask({ taskId: 'T1', status: 'PENDING' });
  assert.equal(task.usage, undefined);

  const schemaResult = TaskSchema.safeParse(task);
  assert.equal(schemaResult.success, true);
});
