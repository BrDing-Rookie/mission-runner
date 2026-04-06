#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { parseMissionCliArgs, persistMissionUpdate, requireMission, type MissionCliArgs } from './lib/mission-helpers.ts';
import { createLlmClient } from './lib/llm-client.ts';
import {
  computeVerification,
  computeVerificationWithLlm,
  type VerifyInput,
  type VerifyResult,
} from './lib/mission-verifier.ts';

// Re-export types and functions needed by other modules
export type { VerifyResult } from './lib/mission-verifier.ts';
export { extractPlanCriteria, listArtifactFiles } from './lib/mission-verifier.ts';

interface VerifyCliArgs extends MissionCliArgs {
  autoOnly: boolean;
  useLlm: boolean;
}

function parseVerifyCliArgs(argv: string[]): VerifyCliArgs {
  const base = parseMissionCliArgs(argv);
  let autoOnly = false;
  let useLlm = false;
  for (const arg of argv) {
    if (arg === '--auto-only') autoOnly = true;
    if (arg === '--use-llm') useLlm = true;
  }
  // Also support environment variable
  if (process.env.MISSION_USE_LLM === '1') useLlm = true;
  return { ...base, autoOnly, useLlm };
}

export function runVerify(args: VerifyInput): VerifyResult {
  const mission = requireMission(args);
  const computed = computeVerification(args, mission);

  if (args.dryRun || args.autoOnly) {
    return {
      missionId: mission.missionId,
      verificationStatus: computed.verificationStatus,
      missionStatus: computed.missionStatus,
      gaps: computed.gaps,
      criteriaResults: computed.criteriaResults,
      structuralChecks: computed.structuralChecks,
      success: true,
      changed: false,
      dryRun: args.dryRun ?? false,
    };
  }

  const persistResult = persistMissionUpdate(args.missionsDir, computed.updatedMission, {
    type: 'mission_verified',
    verificationStatus: computed.verificationStatus,
    missionStatus: computed.updatedMission.status,
    gaps: computed.gaps,
    criteriaResults: computed.criteriaResults,
  }, [{ path: computed.verificationFile, content: computed.verificationMarkdown }], mission);

  if (!persistResult.writeOk || !persistResult.eventOk || !persistResult.artifactsOk) {
    throw new Error(`Failed to persist verification: write=${persistResult.writeOk} event=${persistResult.eventOk} artifacts=${persistResult.artifactsOk}`);
  }

  return {
    missionId: mission.missionId,
    verificationStatus: computed.verificationStatus,
    missionStatus: computed.missionStatus,
    gaps: computed.gaps,
    criteriaResults: computed.criteriaResults,
    structuralChecks: computed.structuralChecks,
    success: true,
    changed: true,
    dryRun: false,
  };
}

export async function runVerifyAsync(args: VerifyInput & { useLlm?: boolean }): Promise<VerifyResult> {
  const mission = requireMission(args);

  let computed;

  if (args.useLlm) {
    const llmClient = createLlmClient();
    if (llmClient) {
      computed = await computeVerificationWithLlm(args, mission, llmClient);
    } else {
      console.warn('[mission-verify] --use-llm specified but ANTHROPIC_API_KEY not set; falling back to heuristic verification');
      computed = computeVerification(args, mission);
    }
  } else {
    computed = computeVerification(args, mission);
  }

  if (args.dryRun || args.autoOnly) {
    return {
      missionId: mission.missionId,
      verificationStatus: computed.verificationStatus,
      missionStatus: computed.missionStatus,
      gaps: computed.gaps,
      criteriaResults: computed.criteriaResults,
      structuralChecks: computed.structuralChecks,
      success: true,
      changed: false,
      dryRun: args.dryRun ?? false,
    };
  }

  const persistResult = persistMissionUpdate(args.missionsDir, computed.updatedMission, {
    type: 'mission_verified',
    verificationStatus: computed.verificationStatus,
    missionStatus: computed.updatedMission.status,
    gaps: computed.gaps,
    criteriaResults: computed.criteriaResults,
    llmEvaluated: Boolean(args.useLlm),
  }, [{ path: computed.verificationFile, content: computed.verificationMarkdown }], mission);

  if (!persistResult.writeOk || !persistResult.eventOk || !persistResult.artifactsOk) {
    throw new Error(`Failed to persist verification: write=${persistResult.writeOk} event=${persistResult.eventOk} artifacts=${persistResult.artifactsOk}`);
  }

  return {
    missionId: mission.missionId,
    verificationStatus: computed.verificationStatus,
    missionStatus: computed.missionStatus,
    gaps: computed.gaps,
    criteriaResults: computed.criteriaResults,
    structuralChecks: computed.structuralChecks,
    success: true,
    changed: true,
    dryRun: false,
  };
}

async function main(): Promise<number> {
  try {
    const args = parseVerifyCliArgs(process.argv.slice(2));

    let result: VerifyResult;

    if (args.useLlm) {
      result = await runVerifyAsync({ ...args, useLlm: true });
    } else {
      result = runVerify(args);
    }

    if (args.autoOnly) {
      // Auto-only mode: just output structural check results
      console.log(`[mission-verify] auto-only | missionId=${result.missionId}`);
      const checks = result.structuralChecks ?? [];
      const autoChecks = checks.filter((c) => c.type === 'AUTO');
      const passed = autoChecks.filter((c) => c.passed === true).length;
      const failed = autoChecks.filter((c) => c.passed === false).length;
      const skipped = autoChecks.filter((c) => c.passed === null).length;
      console.log(`  auto checks: ${passed} passed, ${failed} failed, ${skipped} inconclusive`);
      for (const check of checks) {
        const icon = check.passed === true ? '✅' : check.passed === false ? '❌' : '⏸️';
        console.log(`  ${icon} [${check.type}] ${check.criterion}`);
      }
      return failed > 0 ? 1 : 0;
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: result.missionId, verificationStatus: result.verificationStatus, missionStatus: result.missionStatus, gaps: result.gaps, criteriaResults: result.criteriaResults, structuralChecks: result.structuralChecks }, null, 2));
    } else {
      const llmTag = args.useLlm ? ' [LLM]' : '';
      console.log(`[mission-verify] verified${llmTag} | missionId=${result.missionId} | verification=${result.verificationStatus} | status=${result.missionStatus} | criteria=${result.criteriaResults.filter((r) => r.passed).length}/${result.criteriaResults.length}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-verify] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`[mission-verify] fatal | ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
