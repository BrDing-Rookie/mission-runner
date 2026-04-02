#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listMissionIds, readMission, safeWriteFile } from './lib/fs-utils.ts';
import { formatDashboard } from './lib/dashboard-formatter.ts';
import { ACTIVE_STATUSES, type Mission } from './lib/types.ts';

interface DashboardState {
  messageId: string;
  channelId: string;
  lastUpdatedAt: string;
  missionCount: number;
}

interface DashboardArgs {
  missionsDir: string;
  channelId: string;
  messageId: string | null;
  dashboardState: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): DashboardArgs {
  const args: DashboardArgs = {
    missionsDir: './missions',
    channelId: '',
    messageId: null,
    dashboardState: join('missions', '.dashboard.json'),
    verbose: false,
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
      case '--channel-id':
        if (next) {
          args.channelId = next;
          index += 1;
        }
        break;
      case '--message-id':
        if (next) {
          args.messageId = next;
          index += 1;
        }
        break;
      case '--dashboard-state':
        if (next) {
          args.dashboardState = next;
          index += 1;
        }
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        break;
    }
  }

  if (!args.channelId.trim()) {
    throw new Error('Missing required --channel-id');
  }

  return args;
}

function log(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(`[mission-dashboard] ${message}`);
  }
}

function readDashboardState(filePath: string): DashboardState | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as DashboardState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mission-dashboard] Failed to read dashboard state: ${message}`);
    return null;
  }
}

function loadActiveMissions(missionsDir: string): Mission[] {
  return listMissionIds(missionsDir)
    .map((missionId) => readMission(missionsDir, missionId))
    .filter((mission): mission is Mission => mission !== null)
    .filter((mission) => ACTIVE_STATUSES.includes(mission.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

function extractMessageId(output: string): string | null {
  const patterns = [
    /message(?:\s+id)?[:=\s]+([A-Za-z0-9_-]+)/i,
    /"messageId"\s*:\s*"([^"]+)"/i,
    /'messageId'\s*:\s*'([^']+)'/i,
    /\b([0-9]{8,})\b/,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function runCommand(argv: string[], verbose: boolean): string {
  log(verbose, `exec ${argv.join(' ')}`);
  return execFileSync(argv[0], argv.slice(1), {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function editDashboardMessage(messageId: string, content: string, verbose: boolean): void {
  runCommand(
    ['openclaw', 'message', 'edit', '--channel', 'discord', '--message-id', messageId, '--message', content],
    verbose,
  );
}

function sendDashboardMessage(channelId: string, content: string, verbose: boolean): string {
  const output = runCommand(
    ['openclaw', 'message', 'send', '--channel', 'discord', '--channel-id', channelId, '--message', content],
    verbose,
  );
  const messageId = extractMessageId(output);
  if (!messageId) {
    throw new Error(`Unable to extract message ID from openclaw output: ${output.trim() || '(empty output)'}`);
  }

  runCommand(
    ['openclaw', 'message', 'pin', '--channel', 'discord', '--message-id', messageId],
    verbose,
  );
  return messageId;
}

function writeDashboardState(filePath: string, state: DashboardState): void {
  const ok = safeWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
  if (!ok) {
    throw new Error(`Failed to write dashboard state: ${filePath}`);
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    const missions = loadActiveMissions(args.missionsDir);
    const content = formatDashboard(missions);
    const persistedState = readDashboardState(args.dashboardState);
    const existingMessageId = args.messageId ?? persistedState?.messageId ?? null;

    log(args.verbose, `loaded ${missions.length} active missions from ${args.missionsDir}`);

    const messageId = existingMessageId
      ? (editDashboardMessage(existingMessageId, content, args.verbose), existingMessageId)
      : sendDashboardMessage(args.channelId, content, args.verbose);

    const nextState: DashboardState = {
      messageId,
      channelId: args.channelId,
      lastUpdatedAt: new Date().toISOString(),
      missionCount: missions.length,
    };
    writeDashboardState(args.dashboardState, nextState);

    console.log(JSON.stringify(nextState, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-dashboard] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  process.exitCode = main();
}
