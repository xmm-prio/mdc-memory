/**
 * Pack the bundle into an installable tarball with the basic-memory build
 * inputs staged under its python/ directory (ADR 0003). The staged copy only
 * exists while npm packs; the bundle directory is left as it was. The bundle
 * itself defines the build inputs, so the packed files are exactly the ones
 * its `source` stage fingerprints.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { IncompleteSourceError, listBuildInputFiles } from '../../plugins/mdc-memory/host/runtime/build-inputs.js';

/** Bundle subdirectory holding the packaged source; the Host row reads it from there. */
const PACKAGED_SOURCE_DIR = 'python';

/**
 * @param {object} options
 * @param {string} options.bundleDir - the bundle package directory; its `files` must list python/.
 * @param {string} options.sourceDir - the basic-memory checkout to embed.
 * @param {string} options.outDir - directory receiving the tarball.
 * @returns {Promise<{ tarball: string, size: number, unpackedSize: number, entryCount: number, sourceFiles: number }>}
 */
export async function packBundle({ bundleDir, sourceDir, outDir }) {
  const files = await listBuildInputFiles(sourceDir).catch((error) => {
    throw error instanceof IncompleteSourceError ? incompleteCheckout(error) : error;
  });
  const stage = join(bundleDir, PACKAGED_SOURCE_DIR);
  await rm(stage, { recursive: true, force: true });
  try {
    for (const file of files) {
      await mkdir(dirname(join(stage, file)), { recursive: true });
      await copyFile(join(sourceDir, file), join(stage, file));
    }
    const staged = files.map((file) => `${PACKAGED_SOURCE_DIR}/${file}`);
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

function incompleteCheckout({ sourceDir, missing }) {
  return new Error(`${sourceDir} is not a complete basic-memory checkout (missing ${missing.join(', ')}); `
    + 'clone with --recursive or run "git submodule update --init vendor/basic-memory"');
}

/** @returns {{ filename: string, size: number, unpackedSize: number, entryCount: number, files: { path: string }[] }} */
function npmPack(cwd, outDir) {
  // npm is a .cmd shim on Windows, which only a shell can start.
  const result = spawnSync(`npm pack --json --pack-destination "${outDir}"`, { cwd, shell: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack failed (exit code ${result.status}): ${result.stderr.trim()}`);
  return JSON.parse(result.stdout)[0];
}
