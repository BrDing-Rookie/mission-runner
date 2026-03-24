#!/usr/bin/env node

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as createMain } from './mission-create.ts';
import { main as planMain } from './mission-plan.ts';
import { main as dispatchMain } from './mission-dispatch.ts';

export interface MissionStartArgs {
  missionsDir: string;
  title: string;
  goal: string;
  maxIterations?: number;
  dryRun: boolean;
  ownerArgs: string[];
  planArgs: string[];
}

export interface MissionStartResult {
  missionId: string;
  missionPath: string;
  steps: Array<{ step: 'create' | 'plan' | 'dispatch'; ok: boolean }>;
  dryRun: boolean;
}

function parseArgs(argv: string[]): MissionStartArgs {
  const args: MissionStartArgs = {
    missionsDir: './missions',
    title: '',
    goal: '',
    dryRun: false,
    ownerArgs: [],
    planArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--missions-dir':
        if (next) { args.missionsDir = next; i += 1; }
        break;
      case '--title':
        if (next) { args.title = next; i += 1; }
        break;
      case '--goal':
        if (next) { args.goal = next; i += 1; }
        break;
      case '--max-iterations': {
        const value = Number(next);
        if (Number.isFinite(value) && value >= 1) { args.maxIterations = value; i += 1; }
        break;
      }
      case '--session-key':
      case '--channel':
      case '--chat-id':
      case '--request-message-id':
        if (next) { args.ownerArgs.push(arg, next); i += 1; }
        break;
      case '--tasks-file':
      case '--tasks-json':
      case '--criteria-file':
      case '--criteria-json':
      case '--parallel':
        if (next) { args.planArgs.push(arg, next); i += 1; }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        break;
    }
  }

  if (!args.title.trim()) throw new Error('Missing required --title');
  if (!args.goal.trim()) throw new Error('Missing required --goal');
  return args;
}

function captureStdout<T>(fn: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  try { return { result: fn(), logs }; } finally { console.log = originalLog; }
}

function extractMissionPath(logs: string[]): string {
  const missionPath = logs.find((line) => line.trim().endsWith('/mission.json'));
  if (!missionPath) throw new Error('Failed to capture mission.json path from mission-create output');
  return missionPath.trim();
}

function missionIdFromPath(missionPath: string): string {
  const mission = JSON.parse(readFileSync(missionPath, 'utf-8')) as { missionId?: string };
  if (!mission.missionId) throw new Error(`Mission file missing missionId: ${missionPath}`);
  return mission.missionId;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const steps: MissionStartResult['steps'] = [];
    const effectiveMissionsDir = args.dryRun ? mkdtempSync(join(tmpdir(), 'mission-start-dryrun-')) : args.missionsDir;

    const createRun = captureStdout(() => createMain([
      '--missions-dir', effectiveMissionsDir,
      '--title', args.title,
      '--goal', args.goal,
      ...(args.maxIterations ? ['--max-iterations', String(args.maxIterations)] : []),
      ...args.ownerArgs,
    ]));
    steps.push({ step: 'create', ok: createRun.result === 0 });
    if (createRun.result !== 0) throw new Error('mission-create failed');

    const missionPath = extractMissionPath(createRun.logs);
    const missionId = missionIdFromPath(missionPath);

    const planRun = captureStdout(() => planMain([
      '--missions-dir', effectiveMissionsDir,
      '--mission-id', missionId,
      ...args.planArgs,
    ]));
    steps.push({ step: 'plan', ok: planRun.result === 0 });
    if (planRun.result !== 0) throw new Error(`mission-plan failed for ${missionId}`);

    const dispatchRun = captureStdout(() => dispatchMain([
      '--missions-dir', effectiveMissionsDir,
      '--mission-id', missionId,
    ]));
    steps.push({ step: 'dispatch', ok: dispatchRun.result === 0 });
    if (dispatchRun.result !== 0) throw new Error(`mission-dispatch failed for ${missionId}`);

    console.log(JSON.stringify({
      missionId,
      missionPath: args.dryRun ? join(args.missionsDir, missionId, 'mission.json') : missionPath,
      steps,
      dryRun: args.dryRun,
    } satisfies MissionStartResult, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-start] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) process.exitCode = main();
