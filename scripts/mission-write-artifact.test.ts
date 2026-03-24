import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMissionArtifact } from './mission-write-artifact.ts';
import { writeMissionFixture, readMissionFile, readEvents } from './test-helpers.ts';

function createMissionFixture(): { missionsDir: string; missionId: string } {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-write-artifact-'));
  const missionId = 'mission-write-artifact-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Write artifact test',
    goal: 'Verify artifact writes persist to mission storage',
    status: 'RUNNING',
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    lastProgressAt: '2026-03-20T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Produce output',
        type: 'document',
        status: 'RUNNING',
        artifacts: [],
      },
    ],
    artifacts: [],
    backgroundProcesses: [],
  });

  return { missionsDir, missionId };
}

test('mission-write-artifact persists file, task artifact and event with explicit content', () => {
  const { missionsDir, missionId } = createMissionFixture();

  const result = writeMissionArtifact({
    missionsDir,
    missionId,
    taskId: 'T1',
    path: 'reports/output.md',
    content: '# hello\nartifact body\n',
    dryRun: false,
  });

  assert.equal(result.artifactPath, `missions/${missionId}/artifacts/reports/output.md`);
  assert.equal(readFileSync(join(missionsDir, missionId, 'artifacts', 'reports', 'output.md'), 'utf-8'), '# hello\nartifact body\n');

  const mission = readMissionFile(missionsDir, missionId);
  assert.equal(mission.tasks?.[0]?.artifacts?.[0]?.path, `missions/${missionId}/artifacts/reports/output.md`);
  assert.equal(mission.artifacts?.[0]?.path, `missions/${missionId}/artifacts/reports/output.md`);

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'mission_artifact_written');
  assert.equal(events[0]?.taskId, 'T1');
  assert.equal(events[0]?.artifactPath, `missions/${missionId}/artifacts/reports/output.md`);
});

test('mission-write-artifact reads content from stdin when --content is omitted', () => {
  const { missionsDir, missionId } = createMissionFixture();
  const result = writeMissionArtifact({
    missionsDir,
    missionId,
    taskId: 'T1',
    path: 'stdin/output.txt',
    dryRun: false,
  }, {
    stdinReader: () => 'stdin artifact body\n',
  });

  assert.equal(result.taskId, 'T1');
  assert.equal(readFileSync(join(missionsDir, missionId, 'artifacts', 'stdin', 'output.txt'), 'utf-8'), 'stdin artifact body\n');
});
