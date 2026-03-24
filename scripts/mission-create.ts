#!/usr/bin/env node

import { join } from 'path';
import { pathToFileURL } from 'url';
import { appendEvent, initMissionDirectory, listMissionIds, writeMission } from './lib/fs-utils.ts';
import type { Mission, MissionOwner } from './lib/types.ts';

interface CreateMissionArgs {
  missionsDir: string;
  title: string;
  goal: string;
  owner?: MissionOwner;
  maxIterations: number;
  dryRun: boolean;
  userMentionTag: string | null;
  orchestratorAgentId: string | null;
  orchestratorMentionTag: string | null;
}

function parseArgs(argv: string[]): CreateMissionArgs {
  const args: CreateMissionArgs = {
    missionsDir: './missions',
    title: '',
    goal: '',
    maxIterations: 6,
    dryRun: false,
    userMentionTag: null,
    orchestratorAgentId: null,
    orchestratorMentionTag: null,
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
      case '--title':
        if (next) {
          args.title = next;
          index += 1;
        }
        break;
      case '--goal':
        if (next) {
          args.goal = next;
          index += 1;
        }
        break;
      case '--session-key':
        if (next) {
          args.owner = { ...(args.owner ?? { sessionKey: next }), sessionKey: next };
          index += 1;
        }
        break;
      case '--channel':
        if (next) {
          args.owner = {
            ...(args.owner ?? { sessionKey: 'unknown-session' }),
            channel: next as MissionOwner['channel'],
          };
          index += 1;
        }
        break;
      case '--chat-id':
        if (next) {
          args.owner = { ...(args.owner ?? { sessionKey: 'unknown-session' }), chatId: next };
          index += 1;
        }
        break;
      case '--request-message-id':
        if (next) {
          args.owner = { ...(args.owner ?? { sessionKey: 'unknown-session' }), requestMessageId: next };
          index += 1;
        }
        break;
      case '--user-mention-tag':
        if (next) {
          args.userMentionTag = next;
          index += 1;
        }
        break;
      case '--orchestrator-agent-id':
        if (next) {
          args.orchestratorAgentId = next;
          index += 1;
        }
        break;
      case '--orchestrator-mention-tag':
        if (next) {
          args.orchestratorMentionTag = next;
          index += 1;
        }
        break;
      case '--max-iterations': {
        const value = Number(next);
        if (Number.isFinite(value) && value >= 1) {
          args.maxIterations = value;
          index += 1;
        }
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function assertRequired(args: CreateMissionArgs): void {
  if (!args.title.trim()) {
    throw new Error('Missing required --title');
  }

  if (!args.goal.trim()) {
    throw new Error('Missing required --goal');
  }
}

function nextMissionId(missionsDir: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `mission-${date}-`;
  const existingIds = listMissionIds(missionsDir)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isInteger(value));

  const nextSeq = (existingIds.length === 0 ? 1 : Math.max(...existingIds) + 1)
    .toString()
    .padStart(3, '0');

  return `${prefix}${nextSeq}`;
}

function buildMission(missionId: string, args: CreateMissionArgs, nowIso: string): Mission {
  // 将 userMentionTag 写入 owner
  const owner: MissionOwner | undefined = args.owner
    ? {
        ...args.owner,
        ...(args.userMentionTag ? { userMentionTag: args.userMentionTag } : {}),
      }
    : undefined;

  // 将 orchestrator 信息写入 metadata
  const metadata: Record<string, unknown> = {};
  if (args.orchestratorAgentId) metadata.orchestratorAgentId = args.orchestratorAgentId;
  if (args.orchestratorMentionTag) metadata.orchestratorMentionTag = args.orchestratorMentionTag;

  return {
    missionId,
    title: args.title.trim(),
    goal: args.goal.trim(),
    status: 'CREATED',
    owner,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastProgressAt: nowIso,
    nextWakeAt: nowIso,
    currentIteration: 0,
    maxIterations: args.maxIterations,
    completionCriteria: [],
    tasks: [],
    artifacts: [],
    backgroundProcesses: [],
    activeSessions: [],
    verification: {
      status: 'PENDING',
      lastCheckedAt: null,
      gaps: [],
      summary: null,
    },
    escalation: {
      level: null,
      reason: null,
      escalatedAt: null,
    },
    flags: {
      notifiedStart: false,
      notifiedComplete: false,
      notifiedEscalation: false,
      userUpdated: false,
    },
    metadata,
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    assertRequired(args);

    const nowIso = new Date().toISOString();
    const missionId = nextMissionId(args.missionsDir);
    const mission = buildMission(missionId, args, nowIso);
    const missionDir = join(args.missionsDir, missionId);

    if (args.dryRun) {
      console.log(JSON.stringify({ missionId, missionDir, mission }, null, 2));
      return 0;
    }

    initMissionDirectory(args.missionsDir, missionId);
    // 有意不使用 commitMissionUpdate()：创建者自己知道在创建，无需推送通知。
    // 后续状态变更（如 CREATED→PLANNED）会由 commitMissionUpdate 触发通知。
    const writeOk = writeMission(args.missionsDir, mission);
    const eventOk = appendEvent(args.missionsDir, missionId, {
      type: 'mission_created',
      title: mission.title,
      goal: mission.goal,
      status: mission.status,
      owner: mission.owner ?? null,
    });

    if (!writeOk || !eventOk) {
      console.error(`[mission-create] failed | missionId=${missionId} | write=${writeOk} | event=${eventOk}`);
      return 1;
    }

    console.log(`[mission-create] created | missionId=${missionId} | dir=${missionDir}`);
    console.log(join(missionDir, 'mission.json'));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-create] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
