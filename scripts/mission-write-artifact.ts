#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendEvent, safeWriteFile, writeMission } from './lib/fs-utils.ts';
import { nowIso, requireMission, upsertArtifact, upsertTaskArtifact } from './lib/mission-helpers.ts';
import type { Mission, MissionArtifact, Task, TaskArtifact } from './lib/types.ts';

interface MissionWriteArtifactCliArgs {
  missionsDir: string;
  missionId: string;
  taskId: string;
  path: string;
  content?: string;
  dryRun: boolean;
}

export interface MissionWriteArtifactResult {
  missionId: string;
  taskId: string;
  artifactPath: string;
  absolutePath: string;
  bytes: number;
  changed: boolean;
  dryRun: boolean;
}

interface MissionWriteArtifactOptions {
  stdinReader?: () => string;
}

function parseArgs(argv: string[]): MissionWriteArtifactCliArgs {
  const args: MissionWriteArtifactCliArgs = {
    missionsDir: './missions',
    missionId: '',
    taskId: '',
    path: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--task-id' && next) { args.taskId = next; i += 1; }
    else if (arg === '--path' && next) { args.path = next; i += 1; }
    else if (arg === '--content' && next !== undefined) { args.content = next; i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
  }

  return args;
}

function validateArgs(args: MissionWriteArtifactCliArgs): void {
  if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
  if (!args.taskId.trim()) throw new Error('Missing required --task-id');
  if (!args.path.trim()) throw new Error('Missing required --path');
}

function readContent(args: MissionWriteArtifactCliArgs, options?: MissionWriteArtifactOptions): string {
  if (args.content !== undefined) {
    return args.content;
  }

  return options?.stdinReader ? options.stdinReader() : readFileSync(0, 'utf-8');
}

function resolveArtifactPaths(missionsDir: string, missionId: string, inputPath: string): { absolutePath: string; missionRelativePath: string } {
  const normalizedInput = normalize(inputPath).replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.' || normalizedInput.startsWith('../') || normalizedInput.includes('/../') || normalizedInput.startsWith('/')) {
    throw new Error(`Invalid artifact --path: ${inputPath}`);
  }

  const artifactDir = resolve(missionsDir, missionId, 'artifacts');
  const absolutePath = resolve(artifactDir, normalizedInput);
  const relativeToArtifactDir = relative(artifactDir, absolutePath);
  if (relativeToArtifactDir.startsWith('..') || relativeToArtifactDir === '') {
    throw new Error(`Invalid artifact --path: ${inputPath}`);
  }

  return {
    absolutePath,
    missionRelativePath: `missions/${missionId}/artifacts/${relativeToArtifactDir.replace(/\\/g, '/')}`,
  };
}

function updateTaskArtifacts(task: Task, missionRelativePath: string): Task {
  const taskArtifact: TaskArtifact = {
    path: missionRelativePath,
    type: 'document',
    description: 'Artifact written via mission-write-artifact',
  };

  return {
    ...task,
    artifacts: upsertTaskArtifact(task.artifacts, taskArtifact),
  };
}

function updateMissionArtifacts(mission: Mission, missionRelativePath: string, generatedAt: string): MissionArtifact[] {
  return upsertArtifact(mission.artifacts, {
    path: missionRelativePath,
    type: 'document',
    description: 'Artifact written via mission-write-artifact',
    generatedAt,
  });
}

export function writeMissionArtifact(args: MissionWriteArtifactCliArgs, options?: MissionWriteArtifactOptions): MissionWriteArtifactResult {
  validateArgs(args);
  const mission = requireMission(args);
  const taskIndex = (mission.tasks ?? []).findIndex((task) => task.taskId === args.taskId);
  if (taskIndex === -1) {
    throw new Error(`Task not found: ${args.taskId}`);
  }

  const content = readContent(args, options);
  const { absolutePath, missionRelativePath } = resolveArtifactPaths(args.missionsDir, args.missionId, args.path);
  const timestamp = nowIso();
  const updatedTasks = [...(mission.tasks ?? [])];
  updatedTasks[taskIndex] = updateTaskArtifacts(updatedTasks[taskIndex] as Task, missionRelativePath);

  const updatedMission: Mission = {
    ...mission,
    tasks: updatedTasks,
    artifacts: updateMissionArtifacts(mission, missionRelativePath, timestamp),
    updatedAt: timestamp,
    lastProgressAt: timestamp,
  };

  if (!args.dryRun) {
    const writeArtifactOk = safeWriteFile(absolutePath, content);
    const writeMissionOk = writeMission(args.missionsDir, updatedMission);
    const eventOk = appendEvent(args.missionsDir, args.missionId, {
      type: 'mission_artifact_written',
      taskId: args.taskId,
      artifactPath: missionRelativePath,
      bytes: Buffer.byteLength(content, 'utf-8'),
    });

    if (!writeArtifactOk || !writeMissionOk || !eventOk) {
      throw new Error(`Failed to persist artifact write: file=${writeArtifactOk} mission=${writeMissionOk} event=${eventOk}`);
    }
  }

  return {
    missionId: args.missionId,
    taskId: args.taskId,
    artifactPath: missionRelativePath,
    absolutePath,
    bytes: Buffer.byteLength(content, 'utf-8'),
    changed: !args.dryRun,
    dryRun: args.dryRun,
  };
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const result = writeMissionArtifact(parseArgs(argv));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-write-artifact] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
