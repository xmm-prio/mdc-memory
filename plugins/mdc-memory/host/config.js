/**
 * Host row configuration. A user patch replaces the whole `config` object, so
 * every field gets its default here rather than relying on the bundle patch.
 * Only shape is validated; whether `pythonSource` points at a usable checkout
 * is a runtime fact reported through the status (fail-open).
 */
import { isAbsolute } from 'node:path';

/**
 * @typedef {object} HostConfig
 * @property {string | undefined} pythonSource - absolute path of the basic-memory source tree.
 * @property {string} dataDir - absolute directory holding the venv, model cache and basic-memory state.
 * @property {string} python - bare PATH name or absolute path of the Python that runs `uv`.
 */

/**
 * @param {unknown} raw - the row's config as written in the patch.
 * @param {{ dataDir?: string }} defaults - composition-derived defaults.
 * @returns {Readonly<HostConfig>}
 * @throws {TypeError} when a field has the wrong shape.
 */
export function resolveConfig(raw, defaults) {
  const input = raw ?? {};
  if (typeof input !== 'object') throw new TypeError('mdc-memory: config must be an object');
  return Object.freeze({
    pythonSource: optionalString(input.pythonSource, 'pythonSource'),
    dataDir: absolutePath(input.dataDir ?? defaults.dataDir, 'dataDir'),
    python: nonEmptyString(input.python ?? 'python', 'python'),
  });
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
