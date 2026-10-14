/**
 * Stage `model`: make sure the embedding model is in the cache the server
 * reads. FastEmbed loads lazily, so without this stage the first search would
 * block on the download; here its progress and failure are visible instead.
 */
import { mkdir } from 'node:fs/promises';

import { EMBEDDING } from '../environment.js';

const DOWNLOAD_SCRIPT = [
  'import sys',
  'from fastembed import TextEmbedding',
  'TextEmbedding(model_name=sys.argv[1], cache_dir=sys.argv[2])',
  'print("embedding model ready")',
].join('\n');

/** @type {import('../index.js').Stage} */
export const modelStage = {
  id: 'model',
  async run({ environment, processes, log }) {
    const { paths } = environment;
    await mkdir(paths.modelCache, { recursive: true });
    const python = await processes.resolve(paths.python);
    log(`Fetching ${EMBEDDING.model}`);
    await processes.run('embedding model download', {
      argv: [python, '-c', DOWNLOAD_SCRIPT, EMBEDDING.model, paths.modelCache],
      cwd: paths.dataDir,
      env: environment.python(),
      onLine: log,
    });
  },
};
