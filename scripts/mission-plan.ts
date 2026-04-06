#!/usr/bin/env node

import { join } from 'path';
import { pathToFileURL } from 'url';
import { readMission } from './lib/fs-utils.ts';
import { discoverAgents, matchAgentForTask } from './lib/mission-agent-discovery.ts';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { derivePhaseFromTask } from './lib/mission-helpers.ts';
import {
  buildPlannedOutput,
  buildPlannedOutputWithLlm,
  normalizeCustomTasks,
  parseCustomCriteria,
  parseCustomTasks,
  type PlannedOutput,
} from './lib/mission-planner.ts';
import { createLlmClient } from './lib/llm-client.ts';
import type { Mission } from './lib/types.ts';

// ── CLI Args ───────────────────────────────────────────────────────────────────

interface PlanArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  tasksFile: string | null;
  tasksJson: string | null;
  criteriaFile: string | null;
  criteriaJson: string | null;
  parallel: number | null;
  template: string | null;
  useLlm: boolean;
}

function parseArgs(argv: string[]): PlanArgs {
  const args: PlanArgs = {
    missionsDir: './missions',
    missionId: '',
    dryRun: false,
    tasksFile: null,
    tasksJson: null,
    criteriaFile: null,
    criteriaJson: null,
    parallel: null,
    template: null,
    useLlm: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--missions-dir':
        if (next) { args.missionsDir = next; index += 1; }
        break;
      case '--mission-id':
        if (next) { args.missionId = next; index += 1; }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--tasks-file':
        if (next) { args.tasksFile = next; index += 1; }
        break;
      case '--tasks-json':
        if (next) { args.tasksJson = next; index += 1; }
        break;
      case '--criteria-file':
        if (next) { args.criteriaFile = next; index += 1; }
        break;
      case '--criteria-json':
        if (next) { args.criteriaJson = next; index += 1; }
        break;
      case '--parallel': {
        const value = Number(next);
        if (Number.isInteger(value) && value >= 1) { args.parallel = value; index += 1; }
        break;
      }
      case '--template':
        if (next) { args.template = next; index += 1; }
        break;
      case '--use-llm':
        args.useLlm = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function assertRequired(args: PlanArgs): void {
  if (!args.missionId.trim()) {
    throw new Error('Missing required --mission-id');
  }

  const customTaskSources = [args.tasksFile, args.tasksJson, args.parallel !== null ? 'parallel' : null, args.template].filter(Boolean).length;
  if (customTaskSources > 1) {
    throw new Error('Use only one of --tasks-file, --tasks-json, --parallel, or --template');
  }

  if (args.criteriaFile && args.criteriaJson) {
    throw new Error('Use either --criteria-file or --criteria-json, not both');
  }
}

// ── Core execution (shared between sync and async paths) ───────────────────────

function buildRuleBasedOutput(args: PlanArgs, mission: Mission): PlannedOutput {
  const customTaskInput = parseCustomTasks({
    tasksJson: args.tasksJson,
    tasksFile: args.tasksFile,
    template: args.template,
  });
  const customTasks = customTaskInput ? normalizeCustomTasks(customTaskInput) : null;
  const customCriteria = parseCustomCriteria({
    criteriaJson: args.criteriaJson,
    criteriaFile: args.criteriaFile,
  });
  return buildPlannedOutput(mission, customTasks, customCriteria, args.parallel);
}

function applyOutputToMission(
  args: PlanArgs,
  mission: Mission,
  output: PlannedOutput,
  llmUsage: { model: string; inputTokens: number; outputTokens: number } | null
): { updatedMission: Mission; planPath: string; agentsDiscovered: number } {
  const agents = discoverAgents({
    channel: mission.owner?.channel ?? '',
    chatId: mission.owner?.chatId ?? '',
  });
  for (const task of output.tasks) {
    task.phase = derivePhaseFromTask(task);
    const matched = matchAgentForTask(task, agents);
    if (matched) {
      task.agent = matched.agentId;
      task.config = { ...task.config, agentMentionTag: matched.mentionTag, agentName: matched.name };
    }
  }

  const nowIso = new Date().toISOString();
  const nextWakeAt = mission.nextWakeAt ?? nowIso;
  const existingMetadata = mission.metadata ?? {};

  const updatedMission: Mission = {
    ...mission,
    status: 'PLANNED',
    updatedAt: nowIso,
    lastProgressAt: nowIso,
    nextWakeAt,
    completionCriteria: output.completionCriteria,
    tasks: output.tasks,
    artifacts: [
      ...(mission.artifacts ?? []).filter((artifact) => artifact.path !== 'plan.md'),
      {
        path: 'plan.md',
        type: 'document',
        description: 'Planner 生成的任务拆解与完成标准。',
        generatedAt: nowIso,
      },
    ],
    metadata: {
      ...existingMetadata,
      ...(llmUsage ? {
        llmPlannerUsage: {
          model: llmUsage.model,
          inputTokens: llmUsage.inputTokens,
          outputTokens: llmUsage.outputTokens,
          usedAt: nowIso,
        },
      } : {}),
    },
  };

  const missionDir = join(args.missionsDir, mission.missionId);
  const planPath = join(missionDir, 'plan.md');

  return { updatedMission, planPath, agentsDiscovered: agents.length };
}

function commitOutput(
  args: PlanArgs,
  mission: Mission,
  output: PlannedOutput,
  updatedMission: Mission,
  planPath: string,
  llmUsage: { model: string; inputTokens: number; outputTokens: number } | null,
  agentsDiscovered: number
): number {
  if (args.dryRun) {
    console.log(JSON.stringify({ missionId: mission.missionId, output, updatedMission, planPath }, null, 2));
    return 0;
  }

  const commitOk = commitMissionUpdate({
    missionsDir: args.missionsDir,
    oldMission: mission,
    newMission: updatedMission,
    dryRun: args.dryRun,
    source: 'planned',
    eventExtras: {
      taskCount: output.tasks.length,
      completionCriteriaCount: output.completionCriteria.length,
      artifactPath: 'plan.md',
      agentsDiscovered,
      ...(llmUsage ? { llmUsed: true, llmModel: llmUsage.model } : { llmUsed: false }),
    },
    artifactWrites: [{ path: planPath, content: output.planMarkdown }],
  });

  if (!commitOk) {
    console.error(`[mission-plan] failed | missionId=${mission.missionId}`);
    return 1;
  }

  console.log(`[mission-plan] planned | missionId=${mission.missionId} | tasks=${output.tasks.length} | criteria=${output.completionCriteria.length}`);
  console.log(planPath);
  return 0;
}

// ── Sync main (backward-compatible, no LLM support) ───────────────────────────

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseArgs(argv);
    assertRequired(args);

    const mission = readMission(args.missionsDir, args.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${args.missionId}`);
    }

    const output = buildRuleBasedOutput(args, mission);
    const { updatedMission, planPath, agentsDiscovered } = applyOutputToMission(args, mission, output, null);
    return commitOutput(args, mission, output, updatedMission, planPath, null, agentsDiscovered);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-plan] error | ${message}`);
    return 1;
  }
}

// ── Async main (supports --use-llm flag) ──────────────────────────────────────

export async function mainAsync(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    assertRequired(args);

    const mission = readMission(args.missionsDir, args.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${args.missionId}`);
    }

    let output: PlannedOutput;
    let llmUsage: { model: string; inputTokens: number; outputTokens: number } | null = null;

    if (args.useLlm && !args.tasksJson && !args.tasksFile && args.parallel === null && !args.template) {
      const llmClient = createLlmClient();
      if (llmClient) {
        try {
          const llmResult = await buildPlannedOutputWithLlm(mission, llmClient);
          llmUsage = llmResult.llmUsage;
          output = llmResult;
          console.log(`[mission-plan] llm-planner | model=${llmUsage.model} | inputTokens=${llmUsage.inputTokens} | outputTokens=${llmUsage.outputTokens}`);
        } catch (llmError) {
          const llmMessage = llmError instanceof Error ? llmError.message : String(llmError);
          console.warn(`[mission-plan] llm-planner failed, falling back to rule-based | ${llmMessage}`);
          output = buildRuleBasedOutput(args, mission);
        }
      } else {
        console.warn('[mission-plan] --use-llm specified but ANTHROPIC_API_KEY not set, falling back to rule-based planner');
        output = buildRuleBasedOutput(args, mission);
      }
    } else {
      if (args.useLlm) {
        console.info('[mission-plan] --use-llm ignored because custom tasks/template/parallel are specified');
      }
      output = buildRuleBasedOutput(args, mission);
    }

    const { updatedMission, planPath, agentsDiscovered } = applyOutputToMission(args, mission, output, llmUsage);
    return commitOutput(args, mission, output, updatedMission, planPath, llmUsage, agentsDiscovered);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-plan] error | ${message}`);
    return 1;
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────────

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const argv = process.argv.slice(2);
  const useLlm = argv.includes('--use-llm');
  if (useLlm) {
    process.exitCode = await mainAsync(argv);
  } else {
    process.exitCode = main(argv);
  }
}
