/**
 * Stage `venv`: keep the basic-memory virtual environment in dataDir built
 * from the current source. The venv records what it was built from; while the
 * record matches, the venv is reused as is, otherwise `python -m uv sync`
 * rebuilds it.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const PYTHON_VERSION = '3.12';
const PACKAGE = 'basic-memory';
const SYNC_ARGS = Object.freeze([
  '-m', 'uv', 'sync',
  // Pins the interpreter: the source tree's .python-version names a newer one.
  '--python', PYTHON_VERSION,
  '--frozen', '--no-dev',
  // A copy rather than a link, so the venv does not depend on the bundle directory.
  '--no-editable',
  // The version of a packaged source never changes, so uv would reuse a stale build of it.
  '--reinstall-package', PACKAGE,
]);

/** @type {import('../index.js').Stage} */
export const venvStage = {
  id: 'venv',
  async run({ config, environment, processes, facts, log }) {
    const { paths } = environment;
    const source = /** @type {import('./source.js').PythonSource} */ (facts.source);
    const build = JSON.stringify({ args: SYNC_ARGS, source: source.fingerprint });
    if (await readFile(paths.venvBuild, 'utf8').catch(() => undefined) === build) {
      log(`${paths.venv} is up to date`);
      return;
    }
    await mkdir(paths.dataDir, { recursive: true });
    // An interrupted rebuild must not leave the previous record claiming the venv.
    await rm(paths.venvBuild, { force: true });
    const python = await processes.resolve(config.python);
    log(`Building ${paths.venv} from ${source.dir}`);
    await processes.run('uv sync', {
      argv: [python, ...SYNC_ARGS],
      cwd: source.dir,
      env: environment.uv(),
      onLine: log,
    });
    await writeFile(paths.venvBuild, build);
  },
};
