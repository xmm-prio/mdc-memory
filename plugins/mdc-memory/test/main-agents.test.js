/**
 * The shared main-agent tracking contract (`watchMainAgents`) that memory
 * tools and recall attach through, on the fake agent plane.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchMainAgents } from '../host/agents/main-agents.js';
import { createFakeCtx } from './support/fake-ctx.js';

/** Watch main agents on a fresh fake plugin context, recording attach and cleanup calls. */
function watch(fake = createFakeCtx({}), attach) {
  const attached = [];
  const cleaned = [];
  fake.ctx.inject(['agents'], (plane) => watchMainAgents(plane, attach ?? ((agent) => {
    attached.push(agent);
    return () => cleaned.push(agent);
  })));
  return { fake, attached, cleaned };
}

test('attaches to main agents that exist already and to those created later', async () => {
  const fake = createFakeCtx({});
  const before = await fake.agents.create();

  const { attached } = watch(fake);
  const later = await fake.agents.create();

  assert.deepEqual(attached, [before, later]);
});

test('never attaches to subagents, including a resumed subagent session', async () => {
  const { fake, attached } = watch();
  const main = await fake.agents.create();

  await fake.agents.create({ owner: main });
  await fake.agents.create({ origin: 'subagent' });

  assert.deepEqual(attached, [main]);
});

test('cleans up when the agent goes away, once', async () => {
  const { fake, cleaned } = watch();
  const gone = await fake.agents.create();
  const stays = await fake.agents.create();

  await fake.agents.dispose(gone);
  await fake.dispose();

  assert.deepEqual(cleaned, [gone, stays]);
});

test('cleans up every attached agent when the plugin is disposed, and attaches no more', async () => {
  const { fake, attached, cleaned } = watch();
  const first = await fake.agents.create();
  const second = await fake.agents.create();

  await fake.dispose();
  await fake.agents.create();

  assert.deepEqual(new Set(cleaned), new Set([first, second]));
  assert.deepEqual(attached, [first, second]);
});

test('a failing attach is logged and does not fail the agent', async () => {
  const fake = createFakeCtx({});
  watch(fake, () => { throw new Error('boom'); });

  const agent = await fake.agents.create();

  assert.ok(agent);
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('boom')), JSON.stringify(fake.logs));
});
