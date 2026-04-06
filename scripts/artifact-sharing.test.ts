import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSchema, MissionSchema } from './lib/schemas.ts';
import { resolveConsumedArtifacts, buildDispatchEnvelope } from './lib/mission-helpers.ts';
import type { Mission, Task } from './lib/types.ts';

// ==================== Zod Schema Tests ====================

test('TaskSchema: task with produces/consumes fields passes validation', () => {
  const taskData = {
    taskId: 'T1',
    title: 'Generate report',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['report-pdf', 'summary-json'],
    consumes: ['raw-data'],
  };

  const result = TaskSchema.safeParse(taskData);
  assert.ok(result.success, `Expected parse to succeed, got: ${JSON.stringify(result.error?.errors)}`);
  if (result.success) {
    assert.deepEqual(result.data.produces, ['report-pdf', 'summary-json']);
    assert.deepEqual(result.data.consumes, ['raw-data']);
  }
});

test('TaskSchema: task without produces/consumes passes validation (backward compatibility)', () => {
  const taskData = {
    taskId: 'T2',
    title: 'Simple task',
    type: 'code',
    status: 'READY',
  };

  const result = TaskSchema.safeParse(taskData);
  assert.ok(result.success, `Expected parse to succeed, got: ${JSON.stringify(result.error?.errors)}`);
  if (result.success) {
    assert.equal(result.data.produces, undefined);
    assert.equal(result.data.consumes, undefined);
  }
});

test('MissionSchema: mission with tasks having produces/consumes passes validation', () => {
  const missionData = {
    missionId: 'mission-20260406-001',
    title: 'Artifact sharing test',
    goal: 'Test artifact sharing',
    status: 'RUNNING',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Producer task',
        type: 'analysis',
        status: 'COMPLETED',
        produces: ['report'],
        artifacts: [{ path: 'artifacts/report.md', type: 'report' }],
      },
      {
        taskId: 'T2',
        title: 'Consumer task',
        type: 'code',
        status: 'READY',
        consumes: ['report'],
        dependsOn: ['T1'],
      },
    ],
  };

  const result = MissionSchema.safeParse(missionData);
  assert.ok(result.success, `Expected parse to succeed, got: ${JSON.stringify(result.error?.errors)}`);
});

// ==================== resolveConsumedArtifacts Tests ====================

function makeBaseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'mission-test-001',
    title: 'Test Mission',
    goal: 'Test artifact resolution',
    status: 'RUNNING',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
    tasks: [],
    ...overrides,
  };
}

test('resolveConsumedArtifacts: returns empty array when task has no consumes', () => {
  const mission = makeBaseMission();
  const task: Task = {
    taskId: 'T1',
    title: 'Consumer',
    type: 'analysis',
    status: 'READY',
  };

  const result = resolveConsumedArtifacts(mission, task);
  assert.deepEqual(result, []);
});

test('resolveConsumedArtifacts: normal match by artifact type', () => {
  const producerTask: Task = {
    taskId: 'T1',
    title: 'Producer',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['report'],
    artifacts: [
      { path: 'artifacts/report.md', type: 'report', description: 'Analysis report' },
    ],
  };

  const consumerTask: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['report'],
    dependsOn: ['T1'],
  };

  const mission = makeBaseMission({ tasks: [producerTask, consumerTask] });
  const result = resolveConsumedArtifacts(mission, consumerTask);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.key, 'report');
  assert.equal(result[0]?.producerTaskId, 'T1');
  assert.equal(result[0]?.artifact.path, 'artifacts/report.md');
  assert.equal(result[0]?.artifact.type, 'report');
});

test('resolveConsumedArtifacts: upstream task not COMPLETED returns empty', () => {
  const producerTask: Task = {
    taskId: 'T1',
    title: 'Producer (still running)',
    type: 'analysis',
    status: 'RUNNING',
    produces: ['report'],
    artifacts: [
      { path: 'artifacts/report.md', type: 'report' },
    ],
  };

  const consumerTask: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['report'],
  };

  const mission = makeBaseMission({ tasks: [producerTask, consumerTask] });
  const result = resolveConsumedArtifacts(mission, consumerTask);

  assert.deepEqual(result, []);
});

test('resolveConsumedArtifacts: no matching key returns empty', () => {
  const producerTask: Task = {
    taskId: 'T1',
    title: 'Producer',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['other-key'],
    artifacts: [
      { path: 'artifacts/other.md', type: 'other-key' },
    ],
  };

  const consumerTask: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['report'],
  };

  const mission = makeBaseMission({ tasks: [producerTask, consumerTask] });
  const result = resolveConsumedArtifacts(mission, consumerTask);

  assert.deepEqual(result, []);
});

test('resolveConsumedArtifacts: multiple consumers multiple producers', () => {
  const producer1: Task = {
    taskId: 'T1',
    title: 'Producer 1',
    type: 'research',
    status: 'COMPLETED',
    produces: ['research-data'],
    artifacts: [
      { path: 'artifacts/research.json', type: 'research-data' },
    ],
  };

  const producer2: Task = {
    taskId: 'T2',
    title: 'Producer 2',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['analysis-report'],
    artifacts: [
      { path: 'artifacts/analysis.md', type: 'analysis-report' },
    ],
  };

  const consumer: Task = {
    taskId: 'T3',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['research-data', 'analysis-report'],
    dependsOn: ['T1', 'T2'],
  };

  const mission = makeBaseMission({ tasks: [producer1, producer2, consumer] });
  const result = resolveConsumedArtifacts(mission, consumer);

  assert.equal(result.length, 2);

  const researchResult = result.find((r) => r.key === 'research-data');
  assert.ok(researchResult, 'Expected research-data to be resolved');
  assert.equal(researchResult?.producerTaskId, 'T1');
  assert.equal(researchResult?.artifact.path, 'artifacts/research.json');

  const analysisResult = result.find((r) => r.key === 'analysis-report');
  assert.ok(analysisResult, 'Expected analysis-report to be resolved');
  assert.equal(analysisResult?.producerTaskId, 'T2');
  assert.equal(analysisResult?.artifact.path, 'artifacts/analysis.md');
});

test('resolveConsumedArtifacts: matches artifact by exact path when type does not match', () => {
  const producer: Task = {
    taskId: 'T1',
    title: 'Producer',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['artifacts/data.json'],
    artifacts: [
      { path: 'artifacts/data.json', type: 'data' },
    ],
  };

  const consumer: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['artifacts/data.json'],
  };

  const mission = makeBaseMission({ tasks: [producer, consumer] });
  const result = resolveConsumedArtifacts(mission, consumer);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.key, 'artifacts/data.json');
  assert.equal(result[0]?.artifact.path, 'artifacts/data.json');
  assert.equal(result[0]?.producerTaskId, 'T1');
});

test('resolveConsumedArtifacts: matches artifact by path prefix', () => {
  const producer: Task = {
    taskId: 'T1',
    title: 'Producer',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['artifacts/'],
    artifacts: [
      { path: 'artifacts/output.md', type: 'document' },
    ],
  };

  const consumer: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['artifacts/'],
  };

  const mission = makeBaseMission({ tasks: [producer, consumer] });
  const result = resolveConsumedArtifacts(mission, consumer);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.key, 'artifacts/');
  assert.equal(result[0]?.artifact.path, 'artifacts/output.md');
  assert.equal(result[0]?.producerTaskId, 'T1');
});

// ==================== buildDispatchEnvelope Tests ====================

test('buildDispatchEnvelope: includes availableArtifacts when task has consumes and upstream is completed', () => {
  const producer: Task = {
    taskId: 'T1',
    title: 'Producer',
    type: 'analysis',
    status: 'COMPLETED',
    produces: ['report'],
    artifacts: [
      { path: 'artifacts/report.md', type: 'report' },
    ],
  };

  const consumer: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['report'],
    dependsOn: ['T1'],
  };

  const mission = makeBaseMission({ tasks: [producer, consumer] });
  const envelope = buildDispatchEnvelope(mission, consumer);

  assert.equal(envelope.missionId, 'mission-test-001');
  assert.equal(envelope.taskId, 'T2');
  assert.equal(envelope.title, 'Consumer');
  assert.ok(envelope.availableArtifacts, 'Expected availableArtifacts to be present');
  assert.equal(envelope.availableArtifacts?.length, 1);
  assert.equal(envelope.availableArtifacts?.[0]?.key, 'report');
  assert.equal(envelope.availableArtifacts?.[0]?.producerTaskId, 'T1');
});

test('buildDispatchEnvelope: no availableArtifacts when task has no consumes', () => {
  const task: Task = {
    taskId: 'T1',
    title: 'Standalone task',
    type: 'code',
    status: 'READY',
  };

  const mission = makeBaseMission({ tasks: [task] });
  const envelope = buildDispatchEnvelope(mission, task);

  assert.equal(envelope.taskId, 'T1');
  assert.equal(envelope.availableArtifacts, undefined);
});

test('buildDispatchEnvelope: availableArtifacts is absent when consumes exist but no upstream completed', () => {
  const producer: Task = {
    taskId: 'T1',
    title: 'Producer (pending)',
    type: 'analysis',
    status: 'PENDING',
    produces: ['report'],
    artifacts: [],
  };

  const consumer: Task = {
    taskId: 'T2',
    title: 'Consumer',
    type: 'code',
    status: 'READY',
    consumes: ['report'],
  };

  const mission = makeBaseMission({ tasks: [producer, consumer] });
  const envelope = buildDispatchEnvelope(mission, consumer);

  assert.equal(envelope.availableArtifacts, undefined);
});

test('buildDispatchEnvelope: backward compatible — task without produces/consumes works normally', () => {
  const task: Task = {
    taskId: 'T1',
    title: 'Legacy task',
    type: 'code',
    status: 'READY',
    description: 'A task without produces/consumes',
    config: { someKey: 'someValue' },
  };

  const mission = makeBaseMission({ tasks: [task] });
  const envelope = buildDispatchEnvelope(mission, task);

  assert.equal(envelope.missionId, 'mission-test-001');
  assert.equal(envelope.taskId, 'T1');
  assert.equal(envelope.title, 'Legacy task');
  assert.equal(envelope.description, 'A task without produces/consumes');
  assert.deepEqual(envelope.config, { someKey: 'someValue' });
  assert.equal(envelope.availableArtifacts, undefined);
});
