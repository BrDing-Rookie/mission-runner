import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWriteFile, writeMission } from './lib/fs-utils.ts';
import type { Mission } from './lib/types.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
}

function minimalMission(missionId: string): Mission {
  return {
    missionId,
    title: 'Atomic write test mission',
    goal: 'Verify atomic write behaviour',
    status: 'CREATED',
    createdAt: '2026-04-06T00:00:00.000Z',
    updatedAt: '2026-04-06T00:00:00.000Z',
    lastProgressAt: '2026-04-06T00:00:00.000Z',
    tasks: [],
    artifacts: [],
    backgroundProcesses: [],
  };
}

describe('safeWriteFile — atomic write', () => {
  it('writes content correctly and file is readable', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'output.txt');
    const content = 'hello atomic world\n';

    const result = safeWriteFile(filePath, content);

    assert.equal(result, true);
    assert.equal(readFileSync(filePath, 'utf-8'), content);
  });

  it('auto-creates parent directories when they do not exist', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'nested', 'deep', 'file.txt');
    const content = 'nested directory test';

    const result = safeWriteFile(filePath, content);

    assert.equal(result, true);
    assert.equal(readFileSync(filePath, 'utf-8'), content);
  });

  it('leaves no .tmp files after successful write', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'clean.txt');

    safeWriteFile(filePath, 'some content');

    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
    assert.deepEqual(tmpFiles, [], `Expected no tmp files, found: ${tmpFiles.join(', ')}`);
  });
});

describe('writeMission — atomic write', () => {
  it('writes mission.json content correctly', () => {
    const missionsDir = makeTmpDir();
    const missionId = 'mission-atomic-001';
    const mission = minimalMission(missionId);

    const result = writeMission(missionsDir, mission);

    assert.equal(result, true);
    const missionPath = join(missionsDir, missionId, 'mission.json');
    const parsed = JSON.parse(readFileSync(missionPath, 'utf-8')) as Mission;
    assert.equal(parsed.missionId, missionId);
    assert.equal(parsed.title, mission.title);
    assert.equal(parsed.status, 'CREATED');
  });

  it('auto-creates mission directory when it does not exist', () => {
    const missionsDir = join(makeTmpDir(), 'missions-subdir');
    const missionId = 'mission-atomic-002';
    const mission = minimalMission(missionId);

    const result = writeMission(missionsDir, mission);

    assert.equal(result, true);
    assert.ok(existsSync(join(missionsDir, missionId, 'mission.json')));
  });

  it('leaves no .tmp files after successful write', () => {
    const missionsDir = makeTmpDir();
    const missionId = 'mission-atomic-003';
    const mission = minimalMission(missionId);

    writeMission(missionsDir, mission);

    const missionDir = join(missionsDir, missionId);
    const entries = readdirSync(missionDir);
    const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
    assert.deepEqual(tmpFiles, [], `Expected no tmp files, found: ${tmpFiles.join(', ')}`);
  });
});
