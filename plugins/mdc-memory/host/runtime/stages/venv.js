/**
 * Stage `venv`: build the basic-memory virtual environment in dataDir from
 * the configured source tree with `python -m uv sync`.
 */
import { access, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const PYTHON_VERSION = '3.12';
const REQUIRED_SOURCE_FILES = ['pyproject.toml', 'uv.lock'];

/** @type {import('../index.js').Stage} */
export const venvStage = {
  id: 'venv',
  async run({ config, environment, processes, log }) {
    const source = await checkSource(config.pythonSource);
    await mkdir(environment.paths.dataDir, { recursive: true });
    const python = await processes.resolve(config.python);
    log(`Syncing ${environment.paths.venv} from ${source}`);
    await processes.run('uv sync', {
      // --python pins the interpreter: the source tree's .python-version names a newer one.
      argv: [python, '-m', 'uv', 'sync', '--python', PYTHON_VERSION, '--frozen', '--no-dev'],
      cwd: source,
      env: environment.uv(),
      onLine: log,
    });
  },
};

async function checkSource(pythonSource) {
  if (pythonSource === undefined) {
    throw new Error('pythonSource is not configured; set it to the basic-memory source directory in the mdc-memory plugin config');
  }
  if (!isAbsolute(pythonSource)) throw new Error(`pythonSource must be an absolute path: ${pythonSource}`);
  const directory = await stat(pythonSource).then((info) => info.isDirectory(), () => false);
  if (!directory) throw new Error(`pythonSource directory does not exist: ${pythonSource}`);
  for (const file of REQUIRED_SOURCE_FILES) {
    const present = await access(join(pythonSource, file)).then(() => true, () => false);
    if (!present) throw new Error(`pythonSource is not a basic-memory source tree (missing ${file}): ${pythonSource}`);
  }
  return pythonSource;
}
