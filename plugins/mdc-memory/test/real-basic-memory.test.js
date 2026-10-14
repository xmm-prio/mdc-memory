/**
 * End-to-end: the Host plugin drives the real basic-memory source tree (the
 * repo submodule) to `ready` through dsh's own local subprocess provider.
 *
 * Slow on first run (venv build and model download), so it is opt-in:
 *   MDC_MEMORY_REAL_TEST=1             enable
 *   MDC_MEMORY_TEST_DATA_DIR=<dir>     persistent dataDir; reruns reuse its venv and model (default: OS temp)
 *   MDC_MEMORY_TEST_MODEL_CACHE=<dir>  optional FastEmbed cache to seed the model from instead of downloading
 *   MDC_MEMORY_PYTHON_SOURCE=<dir>     basic-memory checkout (default: vendor/basic-memory of this repo)
 *   DSH_PKGS=<dir>                     dsh's bundled @deepseek-ai packages (default: from `npm root -g`)
 */
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply } from '../host/index.js';
import { createFakeCtx, serveRoutes } from './support/fake-ctx.js';

const enabled = process.env.MDC_MEMORY_REAL_TEST === '1';
const MODEL_DIR = 'models--Qdrant--bge-small-zh-v1.5';
const READY_TIMEOUT_MS = 15 * 60_000;

function dshPackages() {
  if (process.env.DSH_PKGS) return process.env.DSH_PKGS;
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
}

/** The real `subprocess` service, mounted on a bare cordis root. */
async function realSubprocess() {
  const pkgs = dshPackages();
  const load = (name) => import(pathToFileURL(join(pkgs, name, 'lib', 'index.js')).href);
  const { Context } = await load('cordis');
  const root = new Context();
  const fiber = root.plugin((await load('dsh-subprocess-local')).default);
  await fiber;
  return { subprocess: root.get('subprocess'), dispose: () => fiber.dispose() };
}

/** Command lines of live processes serving basic-memory on `port` (Windows only). */
function serverProcesses(port) {
  const filter = `$_.Name -like 'python*' -and $_.CommandLine -like '*basic_memory.cli.main*serve*--port ${port}*'`;
  const script = `@(Get-CimInstance Win32_Process | Where-Object { ${filter} } | ForEach-Object { $_.CommandLine }) | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  return out === '' ? [] : [JSON.parse(out)].flat();
}

/** Entry names and modification times of a directory's top level; null when absent. */
function fingerprint(path) {
  if (!existsSync(path)) return null;
  return readdirSync(path).map((name) => `${name}@${statSync(join(path, name)).mtimeMs}`).sort();
}

function connects(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

test('drives the real basic-memory to ready and tears it down', { skip: !enabled && 'set MDC_MEMORY_REAL_TEST=1', timeout: READY_TIMEOUT_MS + 60_000 }, async () => {
  const pythonSource = process.env.MDC_MEMORY_PYTHON_SOURCE ?? fileURLToPath(new URL('../../../vendor/basic-memory', import.meta.url));
  const dataDir = process.env.MDC_MEMORY_TEST_DATA_DIR ?? join(tmpdir(), 'mdc-memory-real-test');
  const seed = process.env.MDC_MEMORY_TEST_MODEL_CACHE;
  const modelCache = join(dataDir, 'fastembed_cache');
  if (seed && !existsSync(join(modelCache, MODEL_DIR))) cpSync(seed, modelCache, { recursive: true });
  const userState = [join(homedir(), '.basic-memory'), join(homedir(), 'basic-memory')];
  const userStateBefore = userState.map(fingerprint);

  const dsh = await realSubprocess();
  const fake = createFakeCtx({ subprocess: dsh.subprocess });
  apply(fake.ctx, { pythonSource, dataDir });
  const http = await serveRoutes(fake.routes);
  try {
    const started = Date.now();
    let status;
    for (;;) {
      status = (await http.request('GET', '/mdc-memory/status')).body;
      if (status.state !== 'preparing') break;
      assert.ok(Date.now() - started < READY_TIMEOUT_MS, `still preparing: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(status.state, 'ready', JSON.stringify(status, null, 2));
    console.log(`basic-memory ready at ${status.endpoint} after ${Math.round((Date.now() - started) / 1000)}s`);

    const endpoint = new URL(status.endpoint);
    const port = Number(endpoint.port);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const projects = await (await fetch(`${status.endpoint}/v2/projects/`)).json();
    const main = projects.projects.find((project) => project.name === 'main');
    assert.ok(main, JSON.stringify(projects));
    assert.ok(main.path.replaceAll('/', '\\').toLowerCase().startsWith(dataDir.toLowerCase()), `main project lives in dataDir: ${main.path}`);
    assert.ok(existsSync(join(dataDir, 'config', 'config.json')), 'basic-memory config lives in dataDir');
    assert.deepEqual(userState.map(fingerprint), userStateBefore, "user's own basic-memory state untouched");

    const lanAddress = Object.values(networkInterfaces()).flat().find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    if (lanAddress) assert.equal(await connects(lanAddress, port), false, `not reachable on ${lanAddress}`);

    const windows = process.platform === 'win32';
    if (windows) assert.ok(serverProcesses(port).length > 0, 'server process visible before dispose');

    await fake.dispose();

    assert.equal(await connects('127.0.0.1', port), false, 'server stopped answering after dispose');
    if (windows) assert.deepEqual(serverProcesses(port), [], 'whole server process tree terminated');
  } finally {
    await http.close();
    await fake.dispose();
    await dsh.dispose();
  }
});
