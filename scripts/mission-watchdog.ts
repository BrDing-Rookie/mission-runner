#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { appendEvent, listMissionIds, readMission, writeMission } from './lib/fs-utils.ts';
import { TERMINAL_STATUSES, DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from './lib/types.ts';
import {
  applyResultToMission,
  evaluateMission,
  logMissionResult,
  shouldAutoVerify,
  type ExtendedWatchdogConfig,
} from './lib/mission-watchdog-evaluator.ts';
import { runVerify } from './mission-verify.ts';

// ── CLI Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): ExtendedWatchdogConfig {
  const config: ExtendedWatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG, autoVerify: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--missions-dir': {
        const value = argv[index + 1];
        if (value) { config.missionsDir = value; index += 1; }
        break;
      }
      case '--dry-run': config.dryRun = true; break;
      case '--verbose': config.verbose = true; break;
      case '--auto-verify': config.autoVerify = true; break;
      case '--task-timeout-ms': {
        const value = Number(argv[index + 1]);
        if (Number.isFinite(value) && value > 0) { config.taskTimeoutMs = value; index += 1; }
        break;
      }
      case '--background-check-interval-ms': {
        const value = Number(argv[index + 1]);
        if (Number.isFinite(value) && value > 0) { config.backgroundCheckIntervalMs = value; index += 1; }
        break;
      }
      case '--max-idle-ms': {
        const value = Number(argv[index + 1]);
        if (Number.isFinite(value) && value > 0) { config.maxIdleTimeMs = value; index += 1; }
        break;
      }
      default: break;
    }
  }

  return config;
}

// ── Auto-verify wrapper ────────────────────────────────────────────────────────

function tryAutoVerify(config: ExtendedWatchdogConfig, mission: ReturnType<typeof readMission>): {
  verified: boolean;
  result?: ReturnType<typeof runVerify>;
} {
  if (!mission || !shouldAutoVerify(config, mission)) return { verified: false };

  console.log(`[mission-watchdog] auto-verify triggered | missionId=${mission.missionId} | status=${mission.status}`);
  try {
    const result = runVerify({
      missionsDir: config.missionsDir,
      missionId: mission.missionId,
      dryRun: config.dryRun,
    });
    return { verified: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-watchdog] auto-verify failed | missionId=${mission.missionId} | error=${message}`);
    return { verified: false };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main(): number {
  const config = parseArgs(process.argv.slice(2));
  const missionIds = listMissionIds(config.missionsDir);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  console.log(
    `[mission-watchdog] scan start | missionsDir=${config.missionsDir} | dryRun=${config.dryRun} | totalDirs=${missionIds.length}`
  );

  let scanned = 0;
  let skippedTerminal = 0;
  let missing = 0;

  for (const missionId of missionIds) {
    const mission = readMission(config.missionsDir, missionId);

    if (!mission) {
      missing += 1;
      console.warn(`[WARN] Missing or unreadable mission.json for ${missionId}`);
      continue;
    }

    if (TERMINAL_STATUSES.includes(mission.status)) {
      skippedTerminal += 1;
      if (config.verbose) {
        console.log(`[SKIP] ${mission.missionId} already terminal: ${mission.status}`);
      }
      continue;
    }

    scanned += 1;
    const result = evaluateMission(mission, config, nowMs);
    logMissionResult(result);

    if (!config.dryRun) {
      const updatedMission = applyResultToMission(mission, result, nowIso);
      const writeOk = writeMission(config.missionsDir, updatedMission);
      const eventOk = appendEvent(config.missionsDir, mission.missionId, {
        type: 'watchdog_check',
        action: result.action,
        reason: result.reason,
        currentStatus: result.currentStatus,
        suggestedNextWakeAt: result.suggestedNextWakeAt ?? null,
        relatedTaskIds: result.relatedTaskIds ?? [],
      });

      if (config.verbose) {
        console.log(
          `[WRITE] ${mission.missionId} mission=${writeOk ? 'ok' : 'fail'} event=${eventOk ? 'ok' : 'fail'}`
        );
      }

      const autoResult = tryAutoVerify(config, updatedMission);
      if (autoResult.verified && autoResult.result) {
        console.log(
          `[mission-watchdog] auto-verify done | missionId=${autoResult.result.missionId} | verification=${autoResult.result.verificationStatus} | status=${autoResult.result.missionStatus} | changed=${autoResult.result.changed}`
        );
      }
    } else {
      const autoResult = tryAutoVerify(config, mission);
      if (autoResult.verified) {
        console.log(`[mission-watchdog] auto-verify would trigger (dry-run) | missionId=${mission.missionId}`);
      }
    }
  }

  console.log(
    `[mission-watchdog] scan done | scanned=${scanned} | skippedTerminal=${skippedTerminal} | missing=${missing}`
  );

  return 0;
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}

// Re-export evaluateMission for tests and other scripts that import it
export { evaluateMission } from './lib/mission-watchdog-evaluator.ts';
