/**
 * Real dsh services and test-data settings shared by the opt-in tests that
 * drive a real basic-memory. Services come from dsh's bundled packages,
 * mounted on a bare cordis root; nothing is installed into a dsh profile.
 *
 *   MDC_MEMORY_REAL_TEST=1             enable
 *   MDC_MEMORY_TEST_DATA_DIR=<dir>     persistent dataDir; reruns reuse its venv and model (default: OS temp)
 *   MDC_MEMORY_TEST_MODEL_CACHE=<dir>  optional FastEmbed cache to seed the model from instead of downloading
 *   MDC_MEMORY_PYTHON_SOURCE=<dir>     basic-memory checkout (default: vendor/basic-memory of this repo)
 *   DSH_PKGS=<dir>                     dsh's bundled @deepseek-ai packages (default: from `npm root -g`)
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REAL_TEST_ENABLED = process.env.MDC_MEMORY_REAL_TEST === '1';
export const REAL_TEST_SKIP = !REAL_TEST_ENABLED && 'set MDC_MEMORY_REAL_TEST=1';

const MODEL_DIR = 'models--Qdrant--bge-small-zh-v1.5';

/**
 * Host config for the real tests; seeds the model cache when a seed is given.
 * @returns {{ pythonSource: string, dataDir: string }}
 */
export function realHostConfig() {
  const pythonSource = process.env.MDC_MEMORY_PYTHON_SOURCE ?? fileURLToPath(new URL('../../../../vendor/basic-memory', import.meta.url));
  const dataDir = process.env.MDC_MEMORY_TEST_DATA_DIR ?? join(tmpdir(), 'mdc-memory-real-test');
  const seed = process.env.MDC_MEMORY_TEST_MODEL_CACHE;
  const modelCache = join(dataDir, 'fastembed_cache');
  if (seed && !existsSync(join(modelCache, MODEL_DIR))) cpSync(seed, modelCache, { recursive: true });
  return { pythonSource, dataDir };
}

function dshPackages() {
  if (process.env.DSH_PKGS) return process.env.DSH_PKGS;
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
}

/**
 * The real `subprocess` and `storageDomain` services, the latter persisting
 * JSON files under `storageRoot` like dsh's own `storages` directory.
 * Disposing and mounting again over the same root behaves like a dsh restart.
 * @param {{ storageRoot: string }} options
 */
export async function realDsh({ storageRoot }) {
  const pkgs = dshPackages();
  const load = (name) => import(pathToFileURL(join(pkgs, name, 'lib', 'index.js')).href);
  const { Context } = await load('cordis');
  const root = new Context();
  const fibers = [
    root.plugin((await load('dsh-subprocess-local')).default),
    root.plugin((await load('dsh-storage')).default),
    root.plugin(await load('dsh-storage-json'), { root: storageRoot }),
    root.plugin(await load('dsh-storage-domain'), { backend: 'json' }),
  ];
  await Promise.all(fibers);
  return {
    subprocess: root.get('subprocess'),
    storageDomain: root.get('storageDomain'),
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose();
    },
  };
}
