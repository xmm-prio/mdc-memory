/**
 * Generic JSON endpoint registration on the composition's web server. Every
 * endpoint passes the connection trust fence first, answers only its own
 * method, reads a bounded JSON body for POST, and maps failures to a JSON
 * `{ code, message, details? }` body (the web server itself answers a thrown
 * handler with an empty 400).
 */

const MAX_BODY_BYTES = 64 * 1024;

/** A failure with an explicit HTTP status, raised by endpoint handlers. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} code - stable machine-readable error code.
   * @param {string} message - human-readable reason.
   * @param {Record<string, unknown>} [details] - structured facts a client can show with the code.
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {object} Endpoint
 * @property {'GET' | 'POST'} method
 * @property {string} path - absolute pathname, no trailing slash.
 * @property {(body: unknown) => unknown | Promise<unknown>} handle - returns the JSON response body.
 */

/**
 * Pass every handler failure through `toHttpError`, so a module's own error
 * types become HTTP answers at the module's API boundary.
 * @param {(error: unknown) => unknown} toHttpError - returns the error to throw, an `HttpError` for known failures.
 * @param {readonly Endpoint[]} endpoints
 * @returns {Endpoint[]}
 */
export function mapErrors(toHttpError, endpoints) {
  return endpoints.map((endpoint) => ({
    ...endpoint,
    async handle(body) {
      try {
        return await endpoint.handle(body);
      } catch (error) {
        throw toHttpError(error);
      }
    },
  }));
}

/**
 * Register endpoints as exact routes owned by `web`'s plugin context.
 * @param {object} web - context carrying `webServer`, `connection` and `effect`.
 * @param {readonly Endpoint[]} endpoints
 */
export function registerEndpoints(web, endpoints) {
  for (const endpoint of endpoints) {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: endpoint.path,
      handler: (req, res) => serve(web.connection, endpoint, req, res),
    }), `mdc-memory: ${endpoint.method} ${endpoint.path}`);
  }
}

async function serve(connection, endpoint, req, res) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return;
  }
  if (req.method !== endpoint.method) {
    res.statusCode = 405;
    res.setHeader('allow', endpoint.method);
    res.end();
    return;
  }
  try {
    const body = endpoint.method === 'POST' ? await readJsonBody(req) : undefined;
    sendJson(res, 200, await endpoint.handle(body));
  } catch (error) {
    if (error instanceof HttpError) sendJson(res, error.status, { code: error.code, message: error.message, details: error.details });
    else sendJson(res, 500, { code: 'internal', message: error instanceof Error ? error.message : String(error) });
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const essence = String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase();
  if (essence !== 'application/json') throw new HttpError(415, 'unsupported-media-type', 'content-type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload-too-large', 'request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-request', 'request body must be valid JSON');
  }
}
