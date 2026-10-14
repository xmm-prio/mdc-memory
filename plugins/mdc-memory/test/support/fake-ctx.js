/**
 * Minimal stand-in for the dsh plugin context handed to `apply(ctx, config)`.
 * It records effects, routes and logs, drives an agent plane (see
 * agent-plane.js) that also dispatches the plugin's event listeners, and lets
 * a test dispose the plugin the way cordis would when the row is unloaded.
 */
import http from 'node:http';

import { createAgentPlane, disposerOf, memoryScopes } from './agent-plane.js';
import { createFakeStorageDomain } from './fake-storage-domain.js';

export const AUTH_HEADER = 'x-test-auth';

/**
 * @param {object} rootServices - root services, e.g. `{ subprocess }`; `storageDomain`
 *   defaults to a fresh in-memory one, as every dsh profile mounts it.
 * @param {object} [options]
 * @param {boolean} [options.web] - provide `webServer` + `connection` (web profile); default true.
 * @param {object} [options.scopes] - agent scopes adapter; default in-memory.
 */
export function createFakeCtx(rootServices, { web = true, scopes = memoryScopes() } = {}) {
  const agents = createAgentPlane(scopes);
  const services = { storageDomain: createFakeStorageDomain(), ...agents.services, ...rootServices };
  const disposers = [];
  const routes = new Map();
  const logs = [];
  const log = (level) => (...args) => logs.push({ level, message: args.join(' ') });

  const base = {
    ...services,
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    get: (name) => services[name],
    /** Like cordis, an effect may resolve its disposer asynchronously. */
    effect(execute) {
      const dispose = disposerOf(execute());
      disposers.push(dispose);
      return dispose;
    },
    /** Like cordis, a listener is removed when the plugin is unloaded. */
    on(name, listener) {
      const off = disposerOf(agents.on(name, listener));
      disposers.push(off);
      return off;
    },
  };
  const webServices = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    connection: {
      requestRejection: (req) => (req.headers[AUTH_HEADER] === 'ok' ? undefined : 401),
    },
  };
  const ctx = {
    ...base,
    inject(deps, callback) {
      const provided = web ? { ...services, ...webServices } : services;
      if (deps.every((dep) => dep in provided)) callback({ ...base, ...provided });
    },
  };

  return {
    ctx,
    routes,
    logs,
    /** The agent plane: create and dispose agents, see what each agent sees, send user messages. */
    agents,
    /** Run a waterfall event through the plugin's and the payload agent's listeners. */
    waterfall: agents.waterfall,
    /** Run every effect disposer in reverse order, as plugin unload does. */
    async dispose() {
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose();
      disposers.length = 0;
    },
  };
}

/**
 * Serve the registered routes on a real loopback HTTP server so tests drive
 * them over the wire. Mirrors the webServer's exact-path dispatch.
 */
export async function serveRoutes(routes) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(String(req.url), 'http://localhost');
    const route = routes.get(pathname);
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      res.statusCode = 400;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    /** Authenticated request; returns `{ status, body }` with the JSON body parsed. */
    async request(method, path, { body, auth = true } = {}) {
      const headers = { accept: 'application/json' };
      if (auth) headers[AUTH_HEADER] = 'ok';
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text === '' ? undefined : JSON.parse(text) };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Poll the runtime status route until it reports `state`.
 * @param {Awaited<ReturnType<typeof serveRoutes>>} http
 * @param {'preparing' | 'ready' | 'error'} state
 * @returns {Promise<object>} the status body.
 */
export async function waitForState(http, state, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await http.request('GET', '/mdc-memory/status');
    if (body.state === state) return body;
    if (Date.now() > deadline) throw new Error(`status stayed ${JSON.stringify(body)} instead of ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
