/**
 * The child processes of one pipeline attempt, spawned through the dsh
 * `subprocess` service. Closing the group aborts every spawn and waits until
 * each managed process tree is gone.
 */
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const GRACE_MS = 5000;
const DRAIN_TIMEOUT_MS = 1000;

/** A command that ran to completion with a non-zero exit. */
export class CommandFailedError extends Error {
  constructor(label, outcome) {
    super(`${label} failed (${describeOutcome(outcome)})`);
    this.name = 'CommandFailedError';
  }
}

/** @param {{ exitCode: number | null, signal: string | null }} outcome */
export function describeOutcome(outcome) {
  return outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
}

export class ProcessGroup {
  #subprocess;
  #controller = new AbortController();
  #handles = new Set();

  /** @param {object} subprocess - the dsh `subprocess` service. */
  constructor(subprocess) {
    this.#subprocess = subprocess;
  }

  /** Aborted once the group closes. */
  get signal() {
    return this.#controller.signal;
  }

  /**
   * Resolve a bare PATH name or verify an absolute executable path.
   * @param {string} command
   * @returns {Promise<string>} the absolute executable path.
   */
  resolve(command) {
    return this.#subprocess.resolveExecutable(command, undefined, this.signal);
  }

  /**
   * Start a process whose stdout and stderr lines go to `onLine`.
   * @param {{ argv: string[], cwd: string, env: object, onLine: (line: string) => void }} spec
   * @returns {{ exited: Promise<{ exitCode: number | null, signal: string | null }> }}
   */
  start({ argv, cwd, env, onLine }) {
    this.signal.throwIfAborted();
    const handle = this.#subprocess.spawn({
      argv,
      cwd,
      env,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: GRACE_MS,
      signal: this.signal,
    });
    this.#handles.add(handle);
    // Piped output must be drained continuously or the child blocks on a full pipe.
    const drained = Promise.all([handle.stdout, handle.stderr].map((input) => {
      const lines = createInterface({ input, crlfDelay: Infinity });
      lines.on('line', onLine);
      return once(lines, 'close');
    })).catch(() => {});
    // Output can trail the exit report; a descendant holding the pipe must not delay it forever.
    const exited = handle.done.then(async (outcome) => {
      await Promise.race([drained, delay(DRAIN_TIMEOUT_MS)]);
      return outcome;
    });
    return { exited };
  }

  /**
   * Run a process to completion.
   * @param {string} label - command name used in the failure message.
   * @throws {CommandFailedError} on a non-zero exit.
   */
  async run(label, spec) {
    const outcome = await this.start(spec).exited;
    if (outcome.exitCode !== 0) throw new CommandFailedError(label, outcome);
  }

  /** Abort pending work and wait until every spawned process tree has exited. */
  async close() {
    this.#controller.abort();
    await Promise.all([...this.#handles].map(async (handle) => {
      handle.terminate();
      await handle.waitForExit().catch(() => {});
    }));
  }
}
