/**
 * Minimal basic-memory source trees for the tests: every build input the Host
 * row and tools/pack require (see host/runtime/build-inputs.js) and nothing else.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write files below `root`.
 * @param {string} root
 * @param {Record<string, string>} files - content by forward-slash relative path.
 * @returns {string} `root`.
 */
export function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/**
 * A basic-memory source tree as tools/pack stages it.
 * @param {string} root
 * @returns {string} `root`.
 */
export function makeSource(root) {
  return writeTree(root, {
    'pyproject.toml': '[project]\nname = "basic-memory"\n',
    'uv.lock': 'version = 1\n',
    'README.md': '# basic-memory\n',
    'LICENSE': 'AGPL-3.0\n',
    'src/basic_memory/__init__.py': '__version__ = "0.23.2"\n',
  });
}
