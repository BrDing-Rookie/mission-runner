/**
 * llm-verifier.test.ts — Tests for LLM-powered criterion evaluation
 *
 * Tests evaluateCriterionWithLlm and computeVerificationWithLlm using
 * MockLlmClient and ErrorLlmClient.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLlmClient, ErrorLlmClient } from './lib/llm-client.ts';
import {
  evaluateCriterionWithLlm,
  computeVerificationWithLlm,
  type VerifyInput,
} from './lib/mission-verifier.ts';
import type { CompletionCriterion, Mission } from './lib/types.ts';
import { writeMissionFixture } from './test-helpers.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMissionFixture(mission: Mission): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'llm-verifier-'));
  writeMissionFixture(missionsDir, mission);
  return { missionsDir, missionId: mission.missionId };
}

const BASE_TS = '2026-04-07T00:00:00.000Z';

function baseMission(overrides: Partial<Mission> & { missionId: string }): Mission {
  return {
    title: 'Test mission',
    goal: 'Test goal',
    status: 'VERIFYING',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    ...overrides,
  };
}

const baseContext = {
  hasPlan: true,
  hasArtifacts: false,
  hasPendingTasks: false,
  hasFailedTasks: false,
  planCriteria: [],
  artifactFiles: [],
  missionArtifacts: [],
  missionsDir: '/tmp',
  missionId: 'test-mission',
};

// ── evaluateCriterionWithLlm tests ─────────────────────────────────────────────

test('evaluateCriterionWithLlm: LLM returns passed=true → CriterionResult.passed=true', async () => {
  const criterion: CompletionCriterion = {
    id: 'C1',
    description: 'Implementation is complete',
    required: true,
  };

  const mockClient = new MockLlmClient('{"passed": true, "reason": "Implementation is fully done."}');
  const result = await evaluateCriterionWithLlm(criterion, baseContext, mockClient);

  assert.equal(result.criterionId, 'C1');
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes('[LLM]'));
  assert.ok(result.reason.includes('Implementation is fully done.'));
});

test('evaluateCriterionWithLlm: LLM returns passed=false → CriterionResult.passed=false', async () => {
  const criterion: CompletionCriterion = {
    id: 'C2',
    description: 'All tests must pass',
    required: true,
  };

  const mockClient = new MockLlmClient('{"passed": false, "reason": "Tests are still failing."}');
  const result = await evaluateCriterionWithLlm(criterion, baseContext, mockClient);

  assert.equal(result.criterionId, 'C2');
  assert.equal(result.passed, false);
  assert.ok(result.reason.includes('[LLM]'));
  assert.ok(result.reason.includes('Tests are still failing.'));
});

test('evaluateCriterionWithLlm: LLM returns invalid JSON → fallback to heuristic', async () => {
  const criterion: CompletionCriterion = {
    id: 'C3',
    description: 'Implementation step is complete',
    required: true,
  };

  const mockClient = new MockLlmClient('This is not JSON at all');
  // hasPlan=true, no pending/failed tasks — heuristic should pass
  const result = await evaluateCriterionWithLlm(criterion, { ...baseContext, hasPlan: true }, mockClient);

  assert.equal(result.criterionId, 'C3');
  // Should use heuristic result: no pending/failed tasks → passes
  assert.equal(result.passed, true);
  // Should NOT have [LLM] prefix since it fell back
  assert.ok(!result.reason.includes('[LLM]'));
});

test('evaluateCriterionWithLlm: LLM returns malformed JSON object → fallback to heuristic', async () => {
  const criterion: CompletionCriterion = {
    id: 'C4',
    description: 'Deliverable artifact present',
    required: true,
  };

  // JSON parsed but wrong shape (missing required fields)
  const mockClient = new MockLlmClient('{"status": "ok", "message": "done"}');
  const result = await evaluateCriterionWithLlm(criterion, { ...baseContext, hasArtifacts: false }, mockClient);

  assert.equal(result.criterionId, 'C4');
  // Falls back to heuristic — no artifacts present → should fail
  assert.equal(result.passed, false);
  assert.ok(!result.reason.includes('[LLM]'));
});

test('evaluateCriterionWithLlm: ErrorLlmClient → graceful fallback, does not throw', async () => {
  const criterion: CompletionCriterion = {
    id: 'C5',
    description: 'Implementation complete',
    required: true,
  };

  const errorClient = new ErrorLlmClient('Network error');
  // Should not throw
  const result = await evaluateCriterionWithLlm(criterion, baseContext, errorClient);

  assert.equal(result.criterionId, 'C5');
  // Falls back to heuristic — no pending/failed tasks, hasPlan → passes
  assert.equal(result.passed, true);
  assert.ok(!result.reason.includes('[LLM]'));
});

test('evaluateCriterionWithLlm: already verified=true criterion → short-circuits without LLM call', async () => {
  const criterion: CompletionCriterion = {
    id: 'C6',
    description: 'Something done',
    required: true,
    verified: true,
  };

  const mockClient = new MockLlmClient('{"passed": false, "reason": "Not done"}');
  const result = await evaluateCriterionWithLlm(criterion, baseContext, mockClient);

  assert.equal(result.criterionId, 'C6');
  assert.equal(result.passed, true);
  assert.ok(result.reason.includes('verified=true'));
  // LLM should not have been called
  assert.equal(mockClient.calls.length, 0);
});

test('evaluateCriterionWithLlm: prompt contains criterion description and mission context', async () => {
  const criterion: CompletionCriterion = {
    id: 'C7',
    description: 'Feature X is fully implemented',
    required: true,
  };

  const mockClient = new MockLlmClient('{"passed": true, "reason": "Yes, done."}');
  await evaluateCriterionWithLlm(criterion, {
    ...baseContext,
    missionId: 'mission-prompt-check',
    taskSummary: 'T1:COMPLETED, T2:COMPLETED',
  }, mockClient);

  assert.equal(mockClient.calls.length, 1);
  const { userPrompt, systemPrompt } = mockClient.calls[0];

  // System prompt should ask for JSON output
  assert.ok(systemPrompt.includes('JSON'));
  assert.ok(systemPrompt.includes('"passed"'));

  // User prompt should contain criterion description
  assert.ok(userPrompt.includes('Feature X is fully implemented'));
  assert.ok(userPrompt.includes('C7'));

  // User prompt should contain mission context
  assert.ok(userPrompt.includes('mission-prompt-check'));
});

// ── computeVerificationWithLlm tests ──────────────────────────────────────────

test('computeVerificationWithLlm: all criteria pass → PASS status', async () => {
  const missionId = 'llm-compute-pass-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Implementation complete', required: true },
      { id: 'C2', description: 'Documentation written', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  // Both criteria return passed=true from mock
  const mockClient = new MockLlmClient([
    '{"passed": true, "reason": "Implementation done."}',
    '{"passed": true, "reason": "Docs written."}',
  ]);

  const computed = await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), mockClient);

  assert.equal(computed.verificationStatus, 'PASS');
  assert.equal(computed.missionStatus, 'COMPLETED');
  assert.equal(computed.criteriaResults.length, 2);
  assert.ok(computed.criteriaResults.every((r) => r.passed));
});

test('computeVerificationWithLlm: one required criterion fails → RETRYABLE_GAP', async () => {
  const missionId = 'llm-compute-gap-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Feature complete', required: true },
      { id: 'C2', description: 'Tests passing', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  const mockClient = new MockLlmClient([
    '{"passed": true, "reason": "Feature is complete."}',
    '{"passed": false, "reason": "Tests are failing."}',
  ]);

  const computed = await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), mockClient);

  assert.equal(computed.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(computed.missionStatus, 'ITERATING');
  const c2 = computed.criteriaResults.find((r) => r.criterionId === 'C2');
  assert.ok(c2);
  assert.equal(c2.passed, false);
  assert.ok(computed.gaps.some((g) => g.includes('C2')));
});

test('computeVerificationWithLlm: all criteria fail → RETRYABLE_GAP', async () => {
  const missionId = 'llm-compute-allfail-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Feature complete', required: true },
      { id: 'C2', description: 'Tests passing', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  const mockClient = new MockLlmClient([
    '{"passed": false, "reason": "Not complete."}',
    '{"passed": false, "reason": "Tests failing."}',
  ]);

  const computed = await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), mockClient);

  assert.equal(computed.verificationStatus, 'RETRYABLE_GAP');
  assert.equal(computed.criteriaResults.filter((r) => !r.passed).length, 2);
});

test('computeVerificationWithLlm: NONRETRYABLE_FAILURE when iteration limit reached', async () => {
  const missionId = 'llm-compute-nonretry-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    currentIteration: 3,
    maxIterations: 3,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Feature complete', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  const mockClient = new MockLlmClient('{"passed": false, "reason": "Still not done."}');

  const computed = await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), mockClient);

  assert.equal(computed.verificationStatus, 'NONRETRYABLE_FAILURE');
  assert.equal(computed.missionStatus, 'FAILED');
  assert.ok(computed.gaps.some((g) => g.includes('Max iterations reached')));
});

test('computeVerificationWithLlm: LLM errors gracefully fall back to heuristic per criterion', async () => {
  const missionId = 'llm-compute-error-fallback-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Implementation done', required: true },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  const errorClient = new ErrorLlmClient('API unavailable');

  // Should not throw — falls back to heuristic
  const computed = await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), errorClient);

  assert.ok(computed.verificationStatus !== undefined);
  assert.equal(computed.criteriaResults.length, 1);
  // Heuristic: no pending/failed tasks, plan present → passes
  assert.equal(computed.criteriaResults[0].passed, true);
});

test('computeVerificationWithLlm: criteria are evaluated serially (mock call count matches)', async () => {
  const missionId = 'llm-compute-serial-001';
  const { missionsDir } = makeMissionFixture(baseMission({
    missionId,
    tasks: [{ taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Step 1 complete', required: true },
      { id: 'C2', description: 'Step 2 complete', required: true },
      { id: 'C3', description: 'Step 3 complete', required: false },
    ],
  }));
  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  const args: VerifyInput = { missionsDir, missionId, dryRun: true };
  const mockClient = new MockLlmClient([
    '{"passed": true, "reason": "Done 1."}',
    '{"passed": true, "reason": "Done 2."}',
    '{"passed": true, "reason": "Done 3."}',
  ]);

  await computeVerificationWithLlm(args, requireMissionFromFixture(missionsDir, missionId), mockClient);

  // 3 criteria → 3 LLM calls
  assert.equal(mockClient.calls.length, 3);
});

// ── Helper ─────────────────────────────────────────────────────────────────────

function requireMissionFromFixture(missionsDir: string, missionId: string): Mission {
  const content = readFileSync(join(missionsDir, missionId, 'mission.json'), 'utf-8');
  return JSON.parse(content) as Mission;
}
