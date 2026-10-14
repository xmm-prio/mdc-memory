/**
 * Knowledge base management end to end: the settings routes registered by
 * `apply` against a real basic-memory and dsh's real storage stack. Opt-in
 * like the other real tests; see support/real-dsh.js for the environment.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { REAL_TEST_SKIP, realHostConfig } from './support/real-dsh.js';
import { READY_TIMEOUT_MS, startRealHost, unregisterLeftoverProjects, until } from './support/real-host.js';

let workdir;
let config;
let host;

const startHost = () => startRealHost({ workdir, config });

/** basic-memory reports `C:/...` while Node builds `C:\...`; Windows paths ignore case. */
function samePath(a, b) {
  const normalize = (path) => {
    const resolved = resolve(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

/** basic-memory's own REST answer, bypassing the plugin. */
async function basicMemory(path, init) {
  const res = await fetch(host.endpoint + path, init);
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return res.json();
}

const add = (name, path) => host.http.request('POST', '/mdc-memory/kbs/add', { body: { name, path } });
const setEnabled = (name, enabled) => host.http.request('POST', '/mdc-memory/kbs/set-enabled', { body: { name, enabled } });
const remove = (name) => host.http.request('POST', '/mdc-memory/kbs/delete', { body: { name } });

/** Enablement records as dsh's JSON storage backend persisted them. */
function storedEnablement() {
  const file = join(workdir, 'storages', 'mdc_memory_kb.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).tables.enabled : {};
}

async function list() {
  const listed = await host.http.request('GET', '/mdc-memory/kbs');
  assert.equal(listed.status, 200, `${JSON.stringify(listed.body)}`);
  return listed.body;
}

function rowOf(listed, name) {
  const row = listed.items.find((item) => item.name === name);
  assert.ok(row, `${name} is listed`);
  return row;
}

async function projectNamed(name) {
  const { projects } = await basicMemory('/v2/projects/');
  const project = projects.find((candidate) => candidate.name === name);
  assert.ok(project, `basic-memory has no project ${name}`);
  return project;
}

/** basic-memory's own resolution of the schema for lesson notes, from its index. */
const lessonSchemaDrift = (project) => basicMemory(`/v2/projects/${project.external_id}/schema/diff/lesson`);

/** basic-memory serves search on the HTTP method QUERY only. */
function searchNotes(externalId, text) {
  const payload = Buffer.from(JSON.stringify({ text }), 'utf8');
  return new Promise((resolveSearch, reject) => {
    const req = http.request(`${host.endpoint}/v2/projects/${externalId}/search/?page_size=10`, {
      method: 'QUERY',
      headers: { 'content-type': 'application/json', 'content-length': payload.byteLength },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) resolveSearch(JSON.parse(body));
        else reject(new Error(`search answered ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Place a Markdown file the way a user would, outside basic-memory. */
function writeNote(root, relativePath, content) {
  const file = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe('knowledge bases on a real basic-memory', { skip: REAL_TEST_SKIP, timeout: READY_TIMEOUT_MS * 2 }, () => {
  before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-kb-'));
    config = realHostConfig();
    host = await startHost();
    await unregisterLeftoverProjects(host.endpoint);
  });

  after(async () => {
    if (host) await unregisterLeftoverProjects(host.endpoint);
    await host?.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  test('lists no knowledge base while only the reserved default project exists', async () => {
    const listed = await host.http.request('GET', '/mdc-memory/kbs');

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { items: [], effective: [] });
    const { projects } = await basicMemory('/v2/projects/');
    assert.ok(projects.some((project) => project.is_default), 'basic-memory keeps its default project');
  });

  test('adding a missing directory creates it and lists the knowledge base, enabled', async () => {
    const root = join(workdir, 'kbs', '踩坑经验');

    const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name: '踩坑经验', path: root } });

    assert.equal(added.status, 200, `${JSON.stringify(added.body)}`);
    assert.deepEqual(added.body.item, { name: '踩坑经验', path: added.body.item.path, enabled: true });
    assert.ok(samePath(added.body.item.path, root), `${added.body.item.path} is ${root}`);
    assert.ok(statSync(root).isDirectory(), 'directory created');
    const listed = (await host.http.request('GET', '/mdc-memory/kbs')).body;
    assert.deepEqual(listed.items.map(({ name, enabled }) => ({ name, enabled })), [{ name: '踩坑经验', enabled: true }]);
    assert.deepEqual(listed.effective, ['踩坑经验']);
    const { projects } = await basicMemory('/v2/projects/');
    assert.ok(projects.some((project) => project.name === '踩坑经验' && samePath(project.path, root)), 'registered in basic-memory');
  });

  test('adding seeds the lesson schema note that basic-memory validates lessons against', async () => {
    const root = join(workdir, 'kbs', 'schema-check');
    writeNote(root, 'lessons/uv-python.md', [
      '---', 'title: uv sync 重建成 3.14', 'type: lesson', 'status: active', '---', '',
      '- [symptom] uv sync 把虚拟环境重建成 Python 3.14',
      '- [fix] 命令加上 --python 3.12', '',
    ].join('\n'));

    const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name: 'schema-check', path: root } });

    assert.equal(added.status, 200, `${JSON.stringify(added.body)}`);
    assert.ok(existsSync(join(root, 'schema', 'lesson.md')), 'schema note written into the knowledge base');
    const project = await projectNamed('schema-check');
    assert.equal((await lessonSchemaDrift(project)).schema_found, true, 'the seeded note is indexed by the time add returns');
    const report = await until(async () => {
      const validated = await basicMemory(`/v2/projects/${project.external_id}/schema/validate?note_type=lesson`, { method: 'POST' });
      return validated.results.length === 1 && validated;
    });
    const [result] = report.results;
    assert.equal(result.schema_entity, 'lesson');
    assert.equal(result.passed, true, 'validation mode is warn');
    const field = (name) => result.field_results.find((candidate) => candidate.field_name === name);
    assert.equal(field('symptom').status, 'present');
    assert.equal(field('fix').status, 'present');
    assert.deepEqual({ status: field('cause').status, required: field('cause').required }, { status: 'missing', required: true });
    assert.equal(field('condition').required, false);
  });

  test('a schema note already in the directory is kept as it is', async () => {
    const root = join(workdir, 'kbs', 'own-schema');
    const own = ['---', 'title: lesson', 'type: schema', 'entity: lesson', 'version: 7', 'schema:', '  symptom: string, 自定义', '---', '', '用户自己维护的 schema。', ''].join('\n');
    const file = writeNote(root, 'schema/lesson.md', own);

    const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name: 'own-schema', path: root } });

    assert.equal(added.status, 200, `${JSON.stringify(added.body)}`);
    const project = await projectNamed('own-schema');
    await until(async () => (await basicMemory(`/v2/projects/${project.external_id}/knowledge/graph`)).nodes
      .some((node) => node.file_path === 'schema/lesson.md'));
    const kept = readFileSync(file, 'utf8');
    assert.match(kept, /version: 7/);
    assert.match(kept, /用户自己维护的 schema。/);
    assert.doesNotMatch(kept, /mdc-memory/);
  });

  test('a lesson schema note anywhere in the directory means none is seeded', async () => {
    const root = join(workdir, 'kbs', 'schema-elsewhere');
    const own = ['---', 'title: 经验结构', 'type: schema', 'entity: Lesson', 'version: 3', 'schema:', '  symptom: string, 现象', '---', '', '团队维护的经验 schema。', ''].join('\n');
    writeNote(root, 'schemas/经验结构.md', own);

    const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name: 'schema-elsewhere', path: root } });

    assert.equal(added.status, 200, `${JSON.stringify(added.body)}`);
    assert.equal(existsSync(join(root, 'schema', 'lesson.md')), false, 'no second lesson schema note');
    assert.equal((await lessonSchemaDrift(await projectNamed('schema-elsewhere'))).schema_found, true);
  });

  test('notes already in the directory become searchable after adding it', async () => {
    const root = join(workdir, 'kbs', 'existing-notes');
    writeNote(root, 'notes/proxy.md', ['---', 'title: 企业代理', 'type: note', '---', '', 'pip 访问 PyPI 需要 zebracorn42 代理。', ''].join('\n'));

    const added = await host.http.request('POST', '/mdc-memory/kbs/add', { body: { name: 'existing-notes', path: root } });

    assert.equal(added.status, 200, `${JSON.stringify(added.body)}`);
    const project = await projectNamed('existing-notes');
    const found = await until(async () => (await searchNotes(project.external_id, 'zebracorn42')).results.find((hit) => hit.file_path === 'notes/proxy.md'));
    assert.equal(found.title, '企业代理');
  });

  test('add refuses a taken name, a relative path and a registered path with distinct errors', async () => {
    const kbs = join(workdir, 'kbs');
    const parent = join(kbs, 'taken-parent');
    const root = join(parent, 'taken');
    assert.equal((await add('taken', root)).status, 200);
    const projectsBefore = (await basicMemory('/v2/projects/')).projects.length;

    const refusals = {
      sameName: await add('taken', join(kbs, 'elsewhere')),
      sameNameOtherCase: await add('Taken', join(kbs, 'elsewhere')),
      reservedName: await add('main', join(kbs, 'elsewhere')),
      relativePath: await add('relative', 'kbs/relative'),
      driveRelativePath: await add('drive-relative', '\\kbs\\relative'),
      samePath: await add('same-path', root),
      nestedPath: await add('nested', join(root, 'inner')),
      enclosingPath: await add('enclosing', parent),
      reservedPath: await add('inside-memory', join(config.dataDir, 'main', 'inner')),
      noName: await add('  ', join(kbs, 'elsewhere')),
      permalinkTwin: await add('Taken!', join(kbs, 'elsewhere')),
    };

    const outcome = (response) => ({ status: response.status, code: response.body?.code, details: response.body?.details });
    assert.deepEqual(Object.fromEntries(Object.entries(refusals).map(([key, response]) => [key, outcome(response)])), {
      sameName: { status: 409, code: 'name-taken', details: { knowledgeBase: 'taken' } },
      sameNameOtherCase: { status: 409, code: 'name-taken', details: { knowledgeBase: 'taken' } },
      reservedName: { status: 409, code: 'name-reserved', details: undefined },
      relativePath: { status: 400, code: 'path-not-absolute', details: undefined },
      driveRelativePath: { status: 400, code: 'path-not-absolute', details: undefined },
      samePath: { status: 409, code: 'path-registered', details: { knowledgeBase: 'taken' } },
      nestedPath: { status: 409, code: 'path-registered', details: { knowledgeBase: 'taken' } },
      enclosingPath: { status: 409, code: 'path-registered', details: { knowledgeBase: 'taken' } },
      reservedPath: { status: 409, code: 'path-reserved', details: undefined },
      noName: { status: 400, code: 'invalid-request', details: undefined },
      permalinkTwin: { status: 400, code: 'rejected', details: undefined },
    });
    for (const response of Object.values(refusals)) assert.equal(typeof response.body.message, 'string');
    assert.equal((await basicMemory('/v2/projects/')).projects.length, projectsBefore, 'nothing registered');
    assert.equal(existsSync(join(kbs, 'elsewhere')), false, 'no directory created for a refused add');
  });

  test('an add that fails after registering leaves nothing registered', async () => {
    const root = join(workdir, 'kbs', 'blocked');
    writeNote(root, 'schema', 'a file where the schema directory belongs');

    const added = await add('blocked', root);

    assert.equal(added.status, 500, `${JSON.stringify(added.body)}`);
    assert.equal((await list()).items.some((item) => item.name === 'blocked'), false);
    assert.equal((await basicMemory('/v2/projects/')).projects.some((project) => project.name === 'blocked'), false);
    assert.equal('blocked' in storedEnablement(), false);
  });

  test('turning a knowledge base off and on updates its row and the effective set', async () => {
    assert.equal((await add('toggled', join(workdir, 'kbs', 'toggled'))).status, 200);
    assert.equal((await add('untouched', join(workdir, 'kbs', 'untouched'))).status, 200);

    const off = await setEnabled('toggled', false);

    assert.equal(off.status, 200, `${JSON.stringify(off.body)}`);
    assert.equal(off.body.item.enabled, false);
    let listed = await list();
    assert.equal(rowOf(listed, 'toggled').enabled, false);
    assert.equal(rowOf(listed, 'untouched').enabled, true);
    assert.equal(listed.effective.includes('toggled'), false);
    assert.equal(listed.effective.includes('untouched'), true);

    const on = await setEnabled('toggled', true);

    assert.equal(on.body.item.enabled, true);
    listed = await list();
    assert.equal(rowOf(listed, 'toggled').enabled, true);
    assert.equal(listed.effective.includes('toggled'), true);
  });

  test('set-enabled refuses an unknown knowledge base and a non-boolean flag', async () => {
    assert.equal((await add('flagged', join(workdir, 'kbs', 'flagged'))).status, 200);

    const unknown = await setEnabled('no-such-kb', false);
    const reserved = await setEnabled('main', false);
    const notBoolean = await host.http.request('POST', '/mdc-memory/kbs/set-enabled', { body: { name: 'flagged', enabled: 'no' } });

    assert.deepEqual([unknown.status, unknown.body.code, unknown.body.details], [404, 'not-found', { knowledgeBase: 'no-such-kb' }]);
    assert.deepEqual([reserved.status, reserved.body.code], [404, 'not-found']);
    assert.deepEqual([notBoolean.status, notBoolean.body.code], [400, 'invalid-request']);
    assert.equal(rowOf(await list(), 'flagged').enabled, true);
  });

  test('deleting unregisters the knowledge base and its enablement but keeps its files', async () => {
    const root = join(workdir, 'kbs', 'deleted');
    const note = writeNote(root, 'notes/keep.md', ['---', 'title: 保留', 'type: note', '---', '', '删除知识库后文件仍在。', ''].join('\n'));
    assert.equal((await add('deleted', root)).status, 200);
    assert.equal((await setEnabled('deleted', false)).status, 200);
    assert.equal(storedEnablement().deleted, false);

    const removed = await remove('deleted');

    assert.equal(removed.status, 200, `${JSON.stringify(removed.body)}`);
    assert.equal((await list()).items.some((item) => item.name === 'deleted'), false);
    assert.equal((await basicMemory('/v2/projects/')).projects.some((project) => project.name === 'deleted'), false);
    assert.equal('deleted' in storedEnablement(), false, 'enablement record removed');
    assert.ok(existsSync(note), 'note kept on disk');
    assert.ok(existsSync(join(root, 'schema', 'lesson.md')), 'schema note kept on disk');
  });

  test('delete refuses an unknown knowledge base and never touches the reserved default', async () => {
    const unknown = await remove('no-such-kb');
    const reserved = await remove('main');

    assert.deepEqual([unknown.status, unknown.body.code], [404, 'not-found']);
    assert.deepEqual([reserved.status, reserved.body.code], [404, 'not-found']);
    assert.ok((await basicMemory('/v2/projects/')).projects.some((project) => project.is_default));
  });

  test('enablement survives a dsh restart', async () => {
    assert.equal((await add('stays-on', join(workdir, 'kbs', 'stays-on'))).status, 200);
    assert.equal((await add('stays-off', join(workdir, 'kbs', 'stays-off'))).status, 200);
    assert.equal((await setEnabled('stays-off', false)).status, 200);

    await host.stop();
    host = await startHost();

    const listed = await list();
    assert.equal(rowOf(listed, 'stays-on').enabled, true);
    assert.equal(rowOf(listed, 'stays-off').enabled, false);
    assert.equal(listed.effective.includes('stays-on'), true);
    assert.equal(listed.effective.includes('stays-off'), false);
  });
});
