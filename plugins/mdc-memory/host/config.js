/**
 * Host row configuration. A user patch replaces the whole `config` object, so
 * every field gets its default here rather than relying on the bundle patch.
 * Only shape is validated; whether `pythonSource` points at a usable checkout
 * is a runtime fact reported through the status (fail-open).
 */
import { isAbsolute } from 'node:path';

/**
 * @typedef {object} HostConfig
 * @property {string} pythonSource - absolute path of the basic-memory source tree; by default the one packed into the bundle.
 * @property {string} dataDir - absolute directory holding the venv, model cache and basic-memory state.
 * @property {string} python - bare PATH name or absolute path of the Python that runs `uv`.
 * @property {'jieba' | 'ngram'} segmentation - how full-text search splits Chinese and other unspaced scripts.
 * @property {string | undefined} segmentationUserDict - absolute path of a jieba user dictionary.
 * @property {readonly string[]} memoryTools - names of the basic-memory MCP tools offered to agents (the whitelist).
 */

const SEGMENTATIONS = ['jieba', 'ngram'];

/** Note writing, reading, editing, search, context traversal, recent activity and directory browsing. */
const DEFAULT_MEMORY_TOOLS = Object.freeze([
  'write_note',
  'read_note',
  'edit_note',
  'search_notes',
  'build_context',
  'recent_activity',
  'list_directory',
]);
/** An agent tool is named `memory_<upstream name>`, within the 64-character `[A-Za-z0-9_-]` function-name contract. */
const MEMORY_TOOL_NAME = /^[A-Za-z0-9_-]{1,57}$/;

/**
 * @param {unknown} raw - the row's config as written in the patch.
 * @param {{ dataDir?: string, pythonSource: string }} defaults - composition- and package-derived defaults.
 * @returns {Readonly<HostConfig>}
 * @throws {TypeError} when a field has the wrong shape.
 */
export function resolveConfig(raw, defaults) {
  const input = raw ?? {};
  if (typeof input !== 'object') throw new TypeError('mdc-memory: config must be an object');
  return Object.freeze({
    pythonSource: optionalString(input.pythonSource, 'pythonSource') ?? defaults.pythonSource,
    dataDir: absolutePath(input.dataDir ?? defaults.dataDir, 'dataDir'),
    python: nonEmptyString(input.python ?? 'python', 'python'),
    segmentation: oneOf(input.segmentation ?? 'jieba', SEGMENTATIONS, 'segmentation'),
    segmentationUserDict: optionalAbsolutePath(input.segmentationUserDict, 'segmentationUserDict'),
    memoryTools: toolNames(input.memoryTools ?? DEFAULT_MEMORY_TOOLS, 'memoryTools'),
  });
}

function toolNames(value, field) {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && MEMORY_TOOL_NAME.test(name))) {
    throw new TypeError(`mdc-memory: ${field} must be a list of tool names (letters, digits, '_' or '-', at most 57 characters)`);
  }
  return Object.freeze([...new Set(value)]);
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`mdc-memory: ${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function optionalAbsolutePath(value, field) {
  const path = optionalString(value, field);
  return path === undefined ? undefined : absolutePath(path, field);
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`mdc-memory: ${field} must be a string`);
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`mdc-memory: ${field} must be a non-empty string`);
  return value;
}

function absolutePath(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError(`mdc-memory: ${field} must be an absolute path`);
  return value;
}
