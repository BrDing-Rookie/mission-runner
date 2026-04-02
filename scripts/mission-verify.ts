#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { parseMissionCliArgs, persistMissionUpdate, requireMission, type MissionCliArgs } from './lib/mission-helpers.ts';
import {
  computeVerification,
  type CriterionResult,
  type VerifyResult,
} from './lib/mission-verifier.ts';

// Re-export types and functions needed by other modules
export type { VerifyResult } from './lib/mission-verifier.ts';
export { extractPlanCriteria, listArtifactFiles } from './lib/mission-verifier.ts';

export function runVerify(args: MissionCliArgs): VerifyResult {
  const mission = requireMission(args);
  const computed = computeVerification(args, mission);

  if (args.dryRun) {
    return {
      missionId: mission.missionId,
      verificationStatus: computed.verificationStatus,
      missionStatus: computed.missionStatus,
      gaps: computed.gaps,
      criteriaResults: computed.criteriaResults,
      success: true,
      changed: false,
      dryRun: true,
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
    success: true,
    changed: true,
    dryRun: false,
  };
}

function main(): number {
  try {
    const args = parseMissionCliArgs(process.argv.slice(2));
    const result = runVerify(args);
    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: result.missionId, verificationStatus: result.verificationStatus, missionStatus: result.missionStatus, gaps: result.gaps, criteriaResults: result.criteriaResults }, null, 2));
    } else {
      console.log(`[mission-verify] verified | missionId=${result.missionId} | verification=${result.verificationStatus} | status=${result.missionStatus} | criteria=${result.criteriaResults.filter((r) => r.passed).length}/${result.criteriaResults.length}`);
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
  process.exitCode = main();
}
