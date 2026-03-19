#!/usr/bin/env node
import { loadTextIfExists, missionPath, parseMissionCliArgs, persistMissionUpdate, requireMission, setMissionStatus, setVerification, upsertArtifact } from './lib/mission-helpers.ts';
function main(): number {
  try {
    const args = parseMissionCliArgs(process.argv.slice(2));
    const mission = requireMission(args);
    const tasks = mission.tasks ?? [];
    const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
    const failedTasks = tasks.filter((task) => task.status === 'FAILED');
    const pendingTasks = tasks.filter((task) => !['COMPLETED', 'SKIPPED'].includes(task.status));
    const planText = loadTextIfExists(missionPath(args.missionsDir, mission.missionId, 'plan.md'));
    const gaps: string[] = [];
    if (!planText) gaps.push('Missing plan.md artifact.');
    if (tasks.length === 0) gaps.push('Mission has no planned tasks.');
    if (pendingTasks.length > 0) gaps.push(`Pending non-terminal tasks: ${pendingTasks.map((task) => `${task.taskId}:${task.status}`).join(', ')}`);
    if (failedTasks.length > 0) gaps.push(`Failed tasks present: ${failedTasks.map((task) => task.taskId).join(', ')}`);
    const verificationStatus = gaps.length === 0 ? 'PASS' : 'RETRYABLE_GAP';
    const verificationSummary = gaps.length === 0 ? `Verification passed with ${completedTasks}/${tasks.length} tasks completed.` : `Verification found ${gaps.length} gap(s); completed ${completedTasks}/${tasks.length} tasks.`;
    const now = new Date().toISOString();
    const verificationFile = missionPath(args.missionsDir, mission.missionId, 'verification.md');
    const verificationMarkdown = [`# Verification for ${mission.missionId}`, '', `- status: ${verificationStatus}`, `- completedTasks: ${completedTasks}/${tasks.length}`, '', '## Summary', verificationSummary, '', '## Gaps', ...(gaps.length === 0 ? ['- none'] : gaps.map((gap) => `- ${gap}`)), ''].join('\n');
    const verifiedMission = setVerification(mission, { status: verificationStatus, summary: verificationSummary, gaps });
    const updated = { ...setMissionStatus(verifiedMission, verificationStatus === 'PASS' ? 'COMPLETED' : 'ITERATING'), artifacts: upsertArtifact(verifiedMission.artifacts, { path: `missions/${mission.missionId}/verification.md`, type: 'summary', description: 'Verification result summary', generatedAt: now }), nextWakeAt: verificationStatus === 'PASS' ? null : now };
    if (args.dryRun) { console.log(JSON.stringify({ missionId: mission.missionId, verificationStatus, missionStatus: updated.status, gaps }, null, 2)); return 0; }
    const result = persistMissionUpdate(args.missionsDir, updated, { type: 'mission_verified', verificationStatus, missionStatus: updated.status, gaps }, [{ path: verificationFile, content: verificationMarkdown }]);
    if (!result.writeOk || !result.eventOk || !result.artifactsOk) { console.error(`[mission-verify] failed | missionId=${mission.missionId} | write=${result.writeOk} | event=${result.eventOk} | artifacts=${result.artifactsOk}`); return 1; }
    console.log(`[mission-verify] verified | missionId=${mission.missionId} | verification=${verificationStatus} | status=${updated.status}`); return 0;
  } catch (error) { const message = error instanceof Error ? error.message : String(error); console.error(`[mission-verify] error | ${message}`); return 1; }
}
process.exitCode = main();
