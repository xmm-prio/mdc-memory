import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { apply } from '../host/index.js';
import { memoryScopes } from './support/agent-plane.js';
import { createFakeCtx, serveRoutes } from './support/fake-ctx.js';
import { basicMemoryServer, createFakeSubprocess, createGate } from './support/fake-subprocess.js';
import { makeSource } from './support/python-source.js';

let workdir;
let cleanups;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-host-'));
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(workdir, { recursive: true, force: true });
});

const sourceDir = () => join(workdir, 'basic-memory');

/**
 * Apply the Host plugin against a fake ctx and serve its routes.
 * @param {{ scopes?: object, beforeApply?: (fake: object) => Promise<void> }} [options] - the agent scopes adapter,
 *   and what happens before the plugin loads (e.g. creating agents).
 */
async function start(subprocess, config, { scopes, beforeApply } = {}) {
  const fake = createFakeCtx({ subprocess }, { scopes });
  await beforeApply?.(fake);
  apply(fake.ctx, { dataDir: join(workdir, 'memory'), ...config });
  const http = await serveRoutes(fake.routes);
  cleanups.push(() => http.close(), () => fake.dispose());
  return { fake, http };
}

/** Poll the status route until it reports `state`. */
async function waitForState(http, state, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await http.request('GET', '/mdc-memory/status');
    if (body.state === state) return body;
    if (Date.now() > deadline) assert.fail(`status stayed ${JSON.stringify(body)} instead of ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Poll until `probe` resolves to a truthy value. */
async function until(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) assert.fail('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const argValue = (argv, flag) => argv[argv.indexOf(flag) + 1];
const isInside = (path, dir) => path.startsWith(dir + (dir.includes('\\') ? '\\' : '/'));

test('status reports preparing while the environment is being built', async () => {
  const gate = createGate();
  const subprocess = createFakeSubprocess({ uvSync: async () => { await gate.opened; return 0; } });
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  const { status, body } = await http.request('GET', '/mdc-memory/status');

  assert.equal(status, 200);
  assert.equal(body.state, 'preparing');
  gate.open();
});

test('status shows the running stage and its latest output line', async () => {
  const gate = createGate();
  const subprocess = createFakeSubprocess({
    uvSync: async (proc) => {
      proc.stderr('Resolved 120 packages in 3ms');
      await gate.opened;
      return 0;
    },
  });
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  let body;
  await until(async () => {
    body = (await http.request('GET', '/mdc-memory/status')).body;
    return body.detail === 'Resolved 120 packages in 3ms';
  });

  assert.equal(body.state, 'preparing');
  assert.deepEqual(body.stages, [
    { id: 'source', state: 'done' },
    { id: 'venv', state: 'running' },
    { id: 'model', state: 'pending' },
    { id: 'server', state: 'pending' },
  ]);
  gate.open();
});

test('runtime routes reject unauthenticated requests', async () => {
  const { http } = await start(createFakeSubprocess(), { pythonSource: makeSource(sourceDir()) });

  assert.equal((await http.request('GET', '/mdc-memory/status', { auth: false })).status, 401);
  assert.equal((await http.request('POST', '/mdc-memory/retry', { body: {}, auth: false })).status, 401);
});

test('knowledge base routes reject unauthenticated requests', async () => {
  const { http } = await start(createFakeSubprocess(), { pythonSource: makeSource(sourceDir()) });

  assert.equal((await http.request('GET', '/mdc-memory/kbs', { auth: false })).status, 401);
  for (const path of ['/mdc-memory/kbs/add', '/mdc-memory/kbs/delete', '/mdc-memory/kbs/set-enabled']) {
    assert.equal((await http.request('POST', path, { body: {}, auth: false })).status, 401, path);
  }
});

test('knowledge base routes answer 503 until basic-memory is ready', async () => {
  const gate = createGate();
  const subprocess = createFakeSubprocess({ uvSync: async () => { await gate.opened; return 0; } });
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  const listed = await http.request('GET', '/mdc-memory/kbs');
  const added = await http.request('POST', '/mdc-memory/kbs/add', { body: { name: 'kb', path: join(workdir, 'kb') } });

  assert.deepEqual([listed.status, listed.body.code], [503, 'unavailable']);
  assert.deepEqual([added.status, added.body.code], [503, 'unavailable']);
  gate.open();
});

test('becomes ready with basic-memory on loopback, isolated inside dataDir', async () => {
  const subprocess = createFakeSubprocess();
  const source = makeSource(sourceDir());
  const dataDir = join(workdir, 'memory');
  const { http } = await start(subprocess, { pythonSource: source, dataDir });

  const ready = await waitForState(http, 'ready');

  assert.deepEqual(ready.stages.map((stage) => stage.state), ['done', 'done', 'done', 'done']);
  assert.equal(new URL(ready.endpoint).hostname, '127.0.0.1');
  assert.equal((await fetch(`${ready.endpoint}/v2/projects/`)).status, 200);

  const uv = subprocess.last('uvSync').spec;
  assert.deepEqual(uv.argv.slice(1), [
    '-m', 'uv', 'sync', '--python', '3.12', '--frozen', '--no-dev', '--no-editable', '--reinstall-package', 'basic-memory',
  ]);
  assert.equal(uv.cwd, source);
  assert.ok(isInside(uv.env.UV_PROJECT_ENVIRONMENT, dataDir));

  const model = subprocess.last('model').spec;
  assert.ok(isInside(model.argv[0], uv.env.UV_PROJECT_ENVIRONMENT), 'model download runs in the venv');
  assert.ok(model.argv.includes('BAAI/bge-small-zh-v1.5'));

  const serve = subprocess.last('serve').spec;
  assert.ok(isInside(serve.argv[0], uv.env.UV_PROJECT_ENVIRONMENT), 'server runs in the venv');
  assert.equal(argValue(serve.argv, '--host'), '127.0.0.1');
  assert.ok(isInside(serve.env.BASIC_MEMORY_CONFIG_DIR, dataDir));
  assert.ok(isInside(serve.env.BASIC_MEMORY_HOME, dataDir));
  assert.equal(serve.env.BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER, 'fastembed');
  assert.equal(serve.env.BASIC_MEMORY_SEMANTIC_EMBEDDING_MODEL, 'BAAI/bge-small-zh-v1.5');
  assert.equal(serve.env.BASIC_MEMORY_SEMANTIC_EMBEDDING_DIMENSIONS, '512');
  const cacheDir = serve.env.BASIC_MEMORY_SEMANTIC_EMBEDDING_CACHE_DIR;
  assert.ok(isInside(cacheDir, dataDir));
  assert.ok(model.argv.includes(cacheDir), 'model is pre-downloaded into the cache the server reads');
});

test('basic-memory segments Chinese text with jieba by default', async () => {
  const subprocess = createFakeSubprocess();
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  await waitForState(http, 'ready');

  const { env } = subprocess.last('serve').spec;
  assert.equal(env.BASIC_MEMORY_SCRIPT_SEGMENTATION, 'jieba');
  assert.equal(env.BASIC_MEMORY_SCRIPT_SEGMENTATION_USER_DICT, undefined);
});

test('the segmentation strategy and user dictionary come from the config', async () => {
  const userDict = join(workdir, 'terms.txt');
  const subprocess = createFakeSubprocess();
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()), segmentation: 'ngram', segmentationUserDict: userDict });

  await waitForState(http, 'ready');

  const { env } = subprocess.last('serve').spec;
  assert.equal(env.BASIC_MEMORY_SCRIPT_SEGMENTATION, 'ngram');
  assert.equal(env.BASIC_MEMORY_SCRIPT_SEGMENTATION_USER_DICT, userDict);
});

test('rejects an unknown segmentation strategy and a relative user dictionary path', () => {
  const fake = createFakeCtx({ subprocess: createFakeSubprocess() });
  cleanups.push(() => fake.dispose());
  const dataDir = join(workdir, 'memory');

  assert.throws(() => apply(fake.ctx, { dataDir, segmentation: 'bigram' }), /segmentation must be one of: jieba, ngram/);
  assert.throws(() => apply(fake.ctx, { dataDir, segmentationUserDict: 'terms.txt' }), /segmentationUserDict must be an absolute path/);
});

test('rejects a memory tool whitelist that is not a list of tool names', () => {
  const fake = createFakeCtx({ subprocess: createFakeSubprocess() });
  cleanups.push(() => fake.dispose());
  const dataDir = join(workdir, 'memory');

  assert.throws(() => apply(fake.ctx, { dataDir, memoryTools: 'search_notes' }), /memoryTools must be a list of tool names/);
  assert.throws(() => apply(fake.ctx, { dataDir, memoryTools: ['search notes'] }), /memoryTools must be a list of tool names/);
});

test('main agents are offered no memory tools, section or lesson skill while basic-memory is preparing', async () => {
  const gate = createGate();
  const subprocess = createFakeSubprocess({ uvSync: async () => { await gate.opened; return 0; } });
  const { fake } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  const agent = await fake.agents.create();

  assert.deepEqual(await fake.agents.toolNames(agent), []);
  assert.equal(await fake.agents.prompt(agent), '');
  assert.deepEqual(await fake.agents.skillNames(agent), []);
  gate.open();
});

test('main agents are offered no memory tools, section or lesson skill while no knowledge base exists', async () => {
  const { fake, http } = await start(createFakeSubprocess(), { pythonSource: makeSource(sourceDir()) });
  await waitForState(http, 'ready');

  const agent = await fake.agents.create();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(await fake.agents.toolNames(agent), []);
  assert.equal(await fake.agents.prompt(agent), '');
  assert.deepEqual(await fake.agents.skillNames(agent), []);
});

/**
 * Start against a basic-memory holding one enabled knowledge base and offering one memory tool.
 * @param {object} [options] - as for `start`.
 */
async function startWithKnowledgeBase(options) {
  const knowledgeBase = { id: 2, external_id: 'kb-external-id', name: 'kb', path: join(workdir, 'kb'), is_default: false };
  const searchNotes = {
    name: 'search_notes',
    description: 'Search notes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' } } },
  };
  const subprocess = createFakeSubprocess({ serve: basicMemoryServer({ projects: [knowledgeBase], tools: [searchNotes] }) });
  const started = await start(subprocess, { pythonSource: makeSource(sourceDir()) }, options);
  await waitForState(started.http, 'ready');
  return started;
}

/** Record this process's unhandled promise rejections for one test. */
function captureUnhandledRejections() {
  const reasons = [];
  const record = (reason) => { reasons.push(reason); };
  process.on('unhandledRejection', record);
  cleanups.push(() => process.off('unhandledRejection', record));
  return reasons;
}

test('an agent the memory offer cannot be attached to is logged and offered nothing, and other agents are still served', async () => {
  const rejections = captureUnhandledRejections();
  let blocked;
  let served;
  const { fake } = await startWithKnowledgeBase({
    beforeApply: async (agentsOwner) => {
      blocked = await agentsOwner.agents.create();
      blocked.ctx.systemPrompt.section({ name: 'mdc-memory', order: 0, text: 'a section another plugin registered first' });
      served = await agentsOwner.agents.create();
    },
  });

  await until(async () => (await fake.agents.skillNames(served)).length > 0);

  assert.deepEqual(await fake.agents.toolNames(served), ['memory_search_notes']);
  assert.deepEqual(await fake.agents.toolNames(blocked), [], 'nothing is left half-registered');
  assert.deepEqual(await fake.agents.skillNames(blocked), []);
  const warnings = fake.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
  assert.ok(warnings.some((message) => message.includes(blocked.id)), warnings.join('\n'));
  assert.deepEqual(rejections, []);
});

test('an agent whose scope already claims every memory tool is offered neither the section nor the lesson skill', async () => {
  let claimed;
  let served;
  const { fake } = await startWithKnowledgeBase({
    beforeApply: async (agentsOwner) => {
      claimed = await agentsOwner.agents.create();
      claimed.ctx.tools.register({ name: 'memory_search_notes', description: 'another plugin', parameters: { type: 'object' } });
      served = await agentsOwner.agents.create();
    },
  });

  await until(async () => (await fake.agents.skillNames(served)).length > 0);

  assert.doesNotMatch(await fake.agents.prompt(claimed), /^## Memory$/m);
  assert.deepEqual(await fake.agents.skillNames(claimed), []);
  const warnings = fake.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
  assert.ok(warnings.some((message) => message.includes(`memory_search_notes to agent ${claimed.id}`)), warnings.join('\n'));
});

test('without a skill registry, main agents are offered the memory tools and section but no lesson skill', async () => {
  const { fake } = await startWithKnowledgeBase({ scopes: memoryScopes({ skills: false }) });
  const agent = await fake.agents.create();

  await until(async () => (await fake.agents.toolNames(agent)).length > 0);

  assert.deepEqual(await fake.agents.toolNames(agent), ['memory_search_notes']);
  assert.match(await fake.agents.prompt(agent), /^## Memory$/m);
  assert.deepEqual(await fake.agents.skillNames(agent), []);
});

test('a main agent can discover and load the lesson skill while a knowledge base is effective', async () => {
  const { fake } = await startWithKnowledgeBase();
  const agent = await fake.agents.create();

  await until(async () => (await fake.agents.skillNames(agent)).length > 0);

  assert.deepEqual(await fake.agents.skillNames(agent), ['lesson']);
  const skill = await fake.agents.loadSkill(agent, 'lesson');
  assert.equal(skill.name, 'lesson');
  assert.match(skill.description, /type: lesson/);
  assert.match(skill.content, /^# /, 'instructions start after the frontmatter');
  assert.doesNotMatch(skill.content, /^name: lesson$/m);
  assert.match(skill.content, /memory_write_note/);
});

test('subagents are offered no lesson skill', async () => {
  const { fake } = await startWithKnowledgeBase();
  const main = await fake.agents.create();
  await until(async () => (await fake.agents.skillNames(main)).length > 0);

  const delegated = await fake.agents.create({ parent: main });
  const resumedChild = await fake.agents.create({ origin: 'subagent' });

  for (const agent of [delegated, resumedChild]) {
    assert.deepEqual(await fake.agents.skillNames(agent), []);
    assert.equal(await fake.agents.loadSkill(agent, 'lesson'), undefined);
  }
});

test('the lesson skill leaves and returns with the memory tools as the last knowledge base is turned off and on', async () => {
  const { fake, http } = await startWithKnowledgeBase();
  const agent = await fake.agents.create();
  await until(async () => (await fake.agents.skillNames(agent)).length > 0);
  const setEnabled = async (enabled) => {
    const set = await http.request('POST', '/mdc-memory/kbs/set-enabled', { body: { name: 'kb', enabled } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  };

  await setEnabled(false);
  await until(async () => (await fake.agents.toolNames(agent)).length === 0);

  assert.deepEqual(await fake.agents.skillNames(agent), []);
  await setEnabled(true);
  await until(async () => (await fake.agents.toolNames(agent)).length > 0);
  assert.deepEqual(await fake.agents.skillNames(agent), ['lesson']);
});

/** Set environment variables of this process for one test. */
function setEnv(values) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const assign = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(values);
  cleanups.push(() => assign(previous));
}

test('proxy bypass lists reach Python children in a form httpx can parse', async () => {
  // What the dsh launcher leaves in the environment: its loopback entries, bare and bracketed.
  const inherited = 'localhost,127.0.0.1,.corp.example ::1,[::1],[fe80::1],[::1]:8080,LOCALHOST,*.svc';
  setEnv({ NO_PROXY: inherited, no_proxy: inherited });
  const subprocess = createFakeSubprocess();
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  await waitForState(http, 'ready');

  for (const program of ['model', 'serve']) {
    const { env } = subprocess.last(program).spec;
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,.corp.example,::1,fe80::1,*.svc', program);
    assert.equal(env.no_proxy, env.NO_PROXY, program);
  }
});

test('Python children get no proxy bypass list when none is inherited', async () => {
  setEnv({ NO_PROXY: undefined, no_proxy: undefined });
  const subprocess = createFakeSubprocess();
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  await waitForState(http, 'ready');

  const { env } = subprocess.last('serve').spec;
  assert.equal(Object.keys(env).some((name) => name.toUpperCase() === 'NO_PROXY'), false);
});

test('dataDir falls back to dshHomePath("memory") when a user patch replaces the config', async () => {
  const subprocess = createFakeSubprocess();
  const dshHome = join(workdir, 'dsh-home');
  const fake = createFakeCtx({ subprocess, dshHomePath: (...segments) => join(dshHome, ...segments) });
  cleanups.push(() => fake.dispose());

  apply(fake.ctx, { pythonSource: makeSource(sourceDir()) });
  await until(() => subprocess.last('uvSync'));

  assert.ok(isInside(subprocess.last('uvSync').spec.env.UV_PROJECT_ENVIRONMENT, join(dshHome, 'memory')));
});

test('fails open with an error status when pythonSource does not exist', async () => {
  const subprocess = createFakeSubprocess();
  const missing = join(workdir, 'no-such-checkout');
  const { http } = await start(subprocess, { pythonSource: missing });

  const failed = await waitForState(http, 'error');

  assert.equal(failed.error.stage, 'source');
  assert.match(failed.error.message, /does not exist/);
  assert.ok(failed.error.message.includes(missing));
  assert.deepEqual(failed.stages.map((stage) => stage.state), ['failed', 'pending', 'pending', 'pending']);
  assert.equal(subprocess.spawned.length, 0);
});

test('a failing uv sync reports its exit code and output', async () => {
  const subprocess = createFakeSubprocess({
    uvSync: async (proc) => {
      proc.stderr('error: The lockfile at `uv.lock` needs to be updated, but `--frozen` was provided.');
      return 2;
    },
  });
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });

  const failed = await waitForState(http, 'error');

  assert.equal(failed.error.stage, 'venv');
  assert.match(failed.error.message, /uv sync failed \(exit code 2\)/);
  assert.match(failed.error.output, /lockfile at `uv\.lock` needs to be updated/);
});

test('retry after an error reruns the pipeline to ready', async () => {
  const source = sourceDir();
  const { http } = await start(createFakeSubprocess(), { pythonSource: source });
  await waitForState(http, 'error');
  makeSource(source);

  const retried = await http.request('POST', '/mdc-memory/retry', { body: {} });

  assert.equal(retried.status, 200);
  assert.equal(retried.body.state, 'preparing');
  assert.equal(retried.body.error, undefined);
  await waitForState(http, 'ready');
});

test('retry is refused unless the runtime is in the error state', async () => {
  const { http } = await start(createFakeSubprocess(), { pythonSource: makeSource(sourceDir()) });
  await waitForState(http, 'ready');

  const retried = await http.request('POST', '/mdc-memory/retry', { body: {} });

  assert.equal(retried.status, 409);
  assert.equal(retried.body.code, 'not-retryable');
});

test('basic-memory exiting after ready turns the status into an error', async () => {
  const subprocess = createFakeSubprocess();
  const { http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });
  await waitForState(http, 'ready');

  subprocess.last('serve').crash(3);
  const failed = await waitForState(http, 'error');

  assert.equal(failed.error.stage, 'server');
  assert.match(failed.error.message, /exited unexpectedly \(exit code 3\)/);
  assert.deepEqual(failed.stages.map((stage) => stage.state), ['done', 'done', 'done', 'failed']);
});

test('disposing the plugin terminates basic-memory', async () => {
  const subprocess = createFakeSubprocess();
  const { fake, http } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });
  const { endpoint } = await waitForState(http, 'ready');

  await fake.dispose();

  assert.equal(subprocess.last('serve').wasTerminated, true);
  await assert.rejects(fetch(`${endpoint}/v2/projects/`));
});

test('disposing during preparation terminates the running command and stops the pipeline', async () => {
  const held = createGate();
  const subprocess = createFakeSubprocess({ uvSync: async () => { await held.opened; return 0; } });
  const { fake } = await start(subprocess, { pythonSource: makeSource(sourceDir()) });
  await until(() => subprocess.last('uvSync'));

  await fake.dispose();

  assert.equal(subprocess.last('uvSync').wasTerminated, true);
  assert.deepEqual(subprocess.spawned.map((proc) => proc.program), ['uvSync']);
});
