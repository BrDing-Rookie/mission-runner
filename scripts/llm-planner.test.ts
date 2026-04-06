/**
 * llm-planner.test.ts — Tests for buildPlannedOutputWithLlm
 *
 * Uses MockLlmClient and ErrorLlmClient for deterministic testing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlannedOutputWithLlm,
  buildLlmSystemPrompt,
  buildLlmUserPrompt,
  normalizeCustomTasks,
} from './lib/mission-planner.ts';
import { MockLlmClient, ErrorLlmClient } from './lib/llm-client.ts';
import type { Mission } from './lib/types.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    missionId: 'test-mission-001',
    title: 'Test Mission Title',
    goal: 'Build a CLI tool to automate testing',
    status: 'CREATED',
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
    ...overrides,
  };
}

const VALID_LLM_RESPONSE = JSON.stringify({
  tasks: [
    {
      taskId: 'T1-research',
      title: 'Research requirements',
      type: 'research',
      description: 'Gather and analyze requirements for the CLI tool.',
      dependsOn: [],
    },
    {
      taskId: 'T2-implement',
      title: 'Implement CLI tool',
      type: 'code',
      description: 'Write the CLI tool implementation.',
      dependsOn: ['T1-research'],
    },
    {
      taskId: 'T3-verify',
      title: 'Verify implementation',
      type: 'verification',
      description: 'Run tests and verify completion criteria.',
      dependsOn: ['T2-implement'],
    },
  ],
  completionCriteria: [
    { id: 'criterion-1', description: 'CLI tool runs without errors', required: true },
    { id: 'criterion-2', description: 'All tests pass', required: true },
  ],
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('buildPlannedOutputWithLlm: valid JSON response → correct PlannedOutput', async () => {
  const mission = makeMission();
  const client = new MockLlmClient(VALID_LLM_RESPONSE);

  const result = await buildPlannedOutputWithLlm(mission, client);

  assert.equal(result.tasks.length, 3);
  assert.equal(result.completionCriteria.length, 2);
  assert.ok(result.planMarkdown.includes('Test Mission Title'));
  assert.ok(result.planMarkdown.includes('T1-research'));
  assert.ok(typeof result.llmUsage.model === 'string');
  assert.ok(result.llmUsage.inputTokens >= 0);
  assert.ok(result.llmUsage.outputTokens >= 0);
});

test('buildPlannedOutputWithLlm: tasks pass TaskSchema validation', async () => {
  const mission = makeMission();
  const client = new MockLlmClient(VALID_LLM_RESPONSE);

  const result = await buildPlannedOutputWithLlm(mission, client);

  for (const task of result.tasks) {
    // Required fields must be present
    assert.ok(typeof task.taskId === 'string' && task.taskId.length > 0, `taskId missing: ${JSON.stringify(task)}`);
    assert.ok(typeof task.title === 'string' && task.title.length > 0, `title missing: ${JSON.stringify(task)}`);
    assert.ok(typeof task.type === 'string' && task.type.length > 0, `type missing: ${JSON.stringify(task)}`);
    assert.ok(typeof task.status === 'string', `status missing: ${JSON.stringify(task)}`);
    assert.ok(Array.isArray(task.dependsOn), `dependsOn missing: ${JSON.stringify(task)}`);
  }
});

test('buildPlannedOutputWithLlm: task status set correctly based on dependsOn', async () => {
  const mission = makeMission();
  const client = new MockLlmClient(VALID_LLM_RESPONSE);

  const result = await buildPlannedOutputWithLlm(mission, client);

  const t1 = result.tasks.find((t) => t.taskId === 'T1-research');
  const t2 = result.tasks.find((t) => t.taskId === 'T2-implement');

  assert.ok(t1, 'T1-research not found');
  assert.ok(t2, 'T2-implement not found');
  assert.equal(t1!.status, 'READY', 'T1 (no deps) should be READY');
  assert.equal(t2!.status, 'PENDING', 'T2 (has deps) should be PENDING');
});

test('buildPlannedOutputWithLlm: completionCriteria correctly parsed', async () => {
  const mission = makeMission();
  const client = new MockLlmClient(VALID_LLM_RESPONSE);

  const result = await buildPlannedOutputWithLlm(mission, client);

  assert.equal(result.completionCriteria.length, 2);
  const c1 = result.completionCriteria[0];
  assert.equal(c1.id, 'criterion-1');
  assert.equal(c1.description, 'CLI tool runs without errors');
  assert.equal(c1.required, true);
});

test('buildPlannedOutputWithLlm: prompt contains mission.goal and mission.title', async () => {
  const mission = makeMission({
    title: 'My Special Title',
    goal: 'Implement a unique goal description',
  });
  const client = new MockLlmClient(VALID_LLM_RESPONSE);

  await buildPlannedOutputWithLlm(mission, client);

  assert.equal(client.calls.length, 1);
  const { systemPrompt, userPrompt } = client.calls[0];

  assert.ok(userPrompt.includes('My Special Title'), 'userPrompt should include mission title');
  assert.ok(userPrompt.includes('Implement a unique goal description'), 'userPrompt should include mission goal');
  assert.ok(systemPrompt.length > 0, 'systemPrompt should not be empty');
});

test('buildPlannedOutputWithLlm: LLM returns invalid JSON → throws error', async () => {
  const mission = makeMission();
  const client = new MockLlmClient('this is not json at all!!!');

  await assert.rejects(
    () => buildPlannedOutputWithLlm(mission, client),
    (err: Error) => {
      assert.ok(err.message.includes('invalid JSON'), `Expected "invalid JSON" in: ${err.message}`);
      return true;
    }
  );
});

test('buildPlannedOutputWithLlm: LLM returns JSON missing required fields → throws error', async () => {
  const mission = makeMission();
  const missingFieldsResponse = JSON.stringify({
    tasks: [
      {
        // missing taskId, title, type
        description: 'A task with no required fields',
        dependsOn: [],
      },
    ],
    completionCriteria: [
      { id: 'c1', description: 'Some criterion', required: true },
    ],
  });
  const client = new MockLlmClient(missingFieldsResponse);

  await assert.rejects(
    () => buildPlannedOutputWithLlm(mission, client),
    (err: Error) => {
      assert.ok(err.message.length > 0, 'Error should have a message');
      return true;
    }
  );
});

test('buildPlannedOutputWithLlm: LLM returns missing tasks key → throws error', async () => {
  const mission = makeMission();
  const noTasksResponse = JSON.stringify({
    // tasks key missing
    completionCriteria: [{ id: 'c1', description: 'criterion', required: true }],
  });
  const client = new MockLlmClient(noTasksResponse);

  await assert.rejects(
    () => buildPlannedOutputWithLlm(mission, client),
    (err: Error) => {
      assert.ok(err.message.length > 0, 'Error should have a message');
      return true;
    }
  );
});

test('buildPlannedOutputWithLlm: ErrorLlmClient → throws error', async () => {
  const mission = makeMission();
  const client = new ErrorLlmClient('Network timeout');

  await assert.rejects(
    () => buildPlannedOutputWithLlm(mission, client),
    (err: Error) => {
      assert.ok(err.message.includes('Network timeout'), `Expected "Network timeout" in: ${err.message}`);
      return true;
    }
  );
});

test('buildPlannedOutputWithLlm: caller can fallback when error thrown (ErrorLlmClient)', async () => {
  const mission = makeMission();
  const client = new ErrorLlmClient('API unavailable');

  let usedFallback = false;

  try {
    await buildPlannedOutputWithLlm(mission, client);
  } catch (_err) {
    // Caller handles the fallback
    usedFallback = true;
  }

  assert.ok(usedFallback, 'Caller should detect the error and use fallback');
});

test('buildPlannedOutputWithLlm: handles LLM response with markdown code fences', async () => {
  const mission = makeMission();
  const withFences = '```json\n' + VALID_LLM_RESPONSE + '\n```';
  const client = new MockLlmClient(withFences);

  const result = await buildPlannedOutputWithLlm(mission, client);

  assert.equal(result.tasks.length, 3);
  assert.equal(result.completionCriteria.length, 2);
});

test('buildPlannedOutputWithLlm: dependency graph validation via normalizeCustomTasks', async () => {
  const mission = makeMission();
  // Tasks with a cycle: T1 -> T2 -> T1
  const cyclicResponse = JSON.stringify({
    tasks: [
      { taskId: 'T1', title: 'Task 1', type: 'research', description: 'desc', dependsOn: ['T2'] },
      { taskId: 'T2', title: 'Task 2', type: 'code', description: 'desc', dependsOn: ['T1'] },
    ],
    completionCriteria: [
      { id: 'c1', description: 'criterion', required: true },
    ],
  });
  const client = new MockLlmClient(cyclicResponse);

  await assert.rejects(
    () => buildPlannedOutputWithLlm(mission, client),
    (err: Error) => {
      assert.ok(err.message.length > 0, 'Should throw for cyclic dependency');
      return true;
    }
  );
});

test('buildLlmSystemPrompt: includes all valid TaskType values', () => {
  const systemPrompt = buildLlmSystemPrompt();
  const validTypes = ['research', 'analysis', 'code', 'document', 'review', 'test', 'deploy', 'verification', 'notification', 'external_wait'];
  for (const type of validTypes) {
    assert.ok(systemPrompt.includes(type), `systemPrompt should include task type: ${type}`);
  }
});

test('buildLlmUserPrompt: contains mission title and goal', () => {
  const mission = makeMission({
    title: 'Unique Test Title XYZ',
    goal: 'Unique test goal ABC',
  });
  const prompt = buildLlmUserPrompt(mission);
  assert.ok(prompt.includes('Unique Test Title XYZ'));
  assert.ok(prompt.includes('Unique test goal ABC'));
});

test('normalizeCustomTasks: detects cyclic dependencies', () => {
  const tasks = [
    {
      taskId: 'T1',
      title: 'Task 1',
      type: 'research' as const,
      description: 'desc',
      status: 'READY' as const,
      dependsOn: ['T2'],
      priority: 100,
      retryCount: 0,
      maxRetries: 2,
      artifacts: [],
      resultSummary: null,
      lastError: null,
      backgroundProcessId: null,
      sessionKey: null,
      agent: null,
    },
    {
      taskId: 'T2',
      title: 'Task 2',
      type: 'code' as const,
      description: 'desc',
      status: 'PENDING' as const,
      dependsOn: ['T1'],
      priority: 90,
      retryCount: 0,
      maxRetries: 2,
      artifacts: [],
      resultSummary: null,
      lastError: null,
      backgroundProcessId: null,
      sessionKey: null,
      agent: null,
    },
  ];

  assert.throws(
    () => normalizeCustomTasks(tasks),
    (err: Error) => {
      assert.ok(err.message.includes('cyclic'), `Expected cyclic error: ${err.message}`);
      return true;
    }
  );
});
