/**
 * Registration rules for a new knowledge base, checked before basic-memory is
 * asked: basic-memory itself accepts relative paths (resolved against its own
 * working directory) and answers a repeated name idempotently.
 */
import { isAbsolute, resolve, sep } from 'node:path';

import { KnowledgeBaseError } from './errors.js';
import { sameKnowledgeBaseName } from './names.js';

const WINDOWS = process.platform === 'win32';
/** Drive-relative (`\dir`) and drive-current (`C:dir`) paths depend on the server's working directory. */
const FULLY_QUALIFIED_WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * @param {unknown} input - `{ name, path }` as the caller sent it.
 * @returns {{ name: string, path: string }} the trimmed name and the normalized absolute path.
 * @throws {KnowledgeBaseError} invalid-request | path-not-absolute
 */
export function parseRegistration(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  if (name === '') throw new KnowledgeBaseError('invalid-request', 'name must be a non-empty string');
  if (path === '') throw new KnowledgeBaseError('invalid-request', 'path must be a non-empty string');
  if (!(WINDOWS ? FULLY_QUALIFIED_WINDOWS_PATH.test(path) : isAbsolute(path))) {
    throw new KnowledgeBaseError('path-not-absolute', `path must be absolute: ${path}`);
  }
  return { name, path: resolve(path) };
}

/**
 * Refuse a registration that collides with an existing basic-memory project.
 * @param {{ name: string, path: string }} registration
 * @param {readonly import('../basic-memory/client.js').Project[]} projects - every project, the default included.
 * @throws {KnowledgeBaseError} name-taken | name-reserved | path-registered | path-reserved
 */
export function assertRegistrable(registration, projects) {
  const named = projects.find((project) => sameKnowledgeBaseName(project.name, registration.name));
  if (named?.is_default) throw new KnowledgeBaseError('name-reserved', `name ${registration.name} is reserved for internal use`);
  if (named) throw new KnowledgeBaseError('name-taken', `a knowledge base named ${named.name} already exists`, { knowledgeBase: named.name });
  const overlapping = projects.find((project) => overlaps(project.path, registration.path));
  if (overlapping?.is_default) throw new KnowledgeBaseError('path-reserved', `path overlaps the internal memory directory ${overlapping.path}`);
  if (overlapping) {
    throw new KnowledgeBaseError('path-registered', `path overlaps knowledge base ${overlapping.name} at ${overlapping.path}`, { knowledgeBase: overlapping.name });
  }
}

/** Whether two directories are the same or one contains the other. */
function overlaps(a, b) {
  const [left, right] = [pathKey(a), pathKey(b)];
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/** Comparable form ending in a separator, so `C:\kb` does not contain `C:\kb2`. */
function pathKey(path) {
  const resolved = resolve(path);
  const key = resolved.endsWith(sep) ? resolved : resolved + sep;
  return WINDOWS ? key.toLowerCase() : key;
}
