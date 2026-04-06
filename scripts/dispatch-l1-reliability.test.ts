/**
 * dispatch-l1-reliability.test.ts
 *
 * Tests for L1 dispatch reliability improvements in dispatch-messenger.ts.
 * Since mentionInDiscord depends on safeExec calling an external CLI that is
 * unavailable in test environments, we test:
 *   A) Parameter validation (guards that return false before any exec)
 *   B) Exported retry-config constants are sane values
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mentionInDiscord,
  MENTION_MAX_RETRIES,
  MENTION_BASE_DELAY_MS,
} from './lib/dispatch-messenger.ts';
// MENTION_RESPONSE_TIMEOUT_MS is not exported, so we test its implied relationship
// via the exported constants only.

// ── A: Parameter validation ───────────────────────────────────────────────────

test('mentionInDiscord returns false when agentMentionTag is empty', () => {
  const result = mentionInDiscord('', '123456789012345678', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false when channelId is empty', () => {
  const result = mentionInDiscord('<@12345>', '', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false when message is empty', () => {
  const result = mentionInDiscord('<@12345>', '123456789012345678', '');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for non-snowflake channelId (letters)', () => {
  const result = mentionInDiscord('<@12345>', 'not-a-snowflake', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for channelId that is too short (< 17 digits)', () => {
  const result = mentionInDiscord('<@12345>', '1234567890', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for channelId that is too long (> 20 digits)', () => {
  const result = mentionInDiscord('<@12345>', '123456789012345678901', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for channelId containing newline (injection)', () => {
  const result = mentionInDiscord('<@12345>', '12345678901234567\n', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for channelId containing carriage return (injection)', () => {
  const result = mentionInDiscord('<@12345>', '12345678901234567\r', 'hello');
  assert.equal(result, false);
});

test('mentionInDiscord returns false for channelId containing null byte (injection)', () => {
  const result = mentionInDiscord('<@12345>', '12345678901234567\0', 'hello');
  assert.equal(result, false);
});

// ── B: Retry config constants ─────────────────────────────────────────────────

test('MENTION_MAX_RETRIES is at least 1', () => {
  assert.ok(MENTION_MAX_RETRIES >= 1, `Expected MENTION_MAX_RETRIES >= 1, got ${MENTION_MAX_RETRIES}`);
});

test('MENTION_BASE_DELAY_MS is positive', () => {
  assert.ok(MENTION_BASE_DELAY_MS > 0, `Expected MENTION_BASE_DELAY_MS > 0, got ${MENTION_BASE_DELAY_MS}`);
});

test('MENTION_MAX_RETRIES is at most 5 (sanity upper bound)', () => {
  assert.ok(MENTION_MAX_RETRIES <= 5, `MENTION_MAX_RETRIES=${MENTION_MAX_RETRIES} seems too high — would cause unacceptable dispatch latency`);
});

test('MENTION_BASE_DELAY_MS is at most 5000ms (sanity upper bound)', () => {
  assert.ok(MENTION_BASE_DELAY_MS <= 5_000, `MENTION_BASE_DELAY_MS=${MENTION_BASE_DELAY_MS} seems too high`);
});
