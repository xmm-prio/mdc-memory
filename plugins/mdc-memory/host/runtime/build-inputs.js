/**
 * The basic-memory build inputs: the files a wheel build reads, that is the
 * project metadata, the package sources and every path pyproject.toml
 * force-includes into the wheel. The rest of a checkout (tests, docs, other
 * integrations, tool state and caches) is not needed to install basic-memory.
 *
 * tools/pack packs exactly these files into the bundle and the `source` stage
 * fingerprints exactly these files, so a packaged source fingerprints like the
 * checkout it was packed from, and an edit outside them never rebuilds the venv.
 */
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PROJECT_INPUTS = ['pyproject.toml', 'uv.lock', 'README.md', 'LICENSE', 'src'];
const FORCE_INCLUDE_TABLE = '[tool.hatch.build.targets.wheel.force-include]';
const TABLE_KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s*=/;

/** Tooling state and caches of a working tree, never part of the source. */
const isClutter = (name) => name.startsWith('.') || name === '__pycache__' || name === 'node_modules';

/** A source tree that lacks some build inputs, e.g. an uninitialized submodule. */
export class IncompleteSourceError extends Error {
  /**
   * @param {string} sourceDir
   * @param {string[]} missing - the absent build inputs, relative to `sourceDir`.
   */
  constructor(sourceDir, missing) {
    super(`${sourceDir} lacks basic-memory build inputs: ${missing.join(', ')}`);
    this.name = 'IncompleteSourceError';
    this.sourceDir = sourceDir;
    this.missing = missing;
  }
}

/**
 * @param {string} sourceDir - root of a basic-memory source tree.
 * @returns {Promise<string[]>} every build input file, as a forward-slash path relative to `sourceDir`, sorted.
 * @throws {IncompleteSourceError} when a build input is absent.
 */
export async function listBuildInputFiles(sourceDir) {
  const pyproject = await readFile(join(sourceDir, 'pyproject.toml'), 'utf8').catch(() => undefined);
  if (pyproject === undefined) throw new IncompleteSourceError(sourceDir, ['pyproject.toml']);
  const inputs = [...PROJECT_INPUTS, ...forceIncludedPaths(pyproject)];
  const present = await Promise.all(inputs.map((input) => access(join(sourceDir, input)).then(() => true, () => false)));
  const missing = inputs.filter((_, index) => !present[index]);
  if (missing.length > 0) throw new IncompleteSourceError(sourceDir, missing);
  const files = [];
  for (const input of inputs) await collectFiles(sourceDir, input, files);
  return files.sort();
}

async function collectFiles(root, path, files) {
  if (!(await stat(join(root, path))).isDirectory()) {
    files.push(path);
    return;
  }
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (isClutter(entry.name)) continue;
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) await collectFiles(root, child, files);
    else if (entry.isFile()) files.push(child);
  }
}

/** Keys of the force-include table: source paths relative to the project root. */
function forceIncludedPaths(pyproject) {
  const paths = [];
  let inTable = false;
  for (const raw of pyproject.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inTable = line === FORCE_INCLUDE_TABLE;
      continue;
    }
    if (!inTable || line === '' || line.startsWith('#')) continue;
    const key = TABLE_KEY.exec(line)?.[1];
    if (key === undefined) throw new Error(`Unsupported force-include entry in pyproject.toml: ${line}`);
    paths.push(unquote(key));
  }
  return paths;
}

function unquote(key) {
  if (key.startsWith('"')) return JSON.parse(key);
  if (key.startsWith("'")) return key.slice(1, -1);
  return key;
}
