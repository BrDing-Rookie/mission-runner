#!/usr/bin/env tsx

import { pathToFileURL } from 'node:url';
import { listMissionIds, readMission } from './lib/fs-utils.ts';
import type { Mission, Task } from './lib/types.ts';

interface MissionListArgs {
  missionsDir: string;
  json: boolean;
}

interface MissionTaskRow {
  missionId: string;
  missionStatus: string;
  taskId: string;
  taskStatus: string;
  phase: string;
  agent: string;
  title: string;
}

function parseArgs(argv: string[]): MissionListArgs {
  const args: MissionListArgs = {
    missionsDir: './missions',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--missions-dir':
        if (next) {
          args.missionsDir = next;
          index += 1;
        }
        break;
      case '--json':
        args.json = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function getTaskPhase(task: Task): string {
  const configPhase = task.config?.phase;
  if (typeof configPhase === 'string' && configPhase.trim()) {
    return configPhase.trim();
  }
  return task.phase?.trim() || '—';
}

function loadMissions(missionsDir: string): Mission[] {
  return listMissionIds(missionsDir)
    .map((missionId) => readMission(missionsDir, missionId))
    .filter((mission): mission is Mission => mission !== null)
    .sort((left, right) => left.missionId.localeCompare(right.missionId));
}

function buildRows(missions: Mission[]): MissionTaskRow[] {
  const rows: MissionTaskRow[] = [];

  for (const mission of missions) {
    const tasks = mission.tasks ?? [];
    if (tasks.length === 0) {
      rows.push({
        missionId: mission.missionId,
        missionStatus: mission.status,
        taskId: '—',
        taskStatus: '—',
        phase: '—',
        agent: '—',
        title: mission.title,
      });
      continue;
    }

    for (const task of tasks) {
      rows.push({
        missionId: mission.missionId,
        missionStatus: mission.status,
        taskId: task.taskId,
        taskStatus: task.status,
        phase: getTaskPhase(task),
        agent: task.agent?.trim() || '—',
        title: task.title,
      });
    }
  }

  return rows;
}

function formatTable(rows: MissionTaskRow[]): string {
  if (rows.length === 0) {
    return 'No missions found.';
  }

  const headers: Array<keyof MissionTaskRow> = [
    'missionId',
    'missionStatus',
    'taskId',
    'taskStatus',
    'phase',
    'agent',
    'title',
  ];

  const widths = headers.map((header) => {
    const maxRowWidth = rows.reduce((max, row) => Math.max(max, String(row[header]).length), header.length);
    return maxRowWidth;
  });

  const renderRow = (row: MissionTaskRow | Record<string, string>): string => headers
    .map((header, index) => String(row[header]).padEnd(widths[index], ' '))
    .join(' | ');

  const divider = widths.map((width) => '-'.repeat(width)).join('-|-');
  return [renderRow(Object.fromEntries(headers.map((header) => [header, header]))), divider, ...rows.map(renderRow)].join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const missions = loadMissions(args.missionsDir);
    const rows = buildRows(missions);

    if (args.json) {
      console.log(JSON.stringify(missions, null, 2));
      return 0;
    }

    console.log(formatTable(rows));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-list] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  process.exitCode = main();
}
