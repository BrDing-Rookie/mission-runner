#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { appendEvent } from './lib/fs-utils.ts';
import { parseMissionActionCliArgs } from './lib/mission-helpers.ts';
import { reconcileBackgroundMission } from './mission-reconcile-background.ts';
import type { MissionAction } from './lib/types.ts';

const SUPPORTED_ACTION: MissionAction = 'CHECK_BACKGROUND';

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseMissionActionCliArgs(argv);

    if (!args.missionId.trim()) {
      throw new Error('Missing required --mission-id');
    }

    if (!args.action.trim()) {
      throw new Error('Missing required --action');
    }

    if (args.action !== SUPPORTED_ACTION) {
      throw new Error(`Unsupported --action: ${args.action}. Only CHECK_BACKGROUND is supported.`);
    }

    const result = reconcileBackgroundMission({
      missionsDir: args.missionsDir,
      missionId: args.missionId,
      dryRun: args.dryRun,
    });

    if (!args.dryRun && result.changed) {
      const eventOk = appendEvent(args.missionsDir, result.missionId, {
        type: 'mission_action_executed',
        action: args.action,
        statusFrom: result.statusFrom,
        statusTo: result.finalStatus,
        success: result.success,
        changed: result.changed,
        progressed: result.progressed,
        dryRun: args.dryRun,
      });

      if (!eventOk) {
        console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=${eventOk}`);
        return 1;
      }
    }

    console.log(JSON.stringify({
      missionId: result.missionId,
      action: args.action,
      statusFrom: result.statusFrom,
      finalStatus: result.finalStatus,
      success: result.success,
      changed: result.changed,
      progressed: result.progressed,
      dryRun: args.dryRun,
      reconciledTaskIds: result.reconciledTaskIds,
      completedTaskIds: result.completedTaskIds,
      failedTaskIds: result.failedTaskIds,
    }, null, 2));

    return result.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-run-action] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
