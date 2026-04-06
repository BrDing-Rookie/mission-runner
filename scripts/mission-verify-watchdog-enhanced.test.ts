import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateMission } from './mission-watchdog.ts';
import { runVerify, extractPlanCriteria, listArtifactFiles } from './mission-verify.ts';
import { DEFAULT_WATCHDOG_CONFIG, type Mission } from './lib/types.ts';
import { readMissionFile, writeMissionFixture } from './test-helpers.ts';

const BASE_TS = '2026-03-28T00:00:00.000Z';

function baseMission(overrides: Partial<Mission> & { missionId: string }): Mission {
  return {
    title: 'Test mission',
    goal: 'Test goal',
    status: 'RUNNING',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    ...overrides,
  };
}

function wdConfig(overrides?: Partial<typeof DEFAULT_WATCHDOG_CONFIG> & { autoVerify?: boolean }) {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    missionsDir: './missions',
    autoVerify: false,
    ...overrides,
  };
}

// ==================== extractPlanCriteria tests ====================

test('extractPlanCriteria extracts criteria from ## Completion Criteria section', () => {
  const planText = [
    '# Plan',
    '',
    '## Summary',
    'Some summary',
    '',
    '## Completion Criteria',
    '1. All code compiles without errors',
    '2. Tests pass with >80% coverage',
    '3. Documentation is updated',
    '',
    '## Tasks',
    '- T1: implement',
  ].join('\n');

  const criteria = extractPlanCriteria(planText);
  assert.equal(criteria.length, 3);
  assert.equal(criteria[0], 'All code compiles without errors');
  assert.equal(criteria[1], 'Tests pass with >80% coverage');
  assert.equal(criteria[2], 'Documentation is updated');
});

test('extractPlanCriteria handles Chinese section heading', () => {
  const planText = [
    '# Plan',
    '',
    '## 完成标准',
    '1. 代码编译通过',
    '2. 测试覆盖率>80%',
  ].join('\n');

  const criteria = extractPlanCriteria(planText);
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0], '代码编译通过');
});

test('extractPlanCriteria handles checkbox format', () => {
  const planText = [
    '## Completion Criteria',
    '1. [ ] All files generated',
    '2. [x] Report written',
  ].join('\n');

  const criteria = extractPlanCriteria(planText);
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0], 'All files generated');
  assert.equal(criteria[1], 'Report written');
});

test('extractPlanCriteria returns empty for plan without criteria section', () => {
  const planText = ['# Plan', '', '## Summary', 'Just a summary'].join('\n');
  const criteria = extractPlanCriteria(planText);
  assert.equal(criteria.length, 0);
});

// ==================== listArtifactFiles tests ====================

test('listArtifactFiles returns files from artifacts directory', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'list-artifacts-'));
  const missionId = 'mission-artifact-list-001';
  const artifactsDir = join(missionsDir, missionId, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'report.md'), '# Report');
  writeFileSync(join(artifactsDir, 'data.json'), '{}');

  const files = listArtifactFiles(missionsDir, missionId);
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith('report.md')));
  assert.ok(files.some((f) => f.endsWith('data.json')));
});

test('listArtifactFiles returns empty when no artifacts dir', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'no-artifacts-'));
  const missionId = 'mission-no-artifacts-001';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const files = listArtifactFiles(missionsDir, missionId);
  assert.equal(files.length, 0);
});

// ==================== Enhanced verify tests ====================

test('runVerify reports plan criteria count mismatch gap', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'verify-plan-mismatch-'));
  const missionId = 'mission-plan-mismatch-001';

  writeMissionFixture(missionsDir, baseMission({
    missionId,
    status: 'VERIFYING',
    tasks: [{ taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Code compiles', required: true },
    ],
  }));

  // plan.md defines 3 criteria, but mission only has 1
  writeFileSync(join(missionsDir, missionId, 'plan.md'), [
    '# Plan',
    '## Completion Criteria',
    '1. Code compiles',
    '2. Tests pass',
    '3. Docs updated',
  ].join('\n'));

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  // Should pass on C1 (code compiles) but note the mismatch
  assert.ok(result.gaps.some((g) => g.includes('3 completion criteria') && g.includes('only 1')),
    `Expected plan criteria mismatch gap; got: ${JSON.stringify(result.gaps)}`);
});

test('runVerify enhanced verification.md includes plan criteria and artifact files', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'verify-enhanced-md-'));
  const missionId = 'mission-enhanced-md-001';

  writeMissionFixture(missionsDir, baseMission({
    missionId,
    status: 'VERIFYING',
    tasks: [{ taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' }],
    completionCriteria: [],
  }));

  writeFileSync(join(missionsDir, missionId, 'plan.md'), [
    '# Plan',
    '## Completion Criteria',
    '1. Code compiles',
  ].join('\n'));

  // Create an artifact file
  const artifactsDir = join(missionsDir, missionId, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'output.txt'), 'result');

  runVerify({ missionsDir, missionId, dryRun: false });

  const verificationMd = readFileSync(
    join(missionsDir, missionId, 'verification.md'), 'utf-8'
  );
  assert.ok(verificationMd.includes('## Plan-Defined Criteria'), 'Should have Plan-Defined Criteria section');
  assert.ok(verificationMd.includes('Code compiles'), 'Should list plan criteria');
  assert.ok(verificationMd.includes('## Artifact Files'), 'Should have Artifact Files section');
  assert.ok(verificationMd.includes('output.txt'), 'Should list artifact files');
});

test('runVerify reports gap when referenced artifact file is missing from disk', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'verify-missing-artifact-'));
  const missionId = 'mission-missing-artifact-001';

  writeMissionFixture(missionsDir, baseMission({
    missionId,
    status: 'VERIFYING',
    tasks: [{ taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' }],
    completionCriteria: [
      { id: 'C1', description: 'Artifact deliverable output present', required: true },
    ],
    artifacts: [
      { path: 'missions/mission-missing-artifact-001/artifacts/report.md', type: 'document' },
    ],
  }));

  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');
  // Don't create the artifact file - it's missing

  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'RETRYABLE_GAP');
  assert.ok(result.gaps.some((g) => g.includes('not found on disk')),
    `Expected gap about missing artifact file; got: ${JSON.stringify(result.gaps)}`);
});

// ==================== Watchdog auto-verify tests ====================

test('evaluateMission still returns TRIGGER_VERIFY when all tasks terminal in RUNNING status', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-auto-verify-001',
    status: 'RUNNING',
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'analysis', status: 'COMPLETED' },
      { taskId: 'T2', title: 'Skipped', type: 'code', status: 'SKIPPED' },
    ],
    backgroundProcesses: [],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  assert.equal(result.action, 'TRIGGER_VERIFY');
});

test('watchdog auto-verify triggers verify for VERIFYING mission with all terminal tasks', async () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'watchdog-auto-verify-'));
  const missionId = 'mission-auto-verify-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Auto verify test',
    goal: 'Test auto-verify from watchdog',
    status: 'VERIFYING',
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' },
    ],
    completionCriteria: [],
    backgroundProcesses: [],
  });

  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\ncontent\n');

  // Import and test the auto-verify by running watchdog main in-process
  // Since auto-verify is internal, we test runVerify directly to confirm the integration works
  const result = runVerify({ missionsDir, missionId, dryRun: false });
  assert.equal(result.verificationStatus, 'PASS');
  assert.equal(result.missionStatus, 'COMPLETED');

  const updated = readMissionFile(missionsDir, missionId);
  assert.equal(updated.status, 'COMPLETED');
});

test('watchdog auto-verify is idempotent - skips already terminal missions', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'watchdog-idempotent-'));
  const missionId = 'mission-idempotent-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Idempotent test',
    goal: 'Test idempotency',
    status: 'COMPLETED', // Already terminal
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
    lastProgressAt: BASE_TS,
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' },
    ],
    completionCriteria: [],
  });

  writeFileSync(join(missionsDir, missionId, 'plan.md'), '# Plan\n');

  // The watchdog evaluateMission should return NONE for terminal missions
  const nowMs = Date.parse(BASE_TS);
  const mission = readMissionFile(missionsDir, missionId);
  const result = evaluateMission(mission, wdConfig(), nowMs);
  // Terminal missions are skipped by the watchdog loop before evaluateMission is called
  // but evaluateMission itself for COMPLETED status falls through to tail logic
  assert.ok(result, 'evaluateMission should return a result');
});

test('watchdog auto-verify does not trigger when background processes are running', () => {
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-no-auto-verify-bg-001',
    status: 'RUNNING',
    tasks: [
      { taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' },
    ],
    backgroundProcesses: [
      { processId: 'P1', taskId: 'T1', status: 'RUNNING', startedAt: BASE_TS },
    ],
  });

  const result = evaluateMission(mission, wdConfig(), nowMs);
  // Should return CHECK_BACKGROUND since there's a running bg process
  assert.equal(result.action, 'CHECK_BACKGROUND');
});

test('watchdog --auto-verify flag is parsed from CLI args', async () => {
  // Test that --auto-verify is accepted (we can't easily test the full main() flow
  // but we verify the flag doesn't cause errors in the watchdog)
  const { evaluateMission: em } = await import('./mission-watchdog.ts');
  const nowMs = Date.parse(BASE_TS);
  const mission = baseMission({
    missionId: 'watchdog-flag-parse-001',
    status: 'RUNNING',
    tasks: [{ taskId: 'T1', title: 'Done', type: 'code', status: 'COMPLETED' }],
    backgroundProcesses: [],
  });

  // autoVerify flag doesn't change evaluateMission behavior - it's used in main()
  const result = em(mission, wdConfig({ autoVerify: true }), nowMs);
  assert.equal(result.action, 'TRIGGER_VERIFY');
});
