#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { appendEvent, listMissionIds, readMission } from './lib/fs-utils.ts';
import { main as dispatchMain } from './mission-dispatch.ts';
import { main as runActionMain } from './mission-run-action.ts';
import { evaluateMission } from './mission-watchdog-lib.ts';
import { DEFAULT_WATCHDOG_CONFIG, TERMINAL_STATUSES, type MissionAction, type WatchdogConfig } from './lib/types.ts';

interface OrchestrateArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  verbose: boolean;
  maxSteps: number;
  auto: boolean;
  intervalMs: number;
  once: boolean;
}

interface ExecutedStep {
  action: MissionAction | 'DISPATCH';
  exitCode: number;
}

function parseArgs(argv: string[]): OrchestrateArgs {
  const args: OrchestrateArgs = {
    missionsDir: './missions',
    missionId: '',
    dryRun: false,
    verbose: false,
    maxSteps: 3,
    auto: false,
    intervalMs: 60000,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const next = argv[i + 1];
    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
    else if (arg === '--verbose') { args.verbose = true; }
    else if (arg === '--max-steps' && next) { const value = Number(next); if (Number.isInteger(value) && value >= 1) { args.maxSteps = value; i += 1; } }
    else if (arg === '--auto') { args.auto = true; }
    else if (arg === '--interval-ms' && next) { const value = Number(next); if (Number.isInteger(value) && value >= 1000) { args.intervalMs = value; i += 1; } }
    else if (arg === '--once') { args.once = true; }
  }
  if (!args.auto && !args.missionId.trim()) throw new Error('Missing required --mission-id');
  return args;
}

function captureStdout(fn: () => number): { exitCode: number; logs: string[] } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  try { return { exitCode: fn(), logs }; } finally { console.log = originalLog; }
}

async function captureStdoutAsync(fn: () => Promise<number>): Promise<{ exitCode: number; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  try { return { exitCode: await fn(), logs }; } finally { console.log = originalLog; }
}

function buildConfig(missionsDir: string, dryRun: boolean): WatchdogConfig {
  return { ...DEFAULT_WATCHDOG_CONFIG, missionsDir, dryRun };
}

async function orchestrateSingleMission(args: OrchestrateArgs): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const executed: ExecutedStep[] = [];
  const decisions: Array<{ step: number; action: MissionAction; reason: string }> = [];
  let dispatchTriggered = false;
  let lastMission: ReturnType<typeof readMission> = null;

  for (let step = 1; step <= args.maxSteps; step += 1) {
    const mission = readMission(args.missionsDir, args.missionId);
    if (!mission) {
      const err = `Mission not found: ${args.missionId}`;
      console.error(`[mission-orchestrate] error | ${err}`);
      return { exitCode: 1, result: { missionId: args.missionId, error: err } };
    }

    const decision = evaluateMission(mission, buildConfig(args.missionsDir, args.dryRun), Date.now());
    decisions.push({ step, action: decision.action, reason: decision.reason });
    let progressedThisStep = false;

    if (['CHECK_BACKGROUND', 'COLLECT_RESULTS', 'TRIGGER_VERIFY', 'RESUME_TASK', 'RETRY_TASK', 'ESCALATE_STUCK', 'ESCALATE_MAX_RETRY', 'NOTIFY_COMPLETE', 'NOTIFY_ESCALATION'].includes(decision.action)) {
      const actionArgv = [
        '--missions-dir', args.missionsDir,
        '--mission-id', args.missionId,
        '--action', decision.action,
        ...(args.dryRun ? ['--dry-run'] : []),
      ];
      if (decision.relatedTaskIds && decision.relatedTaskIds.length > 0) {
        actionArgv.push('--task-ids', decision.relatedTaskIds.join(','));
      }
      const actionRun = captureStdout(() => runActionMain(actionArgv));
      executed.push({ action: decision.action, exitCode: actionRun.exitCode });
      if (actionRun.exitCode !== 0) {
        if (args.verbose) actionRun.logs.forEach((line) => console.error(line));
        return { exitCode: actionRun.exitCode, result: { missionId: args.missionId, error: 'action failed', exitCode: actionRun.exitCode } };
      }
      progressedThisStep = decision.action !== 'NONE';
      if (args.verbose) actionRun.logs.forEach((line) => console.log(line));
    }

    const postActionMission = readMission(args.missionsDir, args.missionId) ?? mission;
    lastMission = postActionMission;
    const readyTasks = (postActionMission.tasks ?? []).filter((task) => task.status === 'READY');
    if (readyTasks.length > 0 && ['PLANNED', 'RUNNING', 'ITERATING', 'WAITING_EXTERNAL'].includes(postActionMission.status)) {
      const dispatchRun = await captureStdoutAsync(() => dispatchMain([
        '--missions-dir', args.missionsDir,
        '--mission-id', args.missionId,
        ...(args.dryRun ? ['--dry-run'] : []),
      ]));
      executed.push({ action: 'DISPATCH', exitCode: dispatchRun.exitCode });
      dispatchTriggered = dispatchRun.exitCode === 0 || dispatchTriggered;
      if (dispatchRun.exitCode !== 0) {
        if (args.verbose) dispatchRun.logs.forEach((line) => console.error(line));
        return { exitCode: dispatchRun.exitCode, result: { missionId: args.missionId, error: 'dispatch failed', exitCode: dispatchRun.exitCode } };
      }
      progressedThisStep = true;
      if (args.verbose) dispatchRun.logs.forEach((line) => console.log(line));
    }

    if (!progressedThisStep) break;
  }

  const finalMission = lastMission ?? readMission(args.missionsDir, args.missionId);
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

  const result: Record<string, unknown> = {
    missionId: args.missionId,
    decisions,
    executed,
    dispatchTriggered,
    finalStatus: finalMission?.status ?? null,
    maxSteps: args.maxSteps,
    dryRun: args.dryRun,
  };
  return { exitCode: 0, result };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAutoMode(args: OrchestrateArgs): Promise<number> {
  let shuttingDown = false;

  const handleSignal = () => {
    shuttingDown = true;
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  let round = 0;

  try {
    do {
      round += 1;
      const allIds = args.missionId.trim()
        ? [args.missionId]
        : listMissionIds(args.missionsDir);

      const missionResults: Array<Record<string, unknown>> = [];
      let totalActive = 0;
      let totalSkipped = 0;

      for (const missionId of allIds) {
        try {
          const mission = readMission(args.missionsDir, missionId);
          if (!mission || TERMINAL_STATUSES.includes(mission.status)) {
            totalSkipped += 1;
            continue;
          }
          totalActive += 1;
          const singleArgs: OrchestrateArgs = { ...args, missionId };
          const { result } = await orchestrateSingleMission(singleArgs);
          missionResults.push(result);
        } catch (err) {
          // Per-mission error isolation: log and continue to next mission
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[mission-orchestrate] auto skipping ${missionId} | error=${msg}`);
          missionResults.push({ missionId, error: msg });
        }
      }

      const roundSummary = {
        round,
        missionResults,
        totalActive,
        totalSkipped,
      };
      console.log(JSON.stringify(roundSummary, null, 2));

      if (args.once || shuttingDown) break;

      await sleep(args.intervalMs);
    } while (!shuttingDown);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }

  if (shuttingDown) {
    console.log('[mission-orchestrate] auto shutdown gracefully');
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.auto) {
      return runAutoMode(args);
    }

    const { exitCode, result } = await orchestrateSingleMission(args);
    if (exitCode !== 0) return exitCode;
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-orchestrate] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`[mission-orchestrate] error | ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
