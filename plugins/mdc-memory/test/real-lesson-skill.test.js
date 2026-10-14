/**
 * The lesson skill end to end: what main agents and subagents can discover
 * and load through dsh's real skill registry, and the tool calls the skill
 * prescribes, taken from the instructions an agent loads and run as written
 * through its memory tools against a real basic-memory, then checked with
 * basic-memory's own schema validation. Opt-in like the other real tests;
 * see support/real-dsh.js for the environment.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { REAL_TEST_SKIP, realHostConfig } from './support/real-dsh.js';
import { READY_TIMEOUT_MS, startRealHost, unregisterLeftoverProjects, until } from './support/real-host.js';

const RECIPES = 'lesson-recipes';

let workdir;
let host;

const rootOf = (name) => join(workdir, 'kbs', name);

const add = async (name) => {
  const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name, path: rootOf(name) } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
};
const setEnabled = async (name, enabled) => {
  const set = await host.http.request('POST', '/mdc-memory/kbs/set-enabled', { body: { name, enabled } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
};

/** Through the settings routes: exactly `names` are enabled, adding the missing ones. */
async function useKnowledgeBases(...names) {
  const { items } = (await host.http.request('GET', '/mdc-memory/kbs')).body;
  for (const name of names) if (!items.some((item) => item.name === name)) await add(name);
  for (const item of items) await setEnabled(item.name, names.includes(item.name));
  for (const name of names) await setEnabled(name, true);
}

/** Wait until the agent can discover the lesson skill. */
const offeredLesson = (agent) => until(async () => (await host.fake.agents.skillNames(agent)).includes('lesson'));

/** The tool calls the skill prescribes, in its order: every ```json <tool> block of its instructions. */
function prescribedCalls(instructions) {
  return [...instructions.matchAll(/^```json (memory_\w+)\r?\n([\s\S]*?)^```$/gm)].map(([, tool, json]) => ({ tool, args: JSON.parse(json) }));
}

describe('the lesson skill on a real basic-memory', { skip: REAL_TEST_SKIP, timeout: READY_TIMEOUT_MS * 2 }, () => {
  before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-lesson-'));
    host = await startRealHost({ workdir, config: realHostConfig() });
    await unregisterLeftoverProjects(host.endpoint);
  });

  after(async () => {
    if (host) await unregisterLeftoverProjects(host.endpoint);
    await host?.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  test('a main agent discovers and loads the bundled lesson skill, and no other skill', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();

    await offeredLesson(agent);

    assert.deepEqual(await host.fake.agents.skillNames(agent), ['lesson']);
    const skill = await host.fake.agents.loadSkill(agent, 'lesson');
    assert.equal(skill.name, 'lesson');
    assert.match(skill.description, /type: lesson/);
    assert.match(skill.content, /^# /, 'instructions start after the frontmatter');
    assert.doesNotMatch(skill.content, /^name: lesson$/m);
  });

  test('subagents can neither discover nor load the lesson skill', async () => {
    await useKnowledgeBases('经验库');
    const main = await host.fake.agents.create();
    await offeredLesson(main);

    const delegated = await host.fake.agents.create({ parent: main });
    const resumedChild = await host.fake.agents.create({ origin: 'subagent' });

    for (const agent of [delegated, resumedChild]) {
      assert.deepEqual(await host.fake.agents.skillNames(agent), []);
      assert.equal(await host.fake.agents.loadSkill(agent, 'lesson'), undefined);
    }
  });

  test('turning the last knowledge base off withdraws the lesson skill from a running session, turning it on restores it', async () => {
    await useKnowledgeBases('经验库');
    const agent = await host.fake.agents.create();
    await offeredLesson(agent);

    await useKnowledgeBases();

    await until(async () => (await host.fake.agents.skillNames(agent)).length === 0);
    assert.deepEqual(await host.fake.agents.toolNames(agent), []);
    await useKnowledgeBases('经验库');
    await offeredLesson(agent);
    assert.ok((await host.fake.agents.toolNames(agent)).includes('memory_write_note'));
  });

  describe('the tool calls it prescribes, run in its order on a fresh knowledge base', () => {
    let agent;
    let calls;

    before(async () => {
      await useKnowledgeBases(RECIPES);
      agent = await host.fake.agents.create();
      await offeredLesson(agent);
      calls = prescribedCalls((await host.fake.agents.loadSkill(agent, 'lesson')).content);
    });

    /** The one prescribed call of `tool` that `matches`. */
    function prescribed(tool, matches = () => true) {
      const found = calls.filter((candidate) => candidate.tool === tool && matches(candidate.args));
      assert.equal(found.length, 1, `the skill prescribes one such ${tool} call`);
      return found[0];
    }
    const searchFirst = () => prescribed('memory_search_notes');
    const readExisting = () => prescribed('memory_read_note');
    const writeNew = () => prescribed('memory_write_note', (args) => !args.content.includes('supersedes [['));
    const updateInPlace = () => prescribed('memory_edit_note', (args) => args.metadata === undefined);
    const supersede = () => prescribed('memory_write_note', (args) => args.content.includes('supersedes [['));
    const markOutdated = () => prescribed('memory_edit_note', (args) => args.metadata?.status === 'outdated');

    async function run({ tool, args }) {
      const result = await host.fake.agents.call(agent, tool, args);
      assert.equal(result.isError, false, `${tool}: ${result.text}`);
      return result;
    }

    async function externalId() {
      const { projects } = await (await fetch(`${host.endpoint}/v2/projects/`)).json();
      return projects.find((project) => project.name === RECIPES).external_id;
    }

    /** basic-memory's knowledge graph of the recipes knowledge base: notes and resolved relations. */
    async function graph() {
      const res = await fetch(`${host.endpoint}/v2/projects/${await externalId()}/knowledge/graph`);
      assert.equal(res.status, 200);
      return res.json();
    }

    async function lessonNamed(title) {
      const lessons = (await graph()).nodes.filter((node) => node.note_type === 'lesson' && node.title === title);
      assert.equal(lessons.length, 1, `one lesson titled ${title}`);
      return lessons[0];
    }

    /**
     * basic-memory's own verdict on one lesson: its `schema_validate` tool,
     * which agents are not offered, called over MCP once the schema note and
     * the lesson are indexed. Returns the field results by name after
     * asserting the lesson matches the schema exactly: no warnings, no errors,
     * no observation category or relation the schema does not declare.
     */
    async function validate(identifier) {
      const report = await until(async () => {
        const res = await fetch(`${host.endpoint}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'schema_validate', arguments: { project: RECIPES, identifier, output_format: 'json' } },
          }),
        });
        const { result } = await res.json();
        if (result.isError) return false;
        const parsed = JSON.parse(result.content[0].text);
        return parsed.results?.length === 1 && parsed;
      });
      const [result] = report.results;
      assert.equal(result.schema_entity, 'lesson');
      assert.deepEqual(
        { warnings: report.warning_count, errors: report.error_count, unmatched: [result.unmatched_observations, result.unmatched_relations] },
        { warnings: 0, errors: 0, unmatched: [{}, []] },
        JSON.stringify(result, null, 2),
      );
      return Object.fromEntries(result.field_results.map((field) => [field.field_name, field]));
    }

    const observations = (content, category) => [...content.matchAll(new RegExp(`^- \\[${category}\\] (.*)$`, 'gm'))].map((match) => match[1]);
    const body = (markdown) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

    test('the search before writing finds no lesson for a new pitfall, and the new lesson validates with no warnings', async () => {
      const searched = await run(searchFirst());

      assert.doesNotMatch(searched.text, /^### /m, 'no lesson yet');
      const { args } = writeNew();
      await run(writeNew());
      const fields = await validate(args.title);
      for (const name of ['symptom', 'cause', 'fix', 'condition']) assert.equal(fields[name].status, 'present', name);
      assert.deepEqual(fields.status.values, ['active']);
      assert.deepEqual(fields.tags.values, args.tags);
    });

    test('recording the same pitfall again finds the lesson and updates it in place', async () => {
      const { title } = writeNew().args;
      await until(async () => (await run(searchFirst())).text.includes(`### ${title}`));
      const read = await run(readExisting());
      assert.ok(read.text.includes(observations(writeNew().args.content, 'cause')[0]), read.text);

      await run(updateInPlace());

      assert.equal((await graph()).nodes.filter((node) => node.note_type === 'lesson').length, 1, 'no second lesson');
      const fields = await validate(title);
      assert.deepEqual(fields.fix.values, [...observations(writeNew().args.content, 'fix'), ...observations(updateInPlace().args.content, 'fix')]);
    });

    test('a superseding lesson validates with no warnings and its supersedes relation resolves to the old lesson', async () => {
      const old = writeNew().args.title;

      await run(supersede());

      const fields = await validate(supersede().args.title);
      assert.deepEqual(fields.supersedes.values, [old]);
      await until(async () => {
        const { edges } = await graph();
        const [from, to] = [await lessonNamed(supersede().args.title), await lessonNamed(old)];
        return edges.some((edge) => edge.relation_type === 'supersedes' && edge.from_id === from.external_id && edge.to_id === to.external_id);
      });
    });

    test('marking a lesson outdated changes its status and leaves its content as it was', async () => {
      const { identifier } = markOutdated().args;
      const file = join(rootOf(RECIPES), (await lessonNamed(identifier)).file_path);
      const before = readFileSync(file, 'utf8');

      await run(markOutdated());

      const after = await until(() => {
        const text = readFileSync(file, 'utf8');
        return /^status: outdated$/m.test(text) && text;
      });
      assert.equal(body(after), body(before));
      const fields = await validate(identifier);
      assert.deepEqual(fields.status.values, ['outdated']);
      const outdated = await run({ tool: 'memory_search_notes', args: { note_types: ['lesson'], status: 'outdated' } });
      assert.ok(outdated.text.includes(`### ${identifier}`), outdated.text);
      assert.ok(!outdated.text.includes(`### ${supersede().args.title}`), outdated.text);
    });
  });
});
