import assert from 'node:assert/strict';
import test from 'node:test';

function resolveMissionsDir(rawArgs: Record<string, unknown>, defaultMissionsDir: string): string {
  return typeof rawArgs.missions_dir === 'string' ? rawArgs.missions_dir : defaultMissionsDir;
}

test('plugin-configured missionsDir is used when tool caller omits missions_dir', () => {
  const resolved = resolveMissionsDir(
    { mission_id: 'mission-123', task_id: 'task-456', status: 'COMPLETED' },
    'custom-missions-root',
  );

  assert.equal(resolved, 'custom-missions-root');
});

test('explicit missions_dir overrides plugin-configured missionsDir', () => {
  const resolved = resolveMissionsDir(
    { missions_dir: 'explicit-missions-root', mission_id: 'mission-123', task_id: 'task-456', status: 'COMPLETED' },
    'custom-missions-root',
  );

  assert.equal(resolved, 'explicit-missions-root');
});
