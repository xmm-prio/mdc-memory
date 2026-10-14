/**
 * Memory tools end to end: what main agents and subagents are offered, and
 * how their calls are scoped to the effective knowledge bases, with dsh's real
 * tool registry and system prompt in front of a real basic-memory. Opt-in like
 * the other real tests; see support/real-dsh.js for the environment.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { knowledgeBaseRoutes } from './support/knowledge-bases.js';
import { REAL_TEST_SKIP, realHostConfig } from './support/real-dsh.js';
import { READY_TIMEOUT_MS, startRealHost, unregisterLeftoverProjects, until } from './support/real-host.js';

const DEFAULT_TOOLS = [
  'memory_build_context',
  'memory_edit_note',
  'memory_list_directory',
  'memory_read_note',
  'memory_recent_activity',
  'memory_search_notes',
  'memory_write_note',
];

const MEMORY_SECTION = /^## Memory$/m;

let workdir;
let host;

const { add, setEnabled, useKnowledgeBases } = knowledgeBaseRoutes(() => host.http, (name) => join(workdir, 'kbs', name));

/** Wait until the agent is offered memory tools; returns their names. */
const offeredMemory = (agent) => until(async () => {
  const names = await host.fake.agents.toolNames(agent);
  return names.length > 0 && names;
});

/** Wait until the agent is offered no memory tools. */
const offeredNothing = (agent) => until(async () => (await host.fake.agents.toolNames(agent)).length === 0);

const call = (agent, name, args) => host.fake.agents.call(agent, name, args);

describe('memory tools on a real basic-memory', { skip: REAL_TEST_SKIP, timeout: READY_TIMEOUT_MS * 2 }, () => {
  before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-tools-'));
    host = await startRealHost({ workdir, config: realHostConfig() });
    await unregisterLeftoverProjects(host.endpoint);
  });

  after(async () => {
    if (host) await unregisterLeftoverProjects(host.endpoint);
    await host?.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  test('a main agent is offered the whitelisted memory tools once a knowledge base is enabled', async () => {
    const agent = await host.fake.agents.create();

    await add('经验库');

    const offered = await until(async () => {
      const names = await host.fake.agents.toolNames(agent);
      return names.length > 0 && names;
    });
    assert.deepEqual(offered, DEFAULT_TOOLS);
  });

  test('subagents are offered no memory tools and no memory section', async () => {
    await useKnowledgeBases('经验库');
    const main = await host.fake.agents.create();
    await offeredMemory(main);

    const delegated = await host.fake.agents.create({ parent: main });
    const resumedChild = await host.fake.agents.create({ origin: 'subagent' });

    for (const agent of [delegated, resumedChild]) {
      assert.deepEqual(await host.fake.agents.toolNames(agent), []);
      assert.doesNotMatch(await host.fake.agents.prompt(agent), MEMORY_SECTION);
    }
  });

  test('the system prompt lists the effective knowledge bases and when to read the lesson skill', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    const prompt = await host.fake.agents.prompt(agent);
    assert.match(prompt, MEMORY_SECTION);
    assert.match(prompt, /^- 经验库$/m);
    assert.match(prompt, /`lesson` skill/);

    await useKnowledgeBases('经验库', 'kb-alpha');

    const updated = await until(async () => {
      const text = await host.fake.agents.prompt(agent);
      return /^- kb-alpha$/m.test(text) && text;
    });
    assert.match(updated, /^- 经验库$/m);
  });

  test('the model sees an optional project parameter and none of the upstream routing parameters', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    for (const name of DEFAULT_TOOLS) {
      const { parameters } = await host.fake.agents.schema(agent, name);
      assert.equal(parameters.properties.project.type, 'string', name);
      assert.equal(parameters.required.includes('project'), false, name);
      for (const routing of ['project_id', 'projects', 'search_all_projects', 'workspace']) {
        assert.equal(routing in parameters.properties, false, `${name} exposes ${routing}`);
      }
    }
    const search = await host.fake.agents.schema(agent, 'memory_search_notes');
    assert.ok('query' in search.parameters.properties, 'upstream parameters are kept');
  });

  test('with one effective knowledge base, notes are written, searched and read without naming it', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    const written = await call(agent, 'memory_write_note', {
      title: 'uv 重建成 3.14', directory: 'lessons', content: '- [symptom] uv sync 把虚拟环境重建成 Python 3.14 quokka17\n- [fix] 加上 --python 3.12\n',
    });
    assert.equal(written.isError, false, written.text);
    assert.match(written.text, /经验库/);

    const found = await until(async () => {
      const searched = await call(agent, 'memory_search_notes', { query: 'quokka17' });
      assert.equal(searched.isError, false, searched.text);
      return searched.text.includes('uv 重建成 3.14') && searched;
    });
    assert.match(found.text, /经验库/);
    const read = await call(agent, 'memory_read_note', { identifier: 'uv 重建成 3.14' });
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /--python 3\.12/);
  });

  test('a natural Chinese question finds the notes sharing its distinctive words by keyword search alone', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);
    const notes = {
      pip: { title: 'pip 安装超时', content: '- [symptom] pip install 报 ReadTimeoutError：连接 PyPI 超时\n- [fix] 配置企业代理\n' },
      powershell: { title: 'PowerShell 中文乱码', content: '- [symptom] PowerShell 5.1 读取无 BOM 的 UTF-8 脚本时，中文字符串被当成乱码导致解析失败\n- [fix] 脚本另存为带 BOM 的 UTF-8\n' },
    };
    for (const note of Object.values(notes)) {
      const written = await call(agent, 'memory_write_note', { ...note, directory: 'keyword' });
      assert.equal(written.isError, false, written.text);
    }
    const questions = {
      pip: 'pip install 一直报 ReadTimeoutError，连不上 PyPI，怎么解决？',
      powershell: 'PowerShell 脚本里的中文字符串报解析错误',
    };

    for (const [key, query] of Object.entries(questions)) {
      const other = key === 'pip' ? notes.powershell : notes.pip;
      const found = await until(async () => {
        const searched = await call(agent, 'memory_search_notes', { query, search_type: 'text' });
        assert.equal(searched.isError, false, searched.text);
        return searched.text.includes(notes[key].title) && searched;
      });
      assert.equal(found.text.includes(other.title), false, `${query}: ${found.text}`);
    }
  });

  test('with several effective knowledge bases, a call naming none is refused with the choices', async () => {
    await useKnowledgeBases('经验库', 'kb-alpha');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    const refused = await call(agent, 'memory_search_notes', { query: 'anything' });

    assert.equal(refused.isError, true);
    assert.match(refused.text, /pass "project"/);
    assert.match(refused.text, /经验库/);
    assert.match(refused.text, /kb-alpha/);
    const chosen = await call(agent, 'memory_write_note', { project: 'kb-alpha', title: 'alpha note', directory: 'notes', content: 'in alpha' });
    assert.equal(chosen.isError, false, chosen.text);
    assert.match(chosen.text, /kb-alpha/);
  });

  test('a call naming a turned-off, unknown or internal knowledge base is refused', async () => {
    await useKnowledgeBases('经验库', 'kb-alpha');
    await setEnabled('kb-alpha', false);
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    const turnedOff = await call(agent, 'memory_search_notes', { project: 'kb-alpha', query: 'alpha' });
    const unknown = await call(agent, 'memory_search_notes', { project: 'no-such-kb', query: 'alpha' });
    const internal = await call(agent, 'memory_search_notes', { project: 'main', query: 'alpha' });

    assert.equal(turnedOff.isError, true);
    assert.match(turnedOff.text, /"kb-alpha" is turned off/);
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /no knowledge base named "no-such-kb"/);
    assert.equal(internal.isError, true);
    assert.match(internal.text, /no knowledge base named "main"/);
    for (const refused of [turnedOff, unknown, internal]) assert.match(refused.text, /enabled knowledge bases: 经验库/);
  });

  test('turning a knowledge base off in the settings refuses the next call of a running session', async () => {
    await useKnowledgeBases('经验库', 'kb-alpha');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);
    assert.equal((await call(agent, 'memory_search_notes', { project: 'kb-alpha', query: 'alpha' })).isError, false);

    await setEnabled('kb-alpha', false);

    const refused = await call(agent, 'memory_search_notes', { project: 'kb-alpha', query: 'alpha' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /"kb-alpha" is turned off/);
  });

  test('turning the last knowledge base off withdraws the memory tools and section from a running session', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);

    await setEnabled('经验库', false);

    await offeredNothing(agent);
    assert.doesNotMatch(await host.fake.agents.prompt(agent), MEMORY_SECTION);
    await setEnabled('经验库', true);
    assert.deepEqual(await offeredMemory(agent), DEFAULT_TOOLS);
    assert.match(await host.fake.agents.prompt(agent), MEMORY_SECTION);
  });

  test('with every knowledge base off, a new session has no memory tools and no memory section', async () => {
    await useKnowledgeBases('经验库');
    const running = await host.fake.agents.create();
    await offeredMemory(running);
    await useKnowledgeBases();
    await offeredNothing(running);

    const fresh = await host.fake.agents.create();

    assert.deepEqual(await host.fake.agents.toolNames(fresh), []);
    assert.doesNotMatch(await host.fake.agents.prompt(fresh), MEMORY_SECTION);
  });

  test('arguments that would route around the knowledge base choice are refused', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);
    const { projects } = await (await fetch(`${host.endpoint}/v2/projects/`)).json();
    const internal = projects.find((project) => project.is_default);

    const attempts = [
      { query: 'x', project_id: internal.external_id },
      { query: 'x', search_all_projects: true },
      { query: 'x', all_projects: true },
      { query: 'x', projects: ['main'] },
    ];
    for (const args of attempts) {
      const refused = await call(agent, 'memory_search_notes', args);
      assert.equal(refused.isError, true, JSON.stringify(args));
      assert.match(refused.text, /Unsupported argument/, JSON.stringify(args));
    }
  });

  test('a memory:// URL must stay inside the knowledge base the call works in', async () => {
    await useKnowledgeBases('kb-gamma');
    await useKnowledgeBases('kb-alpha', 'kb-beta');
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);
    const written = await call(agent, 'memory_write_note', { project: 'kb-beta', title: 'beta secret', directory: 'notes', content: 'only in beta' });
    assert.equal(written.isError, false, written.text);

    const intoOther = await call(agent, 'memory_read_note', { project: 'kb-alpha', identifier: 'memory://kb-beta/notes/beta-secret' });
    const intoOff = await call(agent, 'memory_build_context', { project: 'kb-alpha', url: 'memory://kb-gamma/notes/*' });
    const intoInternal = await call(agent, 'memory_build_context', { project: 'kb-alpha', url: 'memory://main/notes/x' });
    const inside = await call(agent, 'memory_read_note', { project: 'kb-beta', identifier: 'memory://kb-beta/notes/beta-secret' });

    assert.equal(intoOther.isError, true);
    assert.match(intoOther.text, /is in knowledge base "kb-beta"; pass "project": "kb-beta"/);
    assert.equal(intoOff.isError, true);
    assert.match(intoOff.text, /points outside the enabled knowledge bases/);
    assert.equal(intoInternal.isError, true);
    assert.match(intoInternal.text, /points outside the enabled knowledge bases/);
    assert.equal(inside.isError, false, inside.text);
    assert.match(inside.text, /only in beta/);
  });
});

describe('a configured memory tool whitelist on a real basic-memory', { skip: REAL_TEST_SKIP, timeout: READY_TIMEOUT_MS * 2 }, () => {
  let preexisting;

  before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-tools-'));
    const memoryTools = ['search_notes', 'delete_note', 'list_memory_projects', 'no_such_tool'];
    host = await startRealHost({
      workdir,
      config: { ...realHostConfig(), memoryTools },
      beforeApply: async (fake) => { preexisting = await fake.agents.create(); },
    });
    await unregisterLeftoverProjects(host.endpoint);
  });

  after(async () => {
    await host?.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  test('offers the upstream tools named in the whitelist that work inside one knowledge base', async () => {
    await useKnowledgeBases('kb-listed');
    const agent = await host.fake.agents.create();

    assert.deepEqual(await offeredMemory(agent), ['memory_delete_note', 'memory_search_notes']);
    const warnings = host.fake.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message).join('\n');
    assert.match(warnings, /list_memory_projects does not work inside one project/);
    assert.match(warnings, /no tool named no_such_tool/);
  });

  test('a main agent that already existed when the plugin loaded is offered the memory tools', async () => {
    await useKnowledgeBases('kb-listed');

    assert.deepEqual(await offeredMemory(preexisting), ['memory_delete_note', 'memory_search_notes']);
  });

  test('disposing the plugin withdraws the memory tools and section from running sessions', async () => {
    const agent = await host.fake.agents.create();
    await offeredMemory(agent);
    await unregisterLeftoverProjects(host.endpoint);

    await host.fake.dispose();

    assert.deepEqual(await host.fake.agents.toolNames(agent), []);
    assert.doesNotMatch(await host.fake.agents.prompt(agent), MEMORY_SECTION);
  });
});
