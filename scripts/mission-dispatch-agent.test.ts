import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as dispatchMain } from './mission-dispatch.ts';
import { writeMissionFixture, readMissionFile, readEvents } from './test-helpers.ts';

test('dispatch with agent assigned uses L3 dispatch queue fallback', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-dispatch-agent-'));
  const missionId = 'mission-dispatch-agent-test-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Agent dispatch test',
    goal: 'Verify agent-dispatch path is taken for tasks with agent',
    status: 'PLANNED',
    createdAt: '2026-03-30T00:00:00.000Z',
    updatedAt: '2026-03-30T00:00:00.000Z',
    owner: {
      sessionKey: 'test-session',
      channel: 'discord',
      chatId: 'test-channel-123',
    },
    tasks: [
      {
        taskId: 'T1',
        title: 'Analysis task with agent',
        type: 'analysis',
        status: 'READY',
        agent: 'codex',
        config: {
          agentId: 'codex',
          agentName: 'Codex',
          agentMentionTag: '<@12345>',
        },
      },
      {
        taskId: 'T2',
        title: 'Background task without agent',
        type: 'code',
        status: 'READY',
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = dispatchMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);

  // T1: has agent → should go through agent-dispatch path
  // Since there's no real OpenClaw CLI, all levels fail → task stays READY
  const t1 = updatedMission.tasks?.find((t) => t.taskId === 'T1');
  assert.ok(t1, 'T1 should exist');
  assert.equal(t1?.status, 'RUNNING', 'T1 should be RUNNING after L3 dispatch queue succeeds');
  assert.ok(t1?.config?.dispatchLevel, 'T1 should have dispatchLevel recorded');

  // T2: no agent → should go through background path
  const t2 = updatedMission.tasks?.find((t) => t.taskId === 'T2');
  assert.ok(t2, 'T2 should exist');
  assert.equal(t2?.status, 'WAITING_BACKGROUND', 'T2 should be WAITING_BACKGROUND');

  // Verify event log contains dispatch summary
  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'mission_dispatched');
  assert.ok(events[0]?.dispatchSummary, 'Event should contain dispatchSummary');
});

test('dispatch skips tasks with existing sessionKey (idempotent)', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-dispatch-idempotent-'));
  const missionId = 'mission-dispatch-idempotent-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Idempotent dispatch test',
    goal: 'Verify tasks with sessionKey are skipped',
    status: 'PLANNED',
    createdAt: '2026-03-30T00:00:00.000Z',
    updatedAt: '2026-03-30T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Already dispatched task',
        type: 'analysis',
        status: 'READY',
        sessionKey: 'existing-session-key',
        agent: 'codex',
        config: {
          agentId: 'codex',
          agentName: 'Codex',
        },
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = dispatchMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);
  const t1 = updatedMission.tasks?.find((t) => t.taskId === 'T1');
  assert.ok(t1, 'T1 should exist');
  assert.equal(t1?.status, 'RUNNING', 'T1 should be RUNNING');
  assert.equal(t1?.sessionKey, 'existing-session-key', 'sessionKey should be preserved');
});

test('dispatch with no agent falls back to original background logic', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-dispatch-no-agent-'));
  const missionId = 'mission-dispatch-no-agent-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'No agent dispatch test',
    goal: 'Verify original logic for tasks without agent',
    status: 'PLANNED',
    createdAt: '2026-03-30T00:00:00.000Z',
    updatedAt: '2026-03-30T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Research task',
        type: 'research',
        status: 'READY',
      },
      {
        taskId: 'T2',
        title: 'Code task',
        type: 'code',
        status: 'READY',
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = dispatchMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
  ]);

  assert.equal(exitCode, 0);

  const updatedMission = readMissionFile(missionsDir, missionId);
  const t1 = updatedMission.tasks?.find((t) => t.taskId === 'T1');
  assert.equal(t1?.status, 'RUNNING', 'research task should be RUNNING');

  const t2 = updatedMission.tasks?.find((t) => t.taskId === 'T2');
  assert.equal(t2?.status, 'WAITING_BACKGROUND', 'code task should be WAITING_BACKGROUND');

  // No agent dispatch, so no dispatchLevel should be set
  assert.equal(t1?.config?.dispatchLevel, undefined, 'No dispatchLevel for non-agent tasks');

  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 1);
  const summary = events[0]?.dispatchSummary as { totalReady: number } | undefined;
  assert.equal(summary?.totalReady, 0, 'No agent-dispatch results when no agent assigned');
});

test('dry-run dispatch shows dispatch summary without writing', () => {
  const missionsDir = mkdtempSync(join(tmpdir(), 'mission-dispatch-dryrun-'));
  const missionId = 'mission-dispatch-dryrun-001';

  writeMissionFixture(missionsDir, {
    missionId,
    title: 'Dry-run dispatch test',
    goal: 'Verify dry-run does not write',
    status: 'PLANNED',
    createdAt: '2026-03-30T00:00:00.000Z',
    updatedAt: '2026-03-30T00:00:00.000Z',
    tasks: [
      {
        taskId: 'T1',
        title: 'Agent task',
        type: 'analysis',
        status: 'READY',
        agent: 'codex',
        config: { agentId: 'codex' },
      },
    ],
    backgroundProcesses: [],
  });

  const exitCode = dispatchMain([
    '--missions-dir',
    missionsDir,
    '--mission-id',
    missionId,
    '--dry-run',
  ]);

  assert.equal(exitCode, 0);

  // Mission should be unchanged in dry-run
  const mission = readMissionFile(missionsDir, missionId);
  const t1 = mission.tasks?.find((t) => t.taskId === 'T1');
  assert.equal(t1?.status, 'READY', 'Task should remain READY in dry-run');

  // No events should be written
  const events = readEvents(missionsDir, missionId);
  assert.equal(events.length, 0, 'No events in dry-run');
});
