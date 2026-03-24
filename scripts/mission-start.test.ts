import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as missionStartMain } from './mission-start.ts';
import { readEvents, readMissionFile } from './test-helpers.ts';

test('mission-start chains create -> plan -> dispatch into a runnable mission', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-start-'));
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

  let exitCode: number;
  try {
    exitCode = missionStartMain([
      '--missions-dir', missionsDir,
      '--title', 'Unified startup mission',
      '--goal', 'Implement a minimal continuous mission flow',
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(exitCode, 0);
  assert.equal(logs.length, 1);
  const output = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
  const missionId = String(output.missionId ?? '');
  assert.match(missionId, /^mission-\d{8}-\d{3}$/);

  const mission = readMissionFile(missionsDir, missionId);
  assert.ok(['RUNNING', 'WAITING_BACKGROUND'].includes(mission.status));
  assert.ok((mission.tasks ?? []).length > 0);

  const events = readEvents(missionsDir, missionId);
  assert.deepEqual(events.map((event) => event.type), [
    'mission_created',
    'mission_planned',
    'mission_dispatched',
  ]);
});
