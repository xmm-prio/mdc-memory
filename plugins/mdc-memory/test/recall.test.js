/**
 * User-message recall (召回) through `apply(ctx, config)` with fake dsh
 * services: the recall settings API and the behaviors that need no search
 * results. Search behavior runs against a real basic-memory in
 * real-recall.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { apply } from '../host/index.js';
import { createFakeCtx, serveRoutes, waitForState } from './support/fake-ctx.js';
import { createFakeStorageDomain } from './support/fake-storage-domain.js';
import { basicMemoryServer, createFakeSubprocess, createGate } from './support/fake-subprocess.js';
import { makeSource } from './support/python-source.js';

let workdir;
let cleanups;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-recall-'));
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(workdir, { recursive: true, force: true });
});

/** Apply the Host plugin against a fake ctx and serve its routes. */
async function start({ subprocess = createFakeSubprocess(), storageDomain } = {}) {
  const fake = createFakeCtx({ subprocess, ...(storageDomain ? { storageDomain } : {}) });
  apply(fake.ctx, { dataDir: join(workdir, 'memory'), pythonSource: makeSource(join(workdir, 'basic-memory')) });
  const http = await serveRoutes(fake.routes);
  const stop = async () => {
    await http.close();
    await fake.dispose();
  };
  cleanups.push(stop);
  return { fake, http, stop };
}

test('recall settings start at the defaults', async () => {
  const { http } = await start();

  const settings = await http.request('GET', '/mdc-memory/recall-settings');

  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body, { onUserMessage: true, minSimilarity: 0.65, maxLessons: 3 });
});

test('a partial update changes only the given settings and survives a plugin reload', async () => {
  const storageDomain = createFakeStorageDomain();
  const first = await start({ storageDomain });

  const updated = await first.http.request('POST', '/mdc-memory/recall-settings/update', { body: { minSimilarity: 0.7, maxLessons: 5 } });
  const turnedOff = await first.http.request('POST', '/mdc-memory/recall-settings/update', { body: { onUserMessage: false } });

  assert.deepEqual([updated.status, updated.body], [200, { onUserMessage: true, minSimilarity: 0.7, maxLessons: 5 }]);
  assert.deepEqual(turnedOff.body, { onUserMessage: false, minSimilarity: 0.7, maxLessons: 5 });
  await first.stop();
  const second = await start({ storageDomain: createFakeStorageDomain(storageDomain.medium) });
  assert.deepEqual((await second.http.request('GET', '/mdc-memory/recall-settings')).body, { onUserMessage: false, minSimilarity: 0.7, maxLessons: 5 });
});

test('invalid recall settings are refused and leave the settings unchanged', async () => {
  const { http } = await start();
  const update = (body) => http.request('POST', '/mdc-memory/recall-settings/update', { body });

  const refusals = {
    thresholdAboveOne: await update({ minSimilarity: 1.2 }),
    thresholdNotNumber: await update({ minSimilarity: '0.6' }),
    zeroLessons: await update({ maxLessons: 0 }),
    tooManyLessons: await update({ maxLessons: 11 }),
    fractionalLessons: await update({ maxLessons: 2.5 }),
    switchNotBoolean: await update({ onUserMessage: 'yes' }),
    unknownField: await update({ topK: 3 }),
    notObject: await update([1]),
  };

  const outcome = (response) => ({ status: response.status, code: response.body.code, field: response.body.details?.field });
  assert.deepEqual(Object.fromEntries(Object.entries(refusals).map(([key, response]) => [key, outcome(response)])), {
    thresholdAboveOne: { status: 400, code: 'invalid-request', field: 'minSimilarity' },
    thresholdNotNumber: { status: 400, code: 'invalid-request', field: 'minSimilarity' },
    zeroLessons: { status: 400, code: 'invalid-request', field: 'maxLessons' },
    tooManyLessons: { status: 400, code: 'invalid-request', field: 'maxLessons' },
    fractionalLessons: { status: 400, code: 'invalid-request', field: 'maxLessons' },
    switchNotBoolean: { status: 400, code: 'invalid-request', field: 'onUserMessage' },
    unknownField: { status: 400, code: 'invalid-request', field: 'topK' },
    notObject: { status: 400, code: 'invalid-request', field: undefined },
  });
  assert.deepEqual((await http.request('GET', '/mdc-memory/recall-settings')).body, { onUserMessage: true, minSimilarity: 0.65, maxLessons: 3 });
});

test('a user message to a main agent goes on alone while basic-memory is not ready', async () => {
  const gate = createGate();
  const { fake } = await start({ subprocess: createFakeSubprocess({ uvSync: async () => { await gate.opened; return 0; } }) });
  const agent = await fake.agents.create();

  const entered = await fake.agents.sendUserMessage(agent, 'uv sync 把虚拟环境重建成 Python 3.14');

  assert.deepEqual(entered.map((message) => message.source.kind), ['user']);
  assert.deepEqual(fake.logs.filter((entry) => entry.level === 'warn' || entry.level === 'error'), []);
  gate.open();
});

test('a rejected step stays rejected', async () => {
  const { fake } = await start();
  const agent = await fake.agents.create();
  const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'uv sync 报错' }], source: { kind: 'user' } };

  const decision = await fake.waterfall('agent/pre-step', { agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject' }));

  assert.deepEqual(decision, { kind: 'reject' });
});

test('recall settings routes reject unauthenticated requests', async () => {
  const { http } = await start();

  assert.equal((await http.request('GET', '/mdc-memory/recall-settings', { auth: false })).status, 401);
  assert.equal((await http.request('POST', '/mdc-memory/recall-settings/update', { body: {}, auth: false })).status, 401);
});

const lessonHit = (name) => ({ title: name, type: 'entity', permalink: `kb/lessons/${name}`, project_id: 2, score: 0.8 });

/**
 * Answer the searches recall issues the way basic-memory tells them apart:
 * `semantic` for the semantic search above the threshold, `hybrid` for the
 * hybrid ranking, `outdated` for lessons marked outdated.
 */
const lessonSearch = ({ semantic, hybrid, outdated = [] }) => (query) => {
  if (query.status === 'outdated') return outdated;
  if (query.entity_types.includes('relation')) return [];
  return query.retrieval_mode === 'vector' ? semantic : hybrid;
};

/** Start against a ready basic-memory holding one enabled knowledge base, with searches answered by `search`. */
async function startWithLessons(search) {
  const knowledgeBase = { id: 2, external_id: 'kb-external-id', name: 'kb', path: join(workdir, 'kb'), is_default: false };
  const started = await start({ subprocess: createFakeSubprocess({ serve: basicMemoryServer({ projects: [knowledgeBase], search }) }) });
  await waitForState(started.http, 'ready');
  return started;
}

/** Titles of the lessons injected among the messages that entered the step, in order. */
function recalledTitles(entered) {
  const injection = entered.find((message) => message.source.kind === 'mdc-memory');
  return [...(injection?.content[0].text ?? '').matchAll(/^\d+\. (.+)$/gm)].map(([, title]) => title);
}

test('a lesson ranked below many outdated and already injected lessons is still recalled', async () => {
  const outdated = Array.from({ length: 40 }, (_, index) => lessonHit(`outdated-${index}`));
  const injected = Array.from({ length: 40 }, (_, index) => lessonHit(`injected-${index}`));
  const ranking = [...outdated, ...injected, lessonHit('current')];
  const { fake } = await startWithLessons(lessonSearch({ semantic: ranking, hybrid: ranking, outdated }));
  const agent = await fake.agents.create();
  agent.session.events.push({
    type: 'user/message',
    data: { role: 'user', content: [], source: { kind: 'mdc-memory', lessons: injected.map((hit) => hit.permalink) } },
  });

  const entered = await fake.agents.sendUserMessage(agent, 'pip install 一直报 ReadTimeoutError，连不上 PyPI，怎么解决？');

  assert.deepEqual(recalledTitles(entered), ['current']);
});

test('the hybrid ranking orders the eligible lessons, and the semantic order places those it does not rank', async () => {
  const [first, second, third, keywordOnly] = ['first', 'second', 'third', 'keyword-only'].map(lessonHit);
  const { fake } = await startWithLessons(lessonSearch({ semantic: [first, second, third], hybrid: [third, keywordOnly, first] }));
  const agent = await fake.agents.create();

  const entered = await fake.agents.sendUserMessage(agent, 'PowerShell 脚本里的中文字符串报解析错误');

  assert.deepEqual(recalledTitles(entered), ['third', 'first', 'second']);
});
