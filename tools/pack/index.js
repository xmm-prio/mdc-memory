/**
 * Pack the mdc-memory bundle, with vendor/basic-memory embedded, into an
 * installable tarball:
 *
 *   node tools/pack/index.js [--out <dir>]
 *
 * The tarball goes to dist/ unless --out names another directory.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { packBundle } from './pack-bundle.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

try {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const result = await packBundle({
    bundleDir: join(REPO, 'plugins', 'mdc-memory'),
    sourceDir: join(REPO, 'vendor', 'basic-memory'),
    outDir: resolve(values.out ?? join(REPO, 'dist')),
  });
  console.log(`Packed ${result.tarball}`);
  console.log(`  ${result.entryCount} files (${result.sourceFiles} from basic-memory), ${megabytes(result.size)} packed, ${megabytes(result.unpackedSize)} unpacked`);
  console.log(`Install with: dsh plugin --profile web add "${result.tarball}"`);
} catch (error) {
  console.error(`pack failed: ${error.message}`);
  process.exitCode = 1;
}
