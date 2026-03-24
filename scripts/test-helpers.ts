import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mission } from './lib/types.ts';

export function writeMissionFixture(missionsDir: string, mission: Mission): void {
  const missionDir = join(missionsDir, mission.missionId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(mission, null, 2), { encoding: 'utf-8', flag: 'wx' });
  writeFileSync(join(missionDir, 'events.jsonl'), '', { encoding: 'utf-8', flag: 'wx' });
}

export function readMissionFile(missionsDir: string, missionId: string): Mission {
  return JSON.parse(readFileSync(join(missionsDir, missionId, 'mission.json'), 'utf-8')) as Mission;
}

export function readEvents(missionsDir: string, missionId: string): Array<Record<string, unknown>> {
  const content = readFileSync(join(missionsDir, missionId, 'events.jsonl'), 'utf-8').trim();
  if (!content) {
    return [];
  }

  return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}
