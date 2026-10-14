/**
 * Which basic-memory source the venv is built from, and when the venv is
 * rebuilt. Each start applies the Host row against a fresh fake ctx sharing
 * one dataDir, the way successive dsh runs share ~/.dsh/memory.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFakeCtx, serveRoutes } from './support/fake-ctx.js';
import { createFakeSubprocess } from './support/fake-subprocess.js';
import { makeSource, writeTree } from './support/python-source.js';

const BUNDLE = fileURLToPath(new URL('..', import.meta.url));

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-source-'));
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

/**
 * A copy of the Host row laid out like an installed tarball: the package
 * root holds host/ and skills/ and, when packaged, the python/ source beside them.
 */
async function installBundle({ packaged }) {
  const root = join(workdir, 'node_modules', '@local', 'mdc-memory');
  cpSync(join(BUNDLE, 'package.json'), join(root, 'package.json'));
  for (const dir of ['host', 'skills']) cpSync(join(BUNDLE, dir), join(root, dir), { recursive: true });
  if (packaged) makeSource(join(root, 'python'));
  const { apply } = await import(pathToFileURL(join(root, 'host', 'index.js')).href);
  return { root, apply };
}

/** One dsh run: apply the Host row, wait until the pipeline settles, then unload it. */
async function startOnce(apply, config, programs) {
  const subprocess = createFakeSubprocess(programs);
  const fake = createFakeCtx({ subprocess });
  apply(fake.ctx, { dataDir: join(workdir, 'memory'), ...config });
  const http = await serveRoutes(fake.routes);
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      const { body } = await http.request('GET', '/mdc-memory/status');
      if (body.state !== 'preparing') return { status: body, subprocess };
      if (Date.now() > deadline) assert.fail(`still preparing: ${JSON.stringify(body)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await http.close();
    await fake.dispose();
  }
}

test('an installed bundle builds its venv from the packaged source when pythonSource is unset', async () => {
  const { root, apply } = await installBundle({ packaged: true });

  const { status, subprocess } = await startOnce(apply, {});

  assert.equal(status.state, 'ready', JSON.stringify(status));
  const uv = subprocess.last('uvSync').spec;
  assert.equal(uv.cwd, join(root, 'python'));
  assert.ok(uv.argv.includes('--no-editable'), 'basic-memory is copied into the venv, independent of the bundle directory');
});

test('a bundle installed without packaged source fails open and names both ways to provide one', async () => {
  const { root, apply } = await installBundle({ packaged: false });

  const { status, subprocess } = await startOnce(apply, {});

  assert.equal(status.state, 'error');
  assert.ok(status.error.message.includes(join(root, 'python')), status.error.message);
  assert.match(status.error.message, /tools\/pack/);
  assert.match(status.error.message, /pythonSource/);
  assert.equal(subprocess.spawned.length, 0);
});

test('a restart with an unchanged source reuses the venv without running uv', async () => {
  const { apply } = await installBundle({ packaged: true });
  await startOnce(apply, {});

  const { status, subprocess } = await startOnce(apply, {});

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(subprocess.spawned.map((proc) => proc.program), ['model', 'serve']);
});

test('a reinstalled bundle with changed source rebuilds basic-memory in the venv', async () => {
  const { root, apply } = await installBundle({ packaged: true });
  await startOnce(apply, {});
  writeFileSync(join(root, 'python', 'src', 'basic_memory', '__init__.py'), '__version__ = "0.23.2"\nJIEBA = True\n');

  const { status, subprocess } = await startOnce(apply, {});

  assert.equal(status.state, 'ready', JSON.stringify(status));
  const { argv } = subprocess.last('uvSync').spec;
  assert.equal(argv[argv.indexOf('--reinstall-package') + 1], 'basic-memory', 'the unchanged 0.0.0 version must not keep the old build');
});

test('a failed build is retried at the next start', async () => {
  const { apply } = await installBundle({ packaged: true });
  const failed = await startOnce(apply, {}, { uvSync: async () => 2 });
  assert.equal(failed.status.state, 'error');

  const { status, subprocess } = await startOnce(apply, {});

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.ok(subprocess.last('uvSync'), 'uv sync runs again');
});

test('a venv left behind by a failed rebuild is rebuilt even for the source it matched before', async () => {
  const { root, apply } = await installBundle({ packaged: true });
  const module = join(root, 'python', 'src', 'basic_memory', '__init__.py');
  await startOnce(apply, {});
  writeFileSync(module, 'BROKEN = True\n');
  await startOnce(apply, {}, { uvSync: async () => 2 });
  makeSource(join(root, 'python'));

  const { subprocess } = await startOnce(apply, {});

  assert.ok(subprocess.last('uvSync'), 'the half-rebuilt venv is not trusted');
});

test('bytecode caches and tool directories in a checkout do not count as source changes', async () => {
  const checkout = makeSource(join(workdir, 'basic-memory'));
  const { apply } = await installBundle({ packaged: false });
  await startOnce(apply, { pythonSource: checkout });
  writeTree(checkout, {
    'src/basic_memory/__pycache__/__init__.cpython-312.pyc': 'bytecode',
    '.venv/pyvenv.cfg': 'home = python\n',
    '.pytest_cache/v/cache/lastfailed': '{}',
  });

  const { status, subprocess } = await startOnce(apply, { pythonSource: checkout });

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(subprocess.spawned.map((proc) => proc.program), ['model', 'serve']);
});

test('edits outside the build inputs of a checkout, such as its tests, do not rebuild the venv', async () => {
  const checkout = makeSource(join(workdir, 'basic-memory'));
  const { apply } = await installBundle({ packaged: false });
  await startOnce(apply, { pythonSource: checkout });
  writeTree(checkout, {
    'tests/test_search.py': 'def test_search(): ...\n',
    'docs/search.md': '# search\n',
    'integrations/hermes/plugin.py': '# not force-included\n',
  });

  const { status, subprocess } = await startOnce(apply, { pythonSource: checkout });

  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(subprocess.spawned.map((proc) => proc.program), ['model', 'serve']);
});

test('a source tree missing a build input fails open and names what is missing', async () => {
  const checkout = makeSource(join(workdir, 'basic-memory'));
  rmSync(join(checkout, 'src'), { recursive: true });
  const { apply } = await installBundle({ packaged: false });

  const { status, subprocess } = await startOnce(apply, { pythonSource: checkout });

  assert.equal(status.state, 'error');
  assert.equal(status.error.stage, 'source');
  assert.match(status.error.message, /not a basic-memory source tree \(missing src\)/);
  assert.equal(subprocess.spawned.length, 0);
});
