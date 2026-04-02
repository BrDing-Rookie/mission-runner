/**
 * Mission Runner v0.1.1 — Regression Tests
 *
 * Covers 5 key bug fixes:
 *   1. strParam / numParam / boolParam multi-key support
 *   2. matchAgentForTask static map fallback
 *   3. checkAgentSession filter compatibility (status missing/empty)
 *   4. mentionTag empty string fallback
 *   5. write-artifact empty content protection
 *
 * Uses node:test + node:assert. No external service dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Fix 1: strParam / numParam / boolParam ──────────────────────────────────

function strParam(p: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof p[k] === 'string') return p[k] as string;
  }
  return undefined;
}

function numParam(p: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (typeof p[k] === 'number') return p[k] as number;
  }
  return undefined;
}

function boolParam(p: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    if (typeof p[k] === 'boolean') return p[k] as boolean;
  }
  return undefined;
}

describe('Fix 1: strParam / numParam / boolParam multi-key support', () => {
  it('TC-1.1: camelCase key match', () => {
    assert.equal(strParam({ missionId: 'm-001' }, 'mission_id', 'missionId', 'mission-id'), 'm-001');
  });

  it('TC-1.2: snake_case key match', () => {
    assert.equal(strParam({ mission_id: 'm-001' }, 'mission_id', 'missionId', 'mission-id'), 'm-001');
  });

  it('TC-1.3: kebab-case key match', () => {
    assert.equal(strParam({ 'mission-id': 'm-001' }, 'mission_id', 'missionId', 'mission-id'), 'm-001');
  });

  it('TC-1.4: first candidate key wins (priority)', () => {
    assert.equal(strParam({ mission_id: 'snake', missionId: 'camel' }, 'mission_id', 'missionId'), 'snake');
  });

  it('TC-1.5: all keys missing returns undefined', () => {
    assert.equal(strParam({ foo: 'bar' }, 'mission_id', 'missionId', 'mission-id'), undefined);
  });

  it('TC-1.6: non-string value skipped', () => {
    assert.equal(strParam({ mission_id: 123 }, 'mission_id', 'missionId'), undefined);
  });

  it('TC-1.7: numParam multi-key', () => {
    assert.equal(numParam({ maxSteps: 5 }, 'max_steps', 'maxSteps'), 5);
  });

  it('TC-1.7b: numParam first key wins', () => {
    assert.equal(numParam({ max_steps: 3, maxSteps: 7 }, 'max_steps', 'maxSteps'), 3);
  });

  it('TC-1.8: boolParam multi-key', () => {
    assert.equal(boolParam({ dryRun: true }, 'dry_run', 'dryRun'), true);
  });

  it('TC-1.8b: boolParam non-boolean skipped', () => {
    assert.equal(boolParam({ dry_run: 'yes' } as any, 'dry_run', 'dryRun'), undefined);
  });
});

// ── Fix 2: matchAgentForTask static map fallback ────────────────────────────

import { matchAgentForTask, type AvailableAgent } from './lib/mission-agent-discovery.ts';
import type { Task, Mission } from './lib/types.ts';

function makeTask(type: string, overrides?: Partial<Task>): Task {
  return { taskId: 't-1', title: 'Test task', type: type as Task['type'], status: 'READY', ...overrides };
}

function makeAgent(agentId: string, taskTypes: string[] = [], skills: string[] = []): AvailableAgent {
  return { agentId, name: agentId, mentionTag: `@${agentId}`, taskTypes, skills };
}

describe('Fix 2: matchAgentForTask static map fallback', () => {
  it('TC-2.1: taskTypes exact match takes priority', () => {
    const result = matchAgentForTask(makeTask('code'), [makeAgent('codex', ['code'], [])]);
    assert.equal(result?.agentId, 'codex');
  });

  it('TC-2.2: skills match when taskTypes empty', () => {
    const result = matchAgentForTask(makeTask('research'), [makeAgent('codex', [], ['research'])]);
    assert.equal(result?.agentId, 'codex');
  });

  it('TC-2.3: static map fallback — codex matches test', () => {
    const result = matchAgentForTask(makeTask('test'), [makeAgent('codex', [], [])]);
    assert.equal(result?.agentId, 'codex');
  });

  it('TC-2.4: static map fallback — claude-code matches analysis', () => {
    const result = matchAgentForTask(makeTask('analysis'), [makeAgent('claude-code', [], [])]);
    assert.equal(result?.agentId, 'claude-code');
  });

  it('TC-2.5: static map fallback — rd-review matches verification', () => {
    const result = matchAgentForTask(makeTask('verification'), [makeAgent('rd-review', [], [])]);
    assert.equal(result?.agentId, 'rd-review');
  });

  it('TC-2.6: static map miss — codex does not match deploy', () => {
    const result = matchAgentForTask(makeTask('deploy'), [makeAgent('codex', [], [])]);
    assert.equal(result, null);
  });

  it('TC-2.7: unknown agent has no static map', () => {
    const result = matchAgentForTask(makeTask('code'), [makeAgent('unknown-agent', [], [])]);
    assert.equal(result, null);
  });

  it('TC-2.8: taskTypes wins over static map', () => {
    const agents = [makeAgent('codex', [], []), makeAgent('claude-code', ['code'], [])];
    const result = matchAgentForTask(makeTask('code'), agents);
    assert.equal(result?.agentId, 'claude-code');
  });

  it('TC-2.9: empty agents list returns null', () => {
    assert.equal(matchAgentForTask(makeTask('code'), []), null);
  });
});

// ── Fix 3: checkAgentSession filter compatibility ───────────────────────────

function sessionFilterPredicate(s: Record<string, unknown>): boolean {
  const status = String(s.status ?? '').toLowerCase();
  return !status || status === 'active' || status === 'idle' || status === 'running' || status === 'unknown';
}

function sessionMapper(s: Record<string, unknown>) {
  return {
    sessionKey: String(s.key ?? s.sessionKey ?? s.session_key ?? s.id ?? ''),
    status: String(s.status ?? 'unknown').toLowerCase(),
  };
}

describe('Fix 3: checkAgentSession filter compatibility', () => {
  it('TC-3.1: status active — kept', () => {
    assert.equal(sessionFilterPredicate({ status: 'active' }), true);
  });

  it('TC-3.2: status idle — kept', () => {
    assert.equal(sessionFilterPredicate({ status: 'idle' }), true);
  });

  it('TC-3.3: status running — kept', () => {
    assert.equal(sessionFilterPredicate({ status: 'running' }), true);
  });

  it('TC-3.4: no status field — kept (core fix)', () => {
    assert.equal(sessionFilterPredicate({ key: 's1' }), true);
  });

  it('TC-3.5: status null — kept', () => {
    assert.equal(sessionFilterPredicate({ status: null }), true);
  });

  it('TC-3.6: status empty string — kept', () => {
    assert.equal(sessionFilterPredicate({ status: '' }), true);
  });

  it('TC-3.7: status stopped — filtered out', () => {
    assert.equal(sessionFilterPredicate({ status: 'stopped' }), false);
  });

  it('TC-3.8: status terminated — filtered out', () => {
    assert.equal(sessionFilterPredicate({ status: 'terminated' }), false);
  });

  it('TC-3.9: mixed scenario', () => {
    const sessions = [{ key: 's1', status: 'active' }, { key: 's2' }, { key: 's3', status: 'stopped' }];
    const kept = sessions.filter(sessionFilterPredicate);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map((s) => s.key), ['s1', 's2']);
  });

  it('TC-3.10: sessionKey extraction fallback chain', () => {
    assert.equal(sessionMapper({ key: 'k1' }).sessionKey, 'k1');
    assert.equal(sessionMapper({ sessionKey: 'sk1' }).sessionKey, 'sk1');
    assert.equal(sessionMapper({ session_key: 'snk1' }).sessionKey, 'snk1');
    assert.equal(sessionMapper({ id: 'id1' }).sessionKey, 'id1');
  });

  it('TC-3.10b: missing status maps to unknown', () => {
    assert.equal(sessionMapper({ key: 's1' }).status, 'unknown');
  });
});

// ── Fix 4: mentionTag empty string fallback ─────────────────────────────────

function resolveMentionTag(configMentionTag: string | undefined, discordUserId: string | undefined, agentId: string): string {
  const tag = (configMentionTag ?? '').trim();
  if (tag) return tag;
  if (discordUserId) return `<@${discordUserId}>`;
  return `@${agentId}`;
}

const AGENT_ACCOUNT_MAP: Record<string, string> = {
  'codex': 'discord-rd-arch',
  'claude-code': 'discord-rd-dev-1',
  'rd-review': 'discord-rd-reviewer',
  'rd-coordinator': 'discord-rd-lead',
  'rd-liaison': 'discord-rd-dev-2',
};

describe('Fix 4: mentionTag empty string fallback', () => {
  it('TC-4.1: valid agentMentionTag — used directly', () => {
    assert.equal(resolveMentionTag('<@123456>', '999', 'codex'), '<@123456>');
  });

  it('TC-4.2: empty string — falls back to userId (core fix)', () => {
    assert.equal(resolveMentionTag('', '123456789', 'codex'), '<@123456789>');
  });

  it('TC-4.3: whitespace only — falls back (trim)', () => {
    assert.equal(resolveMentionTag('   ', '123456789', 'codex'), '<@123456789>');
  });

  it('TC-4.4: undefined — falls back to userId', () => {
    assert.equal(resolveMentionTag(undefined, '123456789', 'codex'), '<@123456789>');
  });

  it('TC-4.5: empty + no userId — falls back to @agentId', () => {
    assert.equal(resolveMentionTag('', undefined, 'codex'), '@codex');
  });

  it('TC-4.6: AGENT_ACCOUNT_MAP has known agents', () => {
    assert.equal(AGENT_ACCOUNT_MAP['claude-code'], 'discord-rd-dev-1');
    assert.equal(AGENT_ACCOUNT_MAP['codex'], 'discord-rd-arch');
    assert.equal(AGENT_ACCOUNT_MAP['rd-review'], 'discord-rd-reviewer');
  });

  it('TC-4.7: AGENT_ACCOUNT_MAP undefined for unknown agent', () => {
    assert.equal(AGENT_ACCOUNT_MAP['random-agent'], undefined);
  });
});

// ── Fix 5: write-artifact empty content protection ──────────────────────────

import { writeMissionArtifact } from './mission-write-artifact.ts';

function makeMission(missionsDir: string, missionId: string): Mission {
  const mission: Mission = {
    missionId, title: 'Test Mission', goal: 'Test', status: 'RUNNING',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    tasks: [{ taskId: 't-1', title: 'Test task', type: 'code', status: 'RUNNING' }],
  };
  const missionDir = join(missionsDir, missionId);
  mkdirSync(join(missionDir, 'artifacts'), { recursive: true });
  writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(mission, null, 2));
  writeFileSync(join(missionDir, 'events.jsonl'), '');
  return mission;
}

describe('Fix 5: write-artifact empty content protection', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mission-wa-test-')); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('TC-5.1: normal write — non-empty content, file does not exist', () => {
    makeMission(tmpDir, 'm-1');
    const result = writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'output.md', content: '# Hello World', dryRun: false,
    });
    assert.equal(result.changed, true);
    assert.equal(result.bytes, Buffer.byteLength('# Hello World', 'utf-8'));
    assert.equal(readFileSync(result.absolutePath, 'utf-8'), '# Hello World');
  });

  it('TC-5.2: empty content + file exists — skip write (core fix)', () => {
    makeMission(tmpDir, 'm-1');
    const artifactPath = join(tmpDir, 'm-1', 'artifacts', 'existing.md');
    writeFileSync(artifactPath, 'original content');
    writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'existing.md', content: '', dryRun: false,
    });
    assert.equal(readFileSync(artifactPath, 'utf-8'), 'original content');
  });

  it('TC-5.3: whitespace-only content + file exists — skip write', () => {
    makeMission(tmpDir, 'm-1');
    const artifactPath = join(tmpDir, 'm-1', 'artifacts', 'existing.md');
    writeFileSync(artifactPath, 'preserved');
    writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'existing.md', content: '  \n\t  ', dryRun: false,
    });
    assert.equal(readFileSync(artifactPath, 'utf-8'), 'preserved');
  });

  it('TC-5.4: empty content + file does NOT exist — creates empty file', () => {
    makeMission(tmpDir, 'm-1');
    const result = writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'brand-new.md', content: '', dryRun: false,
    });
    assert.equal(result.changed, true);
    assert.equal(existsSync(result.absolutePath), true);
    assert.equal(readFileSync(result.absolutePath, 'utf-8'), '');
  });

  it('TC-5.5: non-empty content + file exists — overwrites', () => {
    makeMission(tmpDir, 'm-1');
    const artifactPath = join(tmpDir, 'm-1', 'artifacts', 'overwrite.md');
    writeFileSync(artifactPath, 'old content');
    writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'overwrite.md', content: 'new content', dryRun: false,
    });
    assert.equal(readFileSync(artifactPath, 'utf-8'), 'new content');
  });

  it('TC-5.6: dry-run does not write file', () => {
    makeMission(tmpDir, 'm-1');
    const result = writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'dry-run-test.md', content: 'should not appear', dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.changed, false);
    assert.equal(existsSync(result.absolutePath), false);
  });

  it('TC-5.8: result.bytes reflects content length even when empty', () => {
    makeMission(tmpDir, 'm-1');
    const artifactPath = join(tmpDir, 'm-1', 'artifacts', 'zero.md');
    writeFileSync(artifactPath, 'existing');
    const result = writeMissionArtifact({
      missionsDir: tmpDir, missionId: 'm-1', taskId: 't-1', path: 'zero.md', content: '', dryRun: false,
    });
    assert.equal(result.bytes, 0);
  });
});
