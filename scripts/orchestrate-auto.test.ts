/**
 * orchestrate-auto.test.ts
 *
 * Tests for --auto mode and related CLI parameter changes in mission-orchestrate.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as orchestrateMain } from './mission-orchestrate.ts';
import { writeMissionFixture } from './test-helpers.ts';

// ---------------------------------------------------------------------------
// Helper: build a minimal mission fixture
// ---------------------------------------------------------------------------

function makeMission(
  missionsDir: string,
  missionId: string,
  status: string,
): void {
  writeMissionFixture(missionsDir, {
    missionId,
    title: `Test ${missionId}`,
    goal: 'Auto mode test',
    // @ts-expect-error — status is typed but test fixture uses string
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastProgressAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    backgroundProcesses: [],
    completionCriteria: [],
  });
}

// ---------------------------------------------------------------------------
// 1. CLI parameter parsing — --auto flag enables auto mode
// ---------------------------------------------------------------------------

test('parseArgs: --auto flag accepted without --mission-id', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-parse-'));
  // Should NOT throw — auto mode doesn't require --mission-id
  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--once',
  ]);
  // No missions exist, so 0 active missions — should still exit 0
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// 2. CLI parameter parsing — --mission-id required without --auto
// ---------------------------------------------------------------------------

test('parseArgs: missing --mission-id without --auto returns exit code 1', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-no-id-'));
  const exitCode = orchestrateMain(['--missions-dir', missionsDir]);
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// 3. --auto skips terminal-status missions
// ---------------------------------------------------------------------------

test('auto --once: skips COMPLETED / FAILED / ESCALATED missions', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-skip-terminal-'));

  makeMission(missionsDir, 'mission-001', 'COMPLETED');
  makeMission(missionsDir, 'mission-002', 'FAILED');
  makeMission(missionsDir, 'mission-003', 'ESCALATED');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--once',
  ]);

  console.log = originalLog;

  assert.equal(exitCode, 0);

  // Parse the JSON output
  const jsonOutput = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
    round: number;
    totalActive: number;
    totalSkipped: number;
    missionResults: unknown[];
  };

  assert.equal(jsonOutput.round, 1);
  assert.equal(jsonOutput.totalActive, 0);
  assert.equal(jsonOutput.totalSkipped, 3);
  assert.deepEqual(jsonOutput.missionResults, []);
});

// ---------------------------------------------------------------------------
// 4. --auto --once exits after one round
// ---------------------------------------------------------------------------

test('auto --once: scans active missions and exits after one round', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-once-'));

  // One terminal, one active (CREATED — watchdog should output NONE since no tasks)
  makeMission(missionsDir, 'mission-active-001', 'CREATED');
  makeMission(missionsDir, 'mission-done-001', 'COMPLETED');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--once',
  ]);

  console.log = originalLog;

  assert.equal(exitCode, 0);

  const jsonOutput = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
    round: number;
    totalActive: number;
    totalSkipped: number;
    missionResults: unknown[];
  };

  assert.equal(jsonOutput.round, 1);
  assert.equal(jsonOutput.totalActive, 1);
  assert.equal(jsonOutput.totalSkipped, 1);
  assert.equal(jsonOutput.missionResults.length, 1);
});

// ---------------------------------------------------------------------------
// 5. --auto --interval-ms parameter parsed correctly (verified via no-error path)
// ---------------------------------------------------------------------------

test('auto: --interval-ms flag is accepted', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-interval-'));
  // With --once it exits immediately; just verify no parse error
  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--interval-ms', '5000',
    '--once',
  ]);
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// 6. --auto with explicit --mission-id only orchestrates that single mission
// ---------------------------------------------------------------------------

test('auto --once with --mission-id: only processes the specified mission', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-specific-'));

  makeMission(missionsDir, 'mission-specific-001', 'CREATED');
  makeMission(missionsDir, 'mission-specific-002', 'CREATED');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--mission-id', 'mission-specific-001',
    '--once',
  ]);

  console.log = originalLog;

  assert.equal(exitCode, 0);

  const jsonOutput = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
    round: number;
    totalActive: number;
    missionResults: Array<{ missionId: string }>;
  };

  assert.equal(jsonOutput.totalActive, 1);
  assert.equal(jsonOutput.missionResults.length, 1);
  assert.equal(jsonOutput.missionResults[0]?.missionId, 'mission-specific-001');
});

// ---------------------------------------------------------------------------
// 7. Single mission mode regression — behavior unchanged
// ---------------------------------------------------------------------------

test('single mission mode regression: --mission-id still works without --auto', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'single-regression-'));
  const missionId = 'mission-regression-001';

  // CREATED mission with no tasks and no background processes — watchdog returns NONE
  makeMission(missionsDir, missionId, 'CREATED');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--mission-id', missionId,
  ]);

  console.log = originalLog;

  assert.equal(exitCode, 0);

  // Output should be the single mission JSON (not the auto round summary)
  const jsonOutput = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
    missionId: string;
    finalStatus: string;
  };

  assert.equal(jsonOutput.missionId, missionId);
  assert.equal(jsonOutput.finalStatus, 'CREATED');
});

// ---------------------------------------------------------------------------
// 8. auto mode with no missions directory returns 0 (empty scan)
// ---------------------------------------------------------------------------

test('auto --once: empty missions dir returns 0 with 0 active 0 skipped', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'auto-empty-'));

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const exitCode = orchestrateMain([
    '--missions-dir', missionsDir,
    '--auto',
    '--once',
  ]);

  console.log = originalLog;

  assert.equal(exitCode, 0);

  const jsonOutput = JSON.parse(logs.find((l) => l.startsWith('{')) ?? '{}') as {
    totalActive: number;
    totalSkipped: number;
  };

  assert.equal(jsonOutput.totalActive, 0);
  assert.equal(jsonOutput.totalSkipped, 0);
});
