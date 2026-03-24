#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { appendEvent, readMission } from './lib/fs-utils.ts';
import { main as dispatchMain } from './mission-dispatch.ts';
import { main as runActionMain } from './mission-run-action.ts';
import { evaluateMission } from './mission-watchdog-lib.ts';
import { DEFAULT_WATCHDOG_CONFIG, type MissionAction, type WatchdogConfig } from './lib/types.ts';

interface OrchestrateArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  verbose: boolean;
  maxSteps: number;
}

interface ExecutedStep {
  action: MissionAction | 'DISPATCH';
  exitCode: number;
}

function parseArgs(argv: string[]): OrchestrateArgs {
  const args: OrchestrateArgs = { missionsDir: './missions', missionId: '', dryRun: false, verbose: false, maxSteps: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
    else if (arg === '--verbose') { args.verbose = true; }
    else if (arg === '--max-steps' && next) { const value = Number(next); if (Number.isInteger(value) && value >= 1) { args.maxSteps = value; i += 1; } }
  }
  if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
  return args;
}

function captureStdout(fn: () => number): { exitCode: number; logs: string[] } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  try { return { exitCode: fn(), logs }; } finally { console.log = originalLog; }
}

function buildConfig(missionsDir: string, dryRun: boolean): WatchdogConfig {
  return { ...DEFAULT_WATCHDOG_CONFIG, missionsDir, dryRun };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const executed: ExecutedStep[] = [];
    const decisions: Array<{ step: number; action: MissionAction; reason: string }> = [];
    let dispatchTriggered = false;

    for (let step = 1; step <= args.maxSteps; step += 1) {
      const mission = readMission(args.missionsDir, args.missionId);
      if (!mission) throw new Error(`Mission not found: ${args.missionId}`);

      const decision = evaluateMission(mission, buildConfig(args.missionsDir, args.dryRun), Date.now());
      decisions.push({ step, action: decision.action, reason: decision.reason });
      let progressedThisStep = false;

      if (['CHECK_BACKGROUND', 'TRIGGER_VERIFY', 'RESUME_TASK', 'RETRY_TASK', 'ESCALATE_STUCK', 'NOTIFY_COMPLETE', 'NOTIFY_ESCALATION'].includes(decision.action)) {
        const actionRun = captureStdout(() => runActionMain([
          '--missions-dir', args.missionsDir,
          '--mission-id', args.missionId,
          '--action', decision.action,
          ...(args.dryRun ? ['--dry-run'] : []),
        ]));
        executed.push({ action: decision.action, exitCode: actionRun.exitCode });
        if (actionRun.exitCode !== 0) {
          if (args.verbose) actionRun.logs.forEach((line) => console.error(line));
          return actionRun.exitCode;
        }
        progressedThisStep = decision.action !== 'NONE';
        if (args.verbose) actionRun.logs.forEach((line) => console.log(line));
      }

      const postActionMission = readMission(args.missionsDir, args.missionId) ?? mission;
      const readyTasks = (postActionMission.tasks ?? []).filter((task) => task.status === 'READY');
      if (readyTasks.length > 0 && ['PLANNED', 'RUNNING', 'ITERATING', 'WAITING_EXTERNAL'].includes(postActionMission.status)) {
        const dispatchRun = captureStdout(() => dispatchMain([
          '--missions-dir', args.missionsDir,
          '--mission-id', args.missionId,
          ...(args.dryRun ? ['--dry-run'] : []),
        ]));
        executed.push({ action: 'DISPATCH', exitCode: dispatchRun.exitCode });
        dispatchTriggered = dispatchRun.exitCode === 0 || dispatchTriggered;
        if (dispatchRun.exitCode !== 0) {
          if (args.verbose) dispatchRun.logs.forEach((line) => console.error(line));
          return dispatchRun.exitCode;
        }
        progressedThisStep = true;
        if (args.verbose) dispatchRun.logs.forEach((line) => console.log(line));
      }

      if (!progressedThisStep) break;
    }

    const finalMission = readMission(args.missionsDir, args.missionId);
    if (!args.dryRun) {
      appendEvent(args.missionsDir, args.missionId, {
        type: 'mission_orchestrated',
        decisions,
        executed,
        dispatchTriggered,
        maxSteps: args.maxSteps,
        finalStatus: finalMission?.status ?? null,
      });
    }

    console.log(JSON.stringify({
      missionId: args.missionId,
      decisions,
      executed,
      dispatchTriggered,
      finalStatus: finalMission?.status ?? null,
      maxSteps: args.maxSteps,
      dryRun: args.dryRun,
    }, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-orchestrate] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) process.exitCode = main();
