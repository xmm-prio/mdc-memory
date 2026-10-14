/**
 * Client of the managed basic-memory server's v2 REST API. Requests go to the
 * endpoint the runtime reports while it is ready; otherwise they fail with
 * `BasicMemoryUnavailableError` (fail-open callers decide what that means).
 */
import http from 'node:http';

const REQUEST_TIMEOUT_MS = 30_000;
// A private agent keeps loopback requests off any proxy configured on the global agent.
const loopbackAgent = new http.Agent({ keepAlive: true });

/** basic-memory is not running or not ready yet. */
export class BasicMemoryUnavailableError extends Error {
  constructor(message = 'basic-memory is not ready') {
    super(message);
    this.name = 'BasicMemoryUnavailableError';
  }
}

/** basic-memory answered with a non-2xx status. */
export class BasicMemoryRequestError extends Error {
  /**
   * @param {number} status - HTTP status of the answer.
   * @param {string} detail - basic-memory's reason, from its `detail` field when present.
   */
  constructor(status, detail) {
    super(`basic-memory answered ${status}: ${detail}`);
    this.name = 'BasicMemoryRequestError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @typedef {object} Project - a basic-memory project as its REST API lists it.
 * @property {number} id - internal id (cross-project search filters by it).
 * @property {string} external_id - id used in `/v2/projects/{external_id}/...` paths.
 * @property {string} name
 * @property {string} path - absolute root directory.
 * @property {boolean} is_default
 */

/**
 * @param {object} runtime - the managed runtime: `status()` and `onStatusChange(listener)`.
 */
export function createBasicMemoryClient(runtime) {
  const endpointOf = () => {
    const status = runtime.status();
    return status.state === 'ready' ? status.endpoint : undefined;
  };

  /**
   * @param {string} method
   * @param {string} path - absolute API path, e.g. `/v2/projects/`.
   * @param {{ query?: Record<string, string>, body?: unknown, signal?: AbortSignal }} [options]
   * @returns {Promise<any>} the parsed JSON answer.
   */
  function send(method, path, { query, body, signal } = {}) {
    const endpoint = endpointOf();
    if (endpoint === undefined) return Promise.reject(new BasicMemoryUnavailableError());
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: 'application/json' };
    if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': payload.byteLength });
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers, agent: loopbackAgent, signal, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const json = parseJson(text);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new BasicMemoryRequestError(res.statusCode, detailOf(json, text)));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`basic-memory did not answer ${method} ${path} within ${REQUEST_TIMEOUT_MS / 1000}s`)));
      req.on('error', (error) => reject(signal?.aborted ? signal.reason : new BasicMemoryUnavailableError(`basic-memory is unreachable: ${error.message}`)));
      req.end(payload);
    });
  }

  return {
    /**
     * Observe basic-memory becoming ready or ceasing to be (including a
     * restart on a new endpoint).
     * @param {() => void} listener
     * @returns {() => void} unsubscribes.
     */
    onAvailabilityChange(listener) {
      let current = endpointOf();
      return runtime.onStatusChange(() => {
        const next = endpointOf();
        if (next === current) return;
        current = next;
        listener();
      });
    },
    /**
     * @param {AbortSignal} [signal]
     * @returns {Promise<Project[]>}
     */
    async listProjects(signal) {
      return (await send('GET', '/v2/projects/', { signal })).projects;
    },
    /**
     * Register a project; basic-memory creates its directory when missing.
     * @param {string} name
     * @param {string} path - absolute root directory.
     * @returns {Promise<Project>}
     */
    async addProject(name, path) {
      return (await send('POST', '/v2/projects/', { body: { name, path, set_default: false } })).new_project;
    },
    /**
     * Unregister a project and drop its index; its files stay on disk.
     * @param {string} externalId
     */
    async removeProject(externalId) {
      await send('DELETE', `/v2/projects/${encodeURIComponent(externalId)}`, { query: { delete_notes: 'false' } });
    },
    /**
     * Schedule indexing of the files already in a project's directory and
     * return without waiting for it.
     * @param {string} externalId
     */
    async indexProject(externalId) {
      await send('POST', `/v2/projects/${encodeURIComponent(externalId)}/index`, { query: { run_in_background: 'true' } });
    },
  };
}

function parseJson(text) {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** FastAPI reports `{ detail: string | ValidationError[] }`. */
function detailOf(json, text) {
  const detail = json?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg ?? JSON.stringify(item)).join('; ');
  return text.slice(0, 500) || 'no detail';
}
