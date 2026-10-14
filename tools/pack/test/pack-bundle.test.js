import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { packBundle } from '../pack-bundle.js';

const BUNDLE = fileURLToPath(new URL('../../../plugins/mdc-memory', import.meta.url));

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mdc-memory-pack-'));
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

/** A copy of the real bundle, so a test pack never writes into the repo. */
function copyBundle() {
  const dir = join(workdir, 'bundle');
  cpSync(BUNDLE, dir, { recursive: true, filter: (src) => !['node_modules', 'python'].includes(basename(src)) });
  return dir;
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const PYPROJECT = `[project]
name = "basic-memory"
readme = "README.md"

# Explicit resources only.
[tool.hatch.build.targets.wheel.force-include]
"integrations/tau/Basic Memory.py" = "basic_memory/data/tau/extension/Basic Memory.py"
"integrations/tau/prompts" = "basic_memory/data/tau/prompts"
"skills/memory-notes" = "basic_memory/data/tau/skills/memory-notes"
"integrations/pi/package-lock.json" = "basic_memory/data/pi/package/package-lock.json"

[tool.uv-dynamic-versioning]
vcs = "git"
`;

/** A basic-memory checkout: the build inputs plus the clutter a working tree accumulates. */
function makeCheckout() {
  return writeTree(join(workdir, 'basic-memory'), {
    'pyproject.toml': PYPROJECT,
    'uv.lock': 'version = 1\n',
    'README.md': '# basic-memory\n',
    'LICENSE': 'AGPL-3.0\n',
    '.python-version': '3.14\n',
    '.git': 'gitdir: ../.git/modules/basic-memory\n',
    'src/basic_memory/__init__.py': '__version__ = "0.23.2"\n',
    'src/basic_memory/alembic/versions/0001_init.py': '# migration\n',
    'src/basic_memory/__pycache__/__init__.cpython-312.pyc': 'bytecode',
    'integrations/tau/Basic Memory.py': '# tau\n',
    'integrations/tau/prompts/continue.md': 'prompt\n',
    'integrations/tau/tests/test_bridge.py': '# test\n',
    'integrations/hermes/plugin.py': '# hermes\n',
    'integrations/pi/package.json': '{"files":["extensions/"]}\n',
    'integrations/pi/package-lock.json': '{}\n',
    'skills/memory-notes/SKILL.md': 'skill\n',
    'skills/memory-other/SKILL.md': 'skill\n',
    'tests/test_search.py': '# test\n',
    'test-int/test_mcp.py': '# test\n',
    'docs/index.md': 'docs\n',
    '.venv/pyvenv.cfg': 'home = python\n',
    '.pytest_cache/README.md': 'cache\n',
  });
}

/** File entries of a tarball, as `tar` lists them. */
function tarballEntries(tarball) {
  return execFileSync('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball), encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((entry) => entry !== '' && !entry.endsWith('/'));
}

test('the tarball ships the basic-memory build inputs under python/ and nothing else from the checkout', async () => {
  const bundle = copyBundle();
  const out = join(workdir, 'dist');

  const { tarball } = await packBundle({ bundleDir: bundle, sourceDir: makeCheckout(), outDir: out });

  assert.equal(dirname(tarball), out);
  const entries = tarballEntries(tarball);
  assert.deepEqual(entries.filter((entry) => entry.startsWith('package/python/')).sort(), [
    'package/python/LICENSE',
    'package/python/README.md',
    'package/python/integrations/pi/package-lock.json',
    'package/python/integrations/tau/Basic Memory.py',
    'package/python/integrations/tau/prompts/continue.md',
    'package/python/pyproject.toml',
    'package/python/skills/memory-notes/SKILL.md',
    'package/python/src/basic_memory/__init__.py',
    'package/python/src/basic_memory/alembic/versions/0001_init.py',
    'package/python/uv.lock',
  ]);
  assert.ok(entries.includes('package/package.json'));
  assert.ok(entries.includes('package/host/index.js'));
  assert.ok(entries.includes('package/skills/lesson/SKILL.md'));
  assert.ok(entries.includes('package/cordis.patch.yml'));
  assert.ok(!entries.some((entry) => entry.startsWith('package/test/')), 'bundle tests stay out');
  assert.equal(existsSync(join(bundle, 'python')), false, 'no staged source is left in the bundle');
});

test('an uninitialized submodule fails the pack with a hint and produces nothing', async () => {
  const bundle = copyBundle();
  const out = join(workdir, 'dist');
  const empty = join(workdir, 'basic-memory');
  mkdirSync(empty);

  await assert.rejects(packBundle({ bundleDir: bundle, sourceDir: empty, outDir: out }), (error) => {
    assert.match(error.message, /missing pyproject\.toml/);
    assert.match(error.message, /git submodule update --init/);
    return true;
  });
  assert.equal(existsSync(join(bundle, 'python')), false);
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'no tarball');
});

test('a force-included path missing from the checkout fails the pack', async () => {
  const checkout = makeCheckout();
  rmSync(join(checkout, 'integrations', 'tau', 'prompts'), { recursive: true });

  await assert.rejects(
    packBundle({ bundleDir: copyBundle(), sourceDir: checkout, outDir: join(workdir, 'dist') }),
    /missing integrations\/tau\/prompts/,
  );
});
