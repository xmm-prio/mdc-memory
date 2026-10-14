/**
 * The files a basic-memory wheel build reads: the project metadata, the
 * package sources and every path pyproject.toml force-includes into the
 * wheel. The rest of a checkout (tests, docs, other integrations) is not
 * needed to install basic-memory.
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROJECT_INPUTS = ['pyproject.toml', 'uv.lock', 'README.md', 'LICENSE', 'src'];
const FORCE_INCLUDE_TABLE = '[tool.hatch.build.targets.wheel.force-include]';
const TABLE_KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s*=/;

/**
 * @param {string} sourceDir - root of a basic-memory checkout.
 * @returns {Promise<string[]>} build inputs (files or directories) relative to `sourceDir`.
 * @throws {Error} when the checkout lacks one of them, e.g. an uninitialized submodule.
 */
export async function listBuildInputs(sourceDir) {
  const pyproject = await readFile(join(sourceDir, 'pyproject.toml'), 'utf8').catch(() => undefined);
  if (pyproject === undefined) throw incompleteCheckout(sourceDir, ['pyproject.toml']);
  const inputs = [...PROJECT_INPUTS, ...forceIncludedPaths(pyproject)];
  const present = await Promise.all(inputs.map((input) => access(join(sourceDir, input)).then(() => true, () => false)));
  const missing = inputs.filter((_, index) => !present[index]);
  if (missing.length > 0) throw incompleteCheckout(sourceDir, missing);
  return inputs;
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

function incompleteCheckout(sourceDir, missing) {
  return new Error(`${sourceDir} is not a complete basic-memory checkout (missing ${missing.join(', ')}); `
    + 'clone with --recursive or run "git submodule update --init vendor/basic-memory"');
}
