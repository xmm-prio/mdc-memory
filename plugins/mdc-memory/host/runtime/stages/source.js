/**
 * Stage `source`: check the basic-memory source tree the venv is built from
 * and fingerprint its content. A packaged source has no .git, so its package
 * version is a constant 0.0.0; the fingerprint is what tells one source
 * apart from the next.
 */
import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

const REQUIRED_FILES = ['pyproject.toml', 'uv.lock'];

/** Tooling state and caches of a working tree; they are not part of the source. */
const isClutter = (name) => name.startsWith('.') || name === '__pycache__' || name === 'node_modules';

/**
 * @typedef {object} PythonSource
 * @property {string} dir - absolute path of the source tree.
 * @property {string} fingerprint - SHA-256 over the path and content of every source file.
 */

/** @type {import('../index.js').Stage} */
export const sourceStage = {
  id: 'source',
  async run({ config, log }) {
    const dir = config.pythonSource;
    await check(dir);
    /** @type {PythonSource} */
    const source = { dir, fingerprint: await fingerprint(dir) };
    log(`${dir} has fingerprint ${source.fingerprint.slice(0, 12)}`);
    return { source };
  },
};

async function check(dir) {
  if (!isAbsolute(dir)) throw new Error(`pythonSource must be an absolute path: ${dir}`);
  const directory = await stat(dir).then((info) => info.isDirectory(), () => false);
  if (!directory) {
    throw new Error(`basic-memory source directory does not exist: ${dir} `
      + '(a bundle packed with tools/pack ships one; otherwise set pythonSource to a basic-memory checkout)');
  }
  for (const file of REQUIRED_FILES) {
    const present = await access(join(dir, file)).then(() => true, () => false);
    if (!present) throw new Error(`not a basic-memory source tree (missing ${file}): ${dir}`);
  }
}

async function fingerprint(root) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (isClutter(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  await walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = await readFile(join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex');
}
