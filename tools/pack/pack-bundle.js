/**
 * Pack the bundle into an installable tarball with the basic-memory build
 * inputs staged under its python/ directory (ADR 0003). The staged copy only
 * exists while npm packs; the bundle directory is left as it was.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { listBuildInputs } from './build-inputs.js';

/** Bundle subdirectory holding the packaged source; the Host row reads it from there. */
const PACKAGED_SOURCE_DIR = 'python';

/** Tooling state and caches of a working tree, never part of the packaged source. */
const isClutter = (name) => name.startsWith('.') || name === '__pycache__' || name === 'node_modules';

/**
 * @param {object} options
 * @param {string} options.bundleDir - the bundle package directory; its `files` must list python/.
 * @param {string} options.sourceDir - the basic-memory checkout to embed.
 * @param {string} options.outDir - directory receiving the tarball.
 * @returns {Promise<{ tarball: string, size: number, unpackedSize: number, entryCount: number, sourceFiles: number }>}
 */
export async function packBundle({ bundleDir, sourceDir, outDir }) {
  const inputs = await listBuildInputs(sourceDir);
  const stage = join(bundleDir, PACKAGED_SOURCE_DIR);
  await rm(stage, { recursive: true, force: true });
  try {
    for (const input of inputs) {
      await cp(join(sourceDir, input), join(stage, input), { recursive: true, filter: (src) => !isClutter(basename(src)) });
    }
    const staged = (await listFiles(stage)).map((file) => `${PACKAGED_SOURCE_DIR}/${file}`);
    await mkdir(outDir, { recursive: true });
    const report = npmPack(bundleDir, outDir);
    const tarball = join(outDir, report.filename);
    const packed = new Set(report.files.map((file) => file.path));
    const dropped = staged.filter((file) => !packed.has(file));
    if (dropped.length > 0) {
      await rm(tarball, { force: true });
      throw new Error(`npm pack left out ${dropped.length} staged source files, e.g. ${dropped.slice(0, 5).join(', ')}`);
    }
    return { tarball, size: report.size, unpackedSize: report.unpackedSize, entryCount: report.entryCount, sourceFiles: staged.length };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Every file below `dir`, as a forward-slash path relative to it. */
async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

/** @returns {{ filename: string, size: number, unpackedSize: number, entryCount: number, files: { path: string }[] }} */
function npmPack(cwd, outDir) {
  // npm is a .cmd shim on Windows, which only a shell can start.
  const result = spawnSync(`npm pack --json --pack-destination "${outDir}"`, { cwd, shell: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack failed (exit code ${result.status}): ${result.stderr.trim()}`);
  return JSON.parse(result.stdout)[0];
}
