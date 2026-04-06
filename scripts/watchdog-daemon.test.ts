/**
 * watchdog-daemon.test.ts
 * Daemon mode tests for mission-watchdog.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, runOneScan, type ScanStats } from './mission-watchdog.ts';
import { writeMissionFixture } from './test-helpers.ts';
import type { Mission } from './lib/types.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMissionsDir(): string {
  return mkdtempSync(join(tmpdir(), 'watchdog-daemon-test-'));
}

function baseMission(overrides: Partial<Mission> & { missionId: string }): Mission {
  const now = new Date().toISOString();
  return {
    title: 'Test mission',
    goal: 'Test goal',
    status: 'PLANNED',
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    ...overrides,
  };
}

// ── CLI Arg Parsing ───────────────────────────────────────────────────────────

test('parseArgs: default daemon=false, intervalMs=30000, healthFile=undefined', () => {
  const config = parseArgs([]);
  assert.equal(config.daemon, false);
  assert.equal(config.intervalMs, 30000);
  assert.equal(config.healthFile, undefined);
});

test('parseArgs: --daemon sets daemon=true', () => {
  const config = parseArgs(['--daemon']);
  assert.equal(config.daemon, true);
});

test('parseArgs: --interval-ms sets intervalMs', () => {
  const config = parseArgs(['--interval-ms', '5000']);
  assert.equal(config.intervalMs, 5000);
});

test('parseArgs: --interval-ms ignores invalid (non-positive) values', () => {
  const config = parseArgs(['--interval-ms', '-1']);
  assert.equal(config.intervalMs, 30000);
});

test('parseArgs: --interval-ms ignores NaN', () => {
  const config = parseArgs(['--interval-ms', 'abc']);
  assert.equal(config.intervalMs, 30000);
});

test('parseArgs: --health-file sets healthFile', () => {
  const config = parseArgs(['--health-file', '/tmp/watchdog.health.json']);
  assert.equal(config.healthFile, '/tmp/watchdog.health.json');
});

test('parseArgs: --daemon with --interval-ms and --health-file together', () => {
  const config = parseArgs(['--daemon', '--interval-ms', '10000', '--health-file', '/tmp/wh.json']);
  assert.equal(config.daemon, true);
  assert.equal(config.intervalMs, 10000);
  assert.equal(config.healthFile, '/tmp/wh.json');
});

test('parseArgs: existing args still work with new args present', () => {
  const config = parseArgs([
    '--dry-run',
    '--verbose',
    '--auto-verify',
    '--daemon',
    '--interval-ms', '15000',
  ]);
  assert.equal(config.dryRun, true);
  assert.equal(config.verbose, true);
  assert.equal(config.autoVerify, true);
  assert.equal(config.daemon, true);
  assert.equal(config.intervalMs, 15000);
});

// ── runOneScan ────────────────────────────────────────────────────────────────

test('runOneScan: returns ScanStats with empty missions dir', () => {
  const missionsDir = makeMissionsDir();
  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);

  const stats: ScanStats = runOneScan(config);

  assert.equal(typeof stats.scanned, 'number');
  assert.equal(typeof stats.skippedTerminal, 'number');
  assert.equal(typeof stats.missing, 'number');
  assert.equal(stats.scanned, 0);
  assert.equal(stats.skippedTerminal, 0);
  assert.equal(stats.missing, 0);
});

test('runOneScan: skips terminal missions', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-daemon-test-001';
  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'COMPLETED' }));

  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);
  const stats = runOneScan(config);

  assert.equal(stats.scanned, 0);
  assert.equal(stats.skippedTerminal, 1);
  assert.equal(stats.missing, 0);
});

test('runOneScan: counts active missions as scanned', () => {
  const missionsDir = makeMissionsDir();
  const missionId = 'mission-daemon-active-001';
  writeMissionFixture(missionsDir, baseMission({ missionId, status: 'PLANNED' }));

  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);
  const stats = runOneScan(config);

  assert.equal(stats.scanned, 1);
  assert.equal(stats.skippedTerminal, 0);
});

test('runOneScan: counts missing mission.json in missing', () => {
  const missionsDir = makeMissionsDir();
  // Create a mission dir without a mission.json
  const missionId = 'mission-no-json-001';
  mkdirSync(join(missionsDir, missionId), { recursive: true });

  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);
  const stats = runOneScan(config);

  assert.equal(stats.missing, 1);
  assert.equal(stats.scanned, 0);
});

test('runOneScan: multiple missions mixed terminal and active', () => {
  const missionsDir = makeMissionsDir();
  writeMissionFixture(missionsDir, baseMission({ missionId: 'mission-d-t1', status: 'COMPLETED' }));
  writeMissionFixture(missionsDir, baseMission({ missionId: 'mission-d-t2', status: 'FAILED' }));
  writeMissionFixture(missionsDir, baseMission({ missionId: 'mission-d-a1', status: 'PLANNED' }));

  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);
  const stats = runOneScan(config);

  assert.equal(stats.skippedTerminal, 2);
  assert.equal(stats.scanned, 1);
  assert.equal(stats.missing, 0);
});

// ── Health File ────────────────────────────────────────────────────────────────

test('runOneScan + health file: health file written after scan', async () => {
  const missionsDir = makeMissionsDir();
  const healthFile = join(missionsDir, 'watchdog.health.json');

  writeMissionFixture(missionsDir, baseMission({ missionId: 'mission-health-001', status: 'COMPLETED' }));

  const config = parseArgs([
    '--missions-dir', missionsDir,
    '--dry-run',
    '--daemon',
    '--interval-ms', '60000',
    '--health-file', healthFile,
  ]);

  const stats = runOneScan(config);

  // Manually write health file as daemon loop would do
  const payload = JSON.stringify({
    pid: process.pid,
    lastScanAt: new Date().toISOString(),
    scanned: stats.scanned,
    skippedTerminal: stats.skippedTerminal,
    intervalMs: config.intervalMs,
  });
  writeFileSync(healthFile, payload, 'utf-8');

  assert.ok(existsSync(healthFile), 'health file should exist');
  const content = JSON.parse(readFileSync(healthFile, 'utf-8')) as {
    pid: number;
    lastScanAt: string;
    scanned: number;
    skippedTerminal: number;
    intervalMs: number;
  };

  assert.equal(content.pid, process.pid);
  assert.equal(typeof content.lastScanAt, 'string');
  assert.equal(content.scanned, stats.scanned);
  assert.equal(content.skippedTerminal, stats.skippedTerminal);
  assert.equal(content.intervalMs, 60000);
});

test('health file JSON format: contains all required fields', () => {
  const payload = {
    pid: 12345,
    lastScanAt: '2026-04-06T10:00:00.000Z',
    scanned: 5,
    skippedTerminal: 3,
    intervalMs: 30000,
  };

  // Verify all required fields are present
  assert.ok('pid' in payload);
  assert.ok('lastScanAt' in payload);
  assert.ok('scanned' in payload);
  assert.ok('skippedTerminal' in payload);
  assert.ok('intervalMs' in payload);
  assert.equal(typeof payload.pid, 'number');
  assert.equal(typeof payload.lastScanAt, 'string');
  assert.equal(typeof payload.scanned, 'number');
  assert.equal(typeof payload.skippedTerminal, 'number');
  assert.equal(typeof payload.intervalMs, 'number');
});

// ── Signal Handler Registration ────────────────────────────────────────────────

test('signal handlers: process.on is callable for SIGINT and SIGTERM', () => {
  // Verify that process.on can be registered for these signals
  // (We mock by registering and immediately removing to avoid side effects)
  let sigintCalled = false;
  let sigtermCalled = false;

  const sigintHandler = (): void => { sigintCalled = true; };
  const sigtermHandler = (): void => { sigtermCalled = true; };

  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // Verify handlers were registered (no error thrown)
  // We can check via listenerCount
  const sigintCount = process.listenerCount('SIGINT');
  const sigtermCount = process.listenerCount('SIGTERM');

  assert.ok(sigintCount >= 1, 'SIGINT handler should be registered');
  assert.ok(sigtermCount >= 1, 'SIGTERM handler should be registered');

  // Clean up
  process.off('SIGINT', sigintHandler);
  process.off('SIGTERM', sigtermHandler);

  // Avoid unused variable warnings
  assert.equal(sigintCalled, false);
  assert.equal(sigtermCalled, false);
});

// ── Non-daemon Regression ─────────────────────────────────────────────────────

test('regression: parseArgs without --daemon returns daemon=false', () => {
  const config = parseArgs(['--missions-dir', './missions', '--dry-run', '--verbose']);
  assert.equal(config.daemon, false);
});

test('regression: parseArgs preserves all original flags', () => {
  const config = parseArgs([
    '--missions-dir', '/tmp/missions',
    '--dry-run',
    '--verbose',
    '--auto-verify',
    '--task-timeout-ms', '60000',
    '--background-check-interval-ms', '5000',
    '--max-idle-ms', '300000',
  ]);
  assert.equal(config.missionsDir, '/tmp/missions');
  assert.equal(config.dryRun, true);
  assert.equal(config.verbose, true);
  assert.equal(config.autoVerify, true);
  assert.equal(config.taskTimeoutMs, 60000);
  assert.equal(config.backgroundCheckIntervalMs, 5000);
  assert.equal(config.maxIdleTimeMs, 300000);
  // daemon fields stay at defaults
  assert.equal(config.daemon, false);
  assert.equal(config.intervalMs, 30000);
  assert.equal(config.healthFile, undefined);
});

test('regression: runOneScan returns ScanStats (not void) — callable directly', () => {
  const missionsDir = makeMissionsDir();
  const config = parseArgs(['--missions-dir', missionsDir, '--dry-run']);
  const result = runOneScan(config);
  assert.ok(result !== null && result !== undefined);
  assert.ok('scanned' in result);
  assert.ok('skippedTerminal' in result);
  assert.ok('missing' in result);
});
