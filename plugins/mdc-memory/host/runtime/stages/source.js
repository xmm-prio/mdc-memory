/**
 * Stage `source`: check the basic-memory source tree the venv is built from
 * and fingerprint its build inputs. A packaged source has no .git, so its
 * package version is a constant 0.0.0; the fingerprint is what tells one
 * source apart from the next.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { IncompleteSourceError, listBuildInputFiles } from '../build-inputs.js';

/**
 * @typedef {object} PythonSource
 * @property {string} dir - absolute path of the source tree.
 * @property {string} fingerprint - SHA-256 over the path and content of every build input file.
 */

/** @type {import('../index.js').Stage} */
export const sourceStage = {
  id: 'source',
  async run({ config, log }) {
    const dir = config.pythonSource;
    const files = await buildInputFiles(dir);
    /** @type {PythonSource} */
    const source = { dir, fingerprint: await fingerprint(dir, files) };
    log(`${dir} has fingerprint ${source.fingerprint.slice(0, 12)}`);
    return { source };
  },
};

async function buildInputFiles(dir) {
  if (!isAbsolute(dir)) throw new Error(`pythonSource must be an absolute path: ${dir}`);
  const directory = await stat(dir).then((info) => info.isDirectory(), () => false);
  if (!directory) {
    throw new Error(`basic-memory source directory does not exist: ${dir} `
      + '(a bundle packed with tools/pack ships one; otherwise set pythonSource to a basic-memory checkout)');
  }
  return listBuildInputFiles(dir).catch((error) => {
    if (error instanceof IncompleteSourceError) throw new Error(`not a basic-memory source tree (missing ${error.missing.join(', ')}): ${dir}`);
    throw error;
  });
}

async function fingerprint(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const content = await readFile(join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex');
}
