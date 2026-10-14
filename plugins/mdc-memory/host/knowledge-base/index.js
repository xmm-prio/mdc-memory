/**
 * Knowledge bases (知识库): basic-memory projects as the user manages them.
 * Names and paths come only from basic-memory's own project configuration;
 * enablement comes from the dsh plugin storage. basic-memory's default
 * project is reserved for internal use and never listed.
 */
import { BasicMemoryRequestError } from '../basic-memory/client.js';
import { KnowledgeBaseError } from './errors.js';
import { seedLessonSchema } from './lesson-schema.js';
import { assertRegistrable, parseRegistration } from './validation.js';

/**
 * @typedef {object} KnowledgeBase
 * @property {string} name
 * @property {string} path - absolute root directory, as basic-memory reports it.
 * @property {boolean} enabled
 * @property {number} projectId - basic-memory internal project id (cross-project search filters by it).
 * @property {string} externalId - basic-memory project id used in `/v2/projects/{externalId}/...`.
 */

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 * @param {ReturnType<typeof import('./enablement.js').createEnablement>} deps.enablement
 * @param {object} deps.logger - the plugin logger.
 */
export function createKnowledgeBases({ basicMemory, enablement, logger }) {
  const listeners = new Set();

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        logger.warn(`mdc-memory: knowledge base change listener failed: ${error?.stack ?? error}`);
      }
    }
  };

  /**
   * Every knowledge base, read live from basic-memory.
   * @param {AbortSignal} [signal]
   * @returns {Promise<KnowledgeBase[]>}
   * @throws {import('../basic-memory/client.js').BasicMemoryUnavailableError} while basic-memory is not ready.
   */
  async function list(signal) {
    const [projects, isEnabled] = await Promise.all([basicMemory.listProjects(signal), enablement.reader()]);
    return projects.filter((project) => !project.is_default).map((project) => knowledgeBaseOf(project, isEnabled(project.name)));
  }

  /** @throws {KnowledgeBaseError} invalid-request | not-found */
  async function find(name) {
    if (typeof name !== 'string' || name === '') throw new KnowledgeBaseError('invalid-request', 'name must be a non-empty string');
    const knowledgeBase = (await list()).find((candidate) => candidate.name === name);
    if (!knowledgeBase) throw new KnowledgeBaseError('not-found', `no knowledge base named ${name}`, { knowledgeBase: name });
    return knowledgeBase;
  }

  /**
   * Make a just-registered project usable: index the files already in its
   * directory, seed the lesson schema note unless the index has one and index
   * that too, then enable it. A failure unregisters the project again so an
   * add either fully happens or leaves nothing behind (files stay on disk).
   */
  async function provision(project, root) {
    try {
      await basicMemory.indexProject(project.external_id);
      if (await seedLessonSchema(basicMemory, project.external_id, root)) await basicMemory.indexProject(project.external_id);
      await enablement.set(project.name, true);
    } catch (error) {
      await basicMemory.removeProject(project.external_id).catch((rollback) => {
        logger.warn(`mdc-memory: could not unregister half-added knowledge base ${project.name}: ${rollback.message}`);
      });
      throw error;
    }
  }

  return {
    list,
    /**
     * Register a new knowledge base: basic-memory creates a missing directory
     * and indexes the files in it, the lesson schema note is seeded unless the
     * index already has one, and the knowledge base starts enabled.
     * @param {{ name: string, path: string }} input
     * @returns {Promise<KnowledgeBase>}
     * @throws {KnowledgeBaseError} on input, name or path conflicts, or when basic-memory refuses.
     */
    async add(input) {
      const registration = parseRegistration(input);
      assertRegistrable(registration, await basicMemory.listProjects());
      const project = await basicMemory.addProject(registration.name, registration.path).catch(asRejection);
      await provision(project, registration.path);
      changed();
      return knowledgeBaseOf(project, true);
    },
    /**
     * Unregister a knowledge base from basic-memory, which drops its index,
     * and forget its enablement. Files on disk are kept.
     * @param {{ name: string }} input
     * @returns {Promise<KnowledgeBase>} the knowledge base as it was.
     */
    async remove(input) {
      const knowledgeBase = await find(input?.name);
      await basicMemory.removeProject(knowledgeBase.externalId);
      await enablement.forget(knowledgeBase.name);
      changed();
      return knowledgeBase;
    },
    /**
     * Turn a knowledge base on or off for every workspace and session.
     * @param {{ name: string, enabled: boolean }} input
     * @returns {Promise<KnowledgeBase>}
     */
    async setEnabled(input) {
      if (typeof input?.enabled !== 'boolean') throw new KnowledgeBaseError('invalid-request', 'enabled must be a boolean');
      const knowledgeBase = await find(input.name);
      await enablement.set(knowledgeBase.name, input.enabled);
      changed();
      return Object.freeze({ ...knowledgeBase, enabled: input.enabled });
    },
    /**
     * The effective knowledge bases (生效知识库): every enabled one, computed
     * live on each call so a toggle applies to the very next use.
     * @param {AbortSignal} [signal]
     * @returns {Promise<KnowledgeBase[]>}
     * @throws {import('../basic-memory/client.js').BasicMemoryUnavailableError} while basic-memory is not ready.
     */
    async effective(signal) {
      return (await list(signal)).filter((knowledgeBase) => knowledgeBase.enabled);
    },
    /**
     * Observe changes that may alter the effective set: a knowledge base was
     * added, removed or toggled, or basic-memory became ready or stopped
     * being ready. The listener re-reads `effective()` itself.
     * @param {() => void} listener
     * @returns {() => void} unsubscribes.
     */
    onChange(listener) {
      listeners.add(listener);
      const offAvailability = basicMemory.onAvailabilityChange(listener);
      return () => {
        listeners.delete(listener);
        offAvailability();
      };
    },
  };
}

/** basic-memory refuses with 400 for reasons the user can fix (e.g. a permalink twin of an existing name). */
function asRejection(error) {
  if (error instanceof BasicMemoryRequestError && error.status === 400) throw new KnowledgeBaseError('rejected', error.detail);
  throw error;
}

/** @returns {KnowledgeBase} */
function knowledgeBaseOf(project, enabled) {
  return Object.freeze({
    name: project.name,
    path: project.path,
    enabled,
    projectId: project.id,
    externalId: project.external_id,
  });
}
