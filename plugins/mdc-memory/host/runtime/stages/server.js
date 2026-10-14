/**
 * Stage `server`: start `basic-memory serve` on a free loopback port and wait
 * until its REST API answers. The process keeps running after the stage; the
 * runtime watches `server.exited`.
 */
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { describeOutcome } from '../process-group.js';

const HOST = '127.0.0.1';
const HEALTH_PATH = '/v2/projects/';
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
// A private agent keeps loopback probes off any proxy configured on the global agent.
const probeAgent = new http.Agent();

/** @type {import('../index.js').Stage} */
export const serverStage = {
  id: 'server',
  async run({ environment, processes, log }) {
    const { paths } = environment;
    await Promise.all([mkdir(paths.config, { recursive: true }), mkdir(paths.home, { recursive: true })]);
    const python = await processes.resolve(paths.python);
    const port = await freePort();
    const endpoint = `http://${HOST}:${port}`;
    log(`Starting basic-memory on ${endpoint}`);
    const { exited } = processes.start({
      argv: [python, '-m', 'basic_memory.cli.main', 'serve', '--host', HOST, '--port', String(port)],
      cwd: paths.dataDir,
      env: environment.basicMemory(),
      onLine: log,
    });
    await waitUntilHealthy(endpoint, exited, processes.signal);
    return { server: { endpoint, exited } };
  },
};

async function waitUntilHealthy(endpoint, exited, signal) {
  let exit;
  exited.then((outcome) => { exit = describeOutcome(outcome); }, (error) => { exit = error.message; });
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (await probe(endpoint + HEALTH_PATH, signal)) return;
    signal.throwIfAborted();
    if (exit !== undefined) throw new Error(`basic-memory exited during startup (${exit})`);
    if (Date.now() >= deadline) throw new Error(`basic-memory did not answer ${HEALTH_PATH} within ${HEALTH_TIMEOUT_MS / 1000}s`);
    await delay(HEALTH_INTERVAL_MS, undefined, { signal });
  }
}

/** @returns {Promise<boolean>} whether the URL answered 200. */
function probe(url, signal) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: probeAgent, signal, timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
