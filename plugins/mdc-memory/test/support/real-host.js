/**
 * The Host row applied the way a dsh launch does, against dsh's real services
 * (see real-dsh.js) and the real basic-memory, for the opt-in real tests.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { apply } from '../../host/index.js';
import { createFakeCtx, serveRoutes } from './fake-ctx.js';
import { realDsh } from './real-dsh.js';

export const READY_TIMEOUT_MS = 15 * 60_000;

/**
 * Apply the Host row and wait until basic-memory is ready. Starting again
 * over the same `workdir` behaves like a dsh restart.
 * @param {object} options
 * @param {string} options.workdir - holds dsh's storages.
 * @param {object} options.config - the row's config.
 * @param {(fake: object) => Promise<void>} [options.beforeApply] - e.g. create agents that exist before the plugin loads.
 * @returns {Promise<{ fake: object, http: object, endpoint: string, stop: () => Promise<void> }>}
 */
export async function startRealHost({ workdir, config, beforeApply }) {
  const dsh = await realDsh({ storageRoot: join(workdir, 'storages') });
  const fake = createFakeCtx({ subprocess: dsh.subprocess, storageDomain: dsh.storageDomain }, { scopes: dsh.agentScopes });
  await beforeApply?.(fake);
  apply(fake.ctx, config);
  const http = await serveRoutes(fake.routes);
  const started = Date.now();
  let status;
  for (;;) {
    status = (await http.request('GET', '/mdc-memory/status')).body;
    if (status.state !== 'preparing') break;
    assert.ok(Date.now() - started < READY_TIMEOUT_MS, `still preparing: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(status.state, 'ready', JSON.stringify(status, null, 2));
  return {
    fake,
    http,
    endpoint: status.endpoint,
    async stop() {
      await http.close();
      await fake.dispose();
      await dsh.dispose();
    },
  };
}

/** The persistent test dataDir may hold projects of an earlier, aborted run. */
export async function unregisterLeftoverProjects(endpoint) {
  const { projects } = await (await fetch(`${endpoint}/v2/projects/`)).json();
  for (const project of projects.filter((candidate) => !candidate.is_default)) {
    const res = await fetch(`${endpoint}/v2/projects/${project.external_id}?delete_notes=false`, { method: 'DELETE' });
    assert.equal(res.status, 200, `unregistering ${project.name} answered ${res.status}`);
  }
}

/** Poll until `probe` resolves to a truthy value, which is returned. */
export async function until(probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    assert.ok(Date.now() < deadline, 'condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
