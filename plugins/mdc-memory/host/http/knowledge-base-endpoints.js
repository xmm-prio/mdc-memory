/** HTTP API of knowledge base management for the settings UI. */
import { BasicMemoryRequestError, BasicMemoryUnavailableError } from '../basic-memory/client.js';
import { KnowledgeBaseError } from '../knowledge-base/errors.js';
import { HttpError, mapErrors } from './router.js';

/** The settings view of a knowledge base; ids stay inside the Host. */
const view = ({ name, path, enabled }) => ({ name, path, enabled });

/**
 * @param {ReturnType<typeof import('../knowledge-base/index.js').createKnowledgeBases>} knowledgeBases
 * @returns {import('./router.js').Endpoint[]}
 */
export function knowledgeBaseEndpoints(knowledgeBases) {
  return mapErrors(toHttpError, [
    {
      method: 'GET',
      path: '/mdc-memory/kbs',
      async handle() {
        const [items, effective] = await Promise.all([knowledgeBases.list(), knowledgeBases.effective()]);
        return { items: items.map(view), effective: effective.map((knowledgeBase) => knowledgeBase.name) };
      },
    },
    { method: 'POST', path: '/mdc-memory/kbs/add', handle: async (body) => ({ item: view(await knowledgeBases.add(body)) }) },
    { method: 'POST', path: '/mdc-memory/kbs/delete', handle: async (body) => ({ item: view(await knowledgeBases.remove(body)) }) },
    { method: 'POST', path: '/mdc-memory/kbs/set-enabled', handle: async (body) => ({ item: view(await knowledgeBases.setEnabled(body)) }) },
  ]);
}

const STATUS_BY_KIND = Object.freeze({ invalid: 400, conflict: 409, missing: 404 });

function toHttpError(error) {
  if (error instanceof KnowledgeBaseError) return new HttpError(STATUS_BY_KIND[error.kind], error.code, error.message, error.details);
  if (error instanceof BasicMemoryUnavailableError) return new HttpError(503, 'unavailable', error.message);
  if (error instanceof BasicMemoryRequestError) return new HttpError(502, 'backend-error', error.message);
  return error;
}
