/**
 * The isolated basic-memory environment inside `dataDir`: directory layout and
 * the process environment for each kind of child. Everything basic-memory
 * reads or writes stays under `dataDir`, never the user's ~/.basic-memory.
 */
import { isIPv6 } from 'node:net';
import { join } from 'node:path';

export const EMBEDDING = Object.freeze({
  provider: 'fastembed',
  model: 'BAAI/bge-small-zh-v1.5',
  dimensions: 512,
});

const BASIC_MEMORY_ENV_PREFIX = 'BASIC_MEMORY_';
/** Proxy bypass names, lowercase first: Python's urllib (read by httpx) prefers the lowercase one. */
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY'];

/** @param {import('../config.js').HostConfig} config */
export function createEnvironment({ dataDir, segmentation, segmentationUserDict }) {
  const venv = join(dataDir, 'venv');
  const paths = Object.freeze({
    dataDir,
    venv,
    python: process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    /** What the venv was built from; inside the venv, so it disappears with it. */
    venvBuild: join(venv, 'mdc-memory-build.json'),
    config: join(dataDir, 'config'),
    home: join(dataDir, 'main'),
    modelCache: join(dataDir, 'fastembed_cache'),
  });

  const python = () => ({
    ...pythonProxyBypass(),
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  });

  return Object.freeze({
    paths,
    /** Environment for `uv sync`: the venv lives in dataDir, outside the source tree. */
    uv: () => ({ UV_PROJECT_ENVIRONMENT: paths.venv }),
    /** Environment for plain Python commands run from the venv. */
    python,
    /** Environment for the basic-memory server; ambient BASIC_MEMORY_* settings are removed. */
    basicMemory: () => ({
      ...ambientBasicMemoryTombstones(),
      ...python(),
      BASIC_MEMORY_CONFIG_DIR: paths.config,
      BASIC_MEMORY_HOME: paths.home,
      BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER: EMBEDDING.provider,
      BASIC_MEMORY_SEMANTIC_EMBEDDING_MODEL: EMBEDDING.model,
      BASIC_MEMORY_SEMANTIC_EMBEDDING_DIMENSIONS: String(EMBEDDING.dimensions),
      BASIC_MEMORY_SEMANTIC_EMBEDDING_CACHE_DIR: paths.modelCache,
      BASIC_MEMORY_SCRIPT_SEGMENTATION: segmentation,
      BASIC_MEMORY_SCRIPT_SEGMENTATION_USER_DICT: segmentationUserDict,
      BASIC_MEMORY_AUTO_UPDATE: 'false',
      BASIC_MEMORY_NO_PROMOS: '1',
      LOGFIRE_IGNORE_NO_CONFIG: '1',
    }),
  });
}

/**
 * The inherited proxy bypass list spelled for Python HTTP clients, under both
 * casings. httpx turns every entry into a URL pattern and cannot parse a
 * bracketed IPv6 literal (`[::1]` fails with "Invalid port"), so such an entry
 * is written bare; a bracketed entry with a port has no bare spelling and is
 * dropped. Entries are deduplicated case-insensitively in their original order.
 */
function pythonProxyBypass() {
  const inherited = NO_PROXY_NAMES.map((name) => process.env[name]?.trim()).find(Boolean);
  if (inherited === undefined) return {};
  const seen = new Set();
  const entries = [];
  for (const raw of inherited.split(/[,\s]+/)) {
    const entry = pythonBypassEntry(raw);
    if (entry === undefined || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    entries.push(entry);
  }
  const value = entries.join(',');
  return Object.fromEntries(NO_PROXY_NAMES.map((name) => [name, value]));
}

/** @returns {string | undefined} the entry as Python clients parse it, or undefined when it has no such spelling. */
function pythonBypassEntry(entry) {
  if (entry === '') return undefined;
  if (!entry.startsWith('[')) return entry;
  const literal = /^\[([^\]]*)\]$/.exec(entry)?.[1];
  return literal !== undefined && isIPv6(literal) ? literal : undefined;
}

/** `undefined` entries remove inherited variables from the child environment. */
function ambientBasicMemoryTombstones() {
  return Object.fromEntries(Object.keys(process.env)
    .filter((key) => key.toUpperCase().startsWith(BASIC_MEMORY_ENV_PREFIX))
    .map((key) => [key, undefined]));
}
