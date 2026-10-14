/**
 * The managed basic-memory runtime: runs the preparation pipeline, keeps the
 * server alive, and exposes the status.
 */
import { createEnvironment } from './environment.js';
import { describeOutcome, ProcessGroup } from './process-group.js';
import { modelStage } from './stages/model.js';
import { serverStage } from './stages/server.js';
import { sourceStage } from './stages/source.js';
import { venvStage } from './stages/venv.js';
import { createStatus } from './status.js';

/**
 * @typedef {object} StageContext
 * @property {import('../config.js').HostConfig} config
 * @property {ReturnType<typeof createEnvironment>} environment
 * @property {ProcessGroup} processes - the attempt's processes; closed on failure, retry or stop.
 * @property {Readonly<Record<string, any>>} facts - facts resolved by the earlier stages of the attempt.
 * @property {(line: string) => void} log - progress and output line of the stage.
 */

/**
 * @typedef {object} Stage
 * @property {string} id
 * @property {(context: StageContext) => Promise<object | void>} run - resolves with facts merged for
 *   later stages; the final stage provides `server: { endpoint, exited }`, which the runtime watches.
 */

/** @type {readonly Stage[]} */
const STAGES = [sourceStage, venvStage, modelStage, serverStage];

const OUTPUT_TAIL_LINES = 30;
const OUTPUT_LINE_CHARS = 500;

/** The last lines a stage printed, kept for the error report. */
function createOutputTail() {
  const lines = [];
  return {
    push(line) {
      lines.push(line.length > OUTPUT_LINE_CHARS ? `${line.slice(0, OUTPUT_LINE_CHARS)}…` : line);
      if (lines.length > OUTPUT_TAIL_LINES) lines.shift();
    },
    text: () => lines.join('\n'),
  };
}

/**
 * @param {object} deps
 * @param {import('../config.js').HostConfig} deps.config
 * @param {object} deps.subprocess - the dsh `subprocess` service.
 * @param {object} deps.logger - the plugin logger.
 */
export function createRuntime({ config, subprocess, logger }) {
  const environment = createEnvironment(config);
  const status = createStatus(STAGES.map((stage) => stage.id));
  let attempt;

  async function execute(processes) {
    status.begin();
    const facts = {};
    const outputs = new Map();
    for (const stage of STAGES) {
      const output = createOutputTail();
      outputs.set(stage.id, output);
      const log = (line) => {
        output.push(line);
        status.progress(stage.id, line);
      };
      status.enter(stage.id);
      logger.info(`mdc-memory: stage ${stage.id} started`);
      try {
        Object.assign(facts, await stage.run({ config, environment, processes, facts: { ...facts }, log }));
      } catch (error) {
        await fail(processes, stage.id, error instanceof Error ? error.message : String(error), output);
        return;
      }
    }
    status.ready(facts.server.endpoint);
    logger.info(`mdc-memory: basic-memory ready at ${facts.server.endpoint}`);
    const exit = await facts.server.exited.then(describeOutcome, (error) => error.message);
    await fail(processes, serverStage.id, `basic-memory exited unexpectedly (${exit})`, outputs.get(serverStage.id));
  }

  /** Fail-open: clean up the attempt and report; a stopped attempt is not a failure. */
  async function fail(processes, stageId, message, output) {
    if (processes.signal.aborted) return;
    await processes.close();
    logger.warn(`mdc-memory: stage ${stageId} failed: ${message}`);
    status.fail(stageId, message, output.text());
  }

  function start() {
    const processes = new ProcessGroup(subprocess);
    const settled = execute(processes).catch((error) => logger.error(`mdc-memory: runtime pipeline crashed: ${error?.stack ?? error}`));
    attempt = { processes, settled };
  }

  return {
    status: () => status.snapshot(),
    start,
    /**
     * Rerun the pipeline from the first stage. A failed attempt has already
     * closed its processes, so nothing from it is left running.
     * @returns {boolean} false unless the runtime is in the error state.
     */
    retry() {
      if (status.snapshot().state !== 'error') return false;
      start();
      return true;
    },
    /** Terminate the attempt's processes and wait for the pipeline to wind down. */
    async stop() {
      if (attempt === undefined) return;
      await attempt.processes.close();
      await attempt.settled;
    },
  };
}
