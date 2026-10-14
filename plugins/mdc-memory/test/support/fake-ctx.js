/**
 * Minimal stand-in for the dsh plugin context handed to `apply(ctx, config)`.
 * It records effects, routes and logs, and lets a test dispose the plugin the
 * way cordis would when the row is unloaded.
 */
import http from 'node:http';

import { createFakeStorageDomain } from './fake-storage-domain.js';

export const AUTH_HEADER = 'x-test-auth';

/**
 * @param {object} rootServices - root services, e.g. `{ subprocess }`; `storageDomain`
 *   defaults to a fresh in-memory one, as every dsh profile mounts it.
 * @param {object} [options]
 * @param {boolean} [options.web] - provide `webServer` + `connection` (web profile); default true.
 */
export function createFakeCtx(rootServices, { web = true } = {}) {
  const services = { storageDomain: createFakeStorageDomain(), ...rootServices };
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
      const result = execute();
      const dispose = typeof result?.then === 'function'
        ? async () => { const resolved = await result; if (typeof resolved === 'function') await resolved(); }
        : result;
      disposers.push(dispose);
      return dispose;
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
