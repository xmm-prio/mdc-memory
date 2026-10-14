/**
 * Client of the managed basic-memory server: its v2 REST API and its MCP
 * endpoint. The server answers MCP with plain JSON and keeps no session, so
 * every MCP request is one JSON-RPC POST without a handshake. Requests go to
 * the endpoint the runtime reports while it is ready; otherwise they fail
 * with `BasicMemoryUnavailableError` (fail-open callers decide what that means).
 */
import http from 'node:http';

const REQUEST_TIMEOUT_MS = 30_000;
/** A tool call may embed notes or load the embedding model on first use. */
const TOOL_CALL_TIMEOUT_MS = 120_000;
const MCP_PATH = '/mcp';
const MCP_ACCEPT = 'application/json, text/event-stream';
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

/** basic-memory answered an MCP request with a JSON-RPC error. */
export class BasicMemoryMcpError extends Error {
  /**
   * @param {number} code - JSON-RPC error code.
   * @param {string} detail - the error message basic-memory gave.
   */
  constructor(code, detail) {
    super(`basic-memory MCP error ${code}: ${detail}`);
    this.name = 'BasicMemoryMcpError';
    this.code = code;
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
 * @typedef {object} SearchResult - one search hit, a note (entity), observation or relation row.
 * @property {string} title
 * @property {'entity' | 'observation' | 'relation'} type
 * @property {number} score - relevance; its scale depends on the retrieval mode.
 * @property {string | null} permalink - for a note: `<project permalink>/<path>`, unique across projects.
 * @property {number} project_id - internal id of the project the hit belongs to.
 * @property {string | null} [relation_type] - for a relation.
 * @property {string | null} [to_entity] - for a relation: the target note's permalink, null until resolved.
 */

/**
 * @typedef {object} SearchResponse
 * @property {SearchResult[]} results - best first.
 * @property {boolean} has_more
 */

/**
 * @typedef {object} McpTool - a tool as basic-memory's MCP `tools/list` describes it.
 * @property {string} name
 * @property {string} [description]
 * @property {{ type: 'object', properties?: Record<string, object>, required?: string[] }} inputSchema
 * @property {{ readOnlyHint?: boolean }} [annotations]
 */

/**
 * @typedef {object} McpToolResult - the result of an MCP `tools/call`.
 * @property {object[]} content - MCP content blocks.
 * @property {unknown} [structuredContent]
 * @property {boolean} [isError] - the tool itself failed; `content` says why.
 */

/**
 * @param {object} runtime - the managed runtime: `status()` and `onStatusChange(listener)`.
 */
export function createBasicMemoryClient(runtime) {
  const endpointOf = () => {
    const status = runtime.status();
    return status.state === 'ready' ? status.endpoint : undefined;
  };
  let rpcId = 0;

  /**
   * @param {string} method
   * @param {string} path - absolute API path, e.g. `/v2/projects/`.
   * @param {{ query?: Record<string, string>, body?: unknown, accept?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<any>} the parsed JSON answer.
   */
  function send(method, path, { query, body, accept = 'application/json', timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
    const endpoint = endpointOf();
    if (endpoint === undefined) return Promise.reject(new BasicMemoryUnavailableError());
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept };
    if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': payload.byteLength });
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers, agent: loopbackAgent, signal, timeout: timeoutMs }, (res) => {
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
      req.on('timeout', () => req.destroy(new Error(`basic-memory did not answer ${method} ${path} within ${timeoutMs / 1000}s`)));
      req.on('error', (error) => reject(signal?.aborted ? signal.reason : new BasicMemoryUnavailableError(`basic-memory is unreachable: ${error.message}`)));
      req.end(payload);
    });
  }

  /**
   * One JSON-RPC request to the MCP endpoint.
   * @returns {Promise<any>} the `result` member of the answer.
   * @throws {BasicMemoryMcpError} when basic-memory answers with an `error` member.
   */
  async function rpc(method, params, { timeoutMs, signal } = {}) {
    const body = { jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) };
    const answer = await send('POST', MCP_PATH, { body, accept: MCP_ACCEPT, timeoutMs, signal });
    if (answer?.error) throw new BasicMemoryMcpError(answer.error.code, String(answer.error.message));
    return answer?.result;
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
    /**
     * Search several projects in one ranking. basic-memory serves search on
     * the HTTP method QUERY only.
     * @param {object} query - a basic-memory `ScopedSearchQuery`: `SearchQuery` fields (`text`,
     *   `retrieval_mode`, `min_similarity`, `note_types`, `entity_types`, `status`, `permalink_match`, ...)
     *   plus `project_ids`, the internal ids of the projects to search; an empty list finds nothing.
     * @param {{ page?: number, pageSize?: number, signal?: AbortSignal }} [options] - `pageSize` from 1 to 1000.
     * @returns {Promise<SearchResponse>}
     */
    async search(query, { page = 1, pageSize = 10, signal } = {}) {
      return send('QUERY', '/v2/search/', { query: { page: String(page), page_size: String(pageSize) }, body: query, signal });
    },
    /**
     * The project a name or permalink designates, as basic-memory itself
     * resolves the leading segment of a `memory://` URL.
     * @param {string} identifier
     * @param {AbortSignal} [signal]
     * @returns {Promise<Project | undefined>} undefined when no project matches.
     */
    async resolveProject(identifier, signal) {
      try {
        const resolved = await send('POST', '/v2/projects/resolve', { body: { identifier }, signal });
        return { id: resolved.project_id, external_id: resolved.external_id, name: resolved.name, path: resolved.path, is_default: resolved.is_default };
      } catch (error) {
        if (error instanceof BasicMemoryRequestError && error.status === 404) return undefined;
        throw error;
      }
    },
    /**
     * Every tool the MCP server offers.
     * @param {AbortSignal} [signal]
     * @returns {Promise<McpTool[]>}
     */
    async listTools(signal) {
      const tools = [];
      let cursor;
      do {
        const page = await rpc('tools/list', cursor === undefined ? undefined : { cursor }, { signal });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    /**
     * Call one MCP tool. A failure of the tool itself is a result with
     * `isError`, not a rejection.
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @param {AbortSignal} [signal]
     * @returns {Promise<McpToolResult>}
     */
    async callTool(name, args, signal) {
      return rpc('tools/call', { name, arguments: args }, { timeoutMs: TOOL_CALL_TIMEOUT_MS, signal });
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
