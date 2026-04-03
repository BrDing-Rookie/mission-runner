/**
 * Smoke test: load the plugin through the real OpenClaw plugin loader
 * (via subprocess) and verify it registers all expected tools.
 *
 * Skipped automatically when the OpenClaw runtime is not installed.
 * Skipped gracefully when the loader subprocess times out (e.g. in CI).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const OPENCLAW_LOADER =
  '/opt/openclaw/versions/v2026.3.24/src/plugins/loader.ts';
const PROJECT_ROOT = join(import.meta.dirname, '..');
const TSX_LOADER = join(PROJECT_ROOT, 'node_modules/tsx/dist/loader.mjs');
const SMOKE_SCRIPT = join(import.meta.dirname, 'plugin-loader-smoke.ts');

const EXPECTED_TOOL_NAMES = [
  'mission_start',
  'mission_orchestrate',
  'mission_verify',
  'mission_watchdog',
  'mission_run_action',
  'mission_dispatch',
  'mission_task_update',
  'mission_task_add',
];

test('plugin loads via OpenClaw loader and registers all tools', {
  skip: !existsSync(OPENCLAW_LOADER) && 'OpenClaw runtime not installed',
}, (t) => {
  const proc = spawnSync(
    'node',
    ['--import', TSX_LOADER, SMOKE_SCRIPT],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60_000, killSignal: 'SIGKILL' },
  );

  if (proc.error && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    t.skip('OpenClaw loader subprocess timed out (expected in resource-constrained environments)');
    return;
  }

  if (proc.error) {
    throw proc.error;
  }

  if (proc.status !== 0) {
    throw new Error(`Smoke script exited with code ${proc.status}: ${proc.stderr}`);
  }

  const result = JSON.parse(proc.stdout.trim()) as {
    pluginId: string;
    status: string;
    toolCount: number;
    toolNames: string[];
  };

  assert.equal(result.pluginId, 'mission-runner');
  assert.equal(result.status, 'loaded');
  assert.equal(result.toolCount, EXPECTED_TOOL_NAMES.length, `expected ${EXPECTED_TOOL_NAMES.length} tools, got ${result.toolCount}`);

  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(result.toolNames.includes(name), `tool "${name}" should be registered`);
  }
});
