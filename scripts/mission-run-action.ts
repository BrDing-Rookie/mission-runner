#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { appendEvent } from './lib/fs-utils.ts';
import { parseMissionActionCliArgs } from './lib/mission-helpers.ts';
import { retryFailedTasks, setEscalationState, markNotificationFlag } from './lib/mission-actions.ts';
import { reconcileBackgroundMission } from './mission-reconcile-background.ts';
import { runVerify } from './mission-verify.ts';
import { main as resumeMain } from './mission-resume.ts';
import type { MissionAction } from './lib/types.ts';

const SUPPORTED_ACTIONS: MissionAction[] = ['CHECK_BACKGROUND', 'TRIGGER_VERIFY', 'RESUME_TASK', 'RETRY_TASK', 'ESCALATE_STUCK', 'NOTIFY_COMPLETE', 'NOTIFY_ESCALATION'];

function isResumeSummaryChanged(summary: string): boolean {
  return /\| resumed=(?!none)|\| unlocked=(?!none)/.test(summary);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const notificationOptions = {
    adapter: process.env.MISSION_NOTIFICATION_ADAPTER,
    discordChannel: process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL,
    discordUsername: process.env.MISSION_NOTIFICATION_DISCORD_USERNAME,
  };

  try {
    const args = parseMissionActionCliArgs(argv);

    if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
    if (!args.action.trim()) throw new Error('Missing required --action');
    if (!SUPPORTED_ACTIONS.includes(args.action as MissionAction)) {
      throw new Error(`Unsupported --action: ${args.action}. Supported: ${SUPPORTED_ACTIONS.join(', ')}`);
    }

    // ── CHECK_BACKGROUND ────────────────────────────────────────────────────
    if (args.action === 'CHECK_BACKGROUND') {
      const result = reconcileBackgroundMission({ missionsDir: args.missionsDir, missionId: args.missionId, dryRun: args.dryRun });
      if (!args.dryRun && result.changed) {
        const eventOk = appendEvent(args.missionsDir, result.missionId, {
          type: 'mission_action_executed', action: args.action, statusFrom: result.statusFrom,
          statusTo: result.finalStatus, success: result.success, changed: result.changed,
          progressed: result.progressed, dryRun: args.dryRun,
        });
        if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=${eventOk}`); return 1; }
      }
      console.log(JSON.stringify({
        missionId: result.missionId, action: args.action, statusFrom: result.statusFrom,
        finalStatus: result.finalStatus, success: result.success, changed: result.changed,
        progressed: result.progressed, dryRun: args.dryRun, reconciledTaskIds: result.reconciledTaskIds,
        completedTaskIds: result.completedTaskIds, failedTaskIds: result.failedTaskIds,
      }, null, 2));
      return result.success ? 0 : 1;
    }

    // ── TRIGGER_VERIFY ──────────────────────────────────────────────────────
    if (args.action === 'TRIGGER_VERIFY') {
      const result = runVerify({ missionsDir: args.missionsDir, missionId: args.missionId, dryRun: args.dryRun });
      if (!args.dryRun && result.changed) {
        const eventOk = appendEvent(args.missionsDir, result.missionId, {
          type: 'mission_action_executed', action: args.action, verificationStatus: result.verificationStatus,
          missionStatus: result.missionStatus, success: result.success, changed: result.changed, dryRun: args.dryRun,
        });
        if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=false`); return 1; }
      }
      console.log(JSON.stringify({
        missionId: result.missionId, action: args.action, verificationStatus: result.verificationStatus,
        missionStatus: result.missionStatus, gaps: result.gaps, criteriaResults: result.criteriaResults,
        success: result.success, changed: result.changed, dryRun: result.dryRun,
      }, null, 2));
      return result.success ? 0 : 1;
    }

    // ── RETRY_TASK ──────────────────────────────────────────────────────────
    if (args.action === 'RETRY_TASK') {
      const result = retryFailedTasks(args.missionsDir, args.missionId, args.dryRun);
      if (!args.dryRun && result.changed) {
        const eventOk = appendEvent(args.missionsDir, result.missionId, {
          type: 'mission_action_executed', action: args.action, missionStatus: result.missionStatus,
          retriedTaskIds: result.retriedTaskIds, success: result.success, changed: result.changed, dryRun: args.dryRun,
        });
        if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=false`); return 1; }
      }
      console.log(JSON.stringify(result, null, 2));
      return result.success ? 0 : 1;
    }

    // ── ESCALATE_STUCK ──────────────────────────────────────────────────────
    if (args.action === 'ESCALATE_STUCK') {
      const result = setEscalationState(args.missionsDir, args.missionId, args.dryRun, 'WARNING', 'Mission is stuck and needs human intervention.');
      if (!args.dryRun && result.changed) {
        const eventOk = appendEvent(args.missionsDir, result.missionId, {
          type: 'mission_action_executed', action: args.action, missionStatus: result.missionStatus,
          escalationReason: result.escalationReason, success: result.success, changed: result.changed, dryRun: args.dryRun,
        });
        if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=false`); return 1; }
      }
      console.log(JSON.stringify(result, null, 2));
      return result.success ? 0 : 1;
    }

    // ── NOTIFY_COMPLETE / NOTIFY_ESCALATION ─────────────────────────────────
    if (args.action === 'NOTIFY_COMPLETE' || args.action === 'NOTIFY_ESCALATION') {
      const result = args.action === 'NOTIFY_COMPLETE'
        ? markNotificationFlag(args.missionsDir, args.missionId, args.dryRun, 'notifiedComplete', 'mission_notified_complete', 'complete', notificationOptions)
        : markNotificationFlag(args.missionsDir, args.missionId, args.dryRun, 'notifiedEscalation', 'mission_notified_escalation', 'escalation', notificationOptions);
      if (!args.dryRun && result.changed) {
        const eventOk = appendEvent(args.missionsDir, result.missionId, {
          type: 'mission_action_executed', action: args.action, missionStatus: result.missionStatus,
          success: result.success, changed: result.changed, dryRun: args.dryRun,
        });
        if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${result.missionId} | action=${args.action} | event=false`); return 1; }
      }
      console.log(JSON.stringify(result, null, 2));
      return result.success ? 0 : 1;
    }

    // ── RESUME_TASK ─────────────────────────────────────────────────────────
    if (args.action === 'RESUME_TASK') {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...parts: unknown[]) => { logs.push(parts.map((part) => String(part)).join(' ')); };

      const resumeArgv = [
        '--missions-dir', args.missionsDir,
        '--mission-id', args.missionId,
        ...(args.dryRun ? ['--dry-run'] : []),
      ];

      try {
        const exitCode = resumeMain(resumeArgv);
        const summary = logs[0] ?? `[mission-resume] missionId=${args.missionId} | resumed=none | unlocked=none | status=unknown${args.dryRun ? ' | dry-run' : ''}`;
        const changed = isResumeSummaryChanged(summary);
        if (exitCode === 0 && !args.dryRun && changed) {
          const eventOk = appendEvent(args.missionsDir, args.missionId, {
            type: 'mission_action_executed', action: args.action, success: true,
            changed, dryRun: args.dryRun, summary,
          });
          if (!eventOk) { console.error(`[mission-run-action] failed | missionId=${args.missionId} | action=${args.action} | event=false`); return 1; }
        }
        console.log(summary);
        return exitCode;
      } finally {
        console.log = originalLog;
      }
    }

    throw new Error(`Unhandled action: ${args.action}`);
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
