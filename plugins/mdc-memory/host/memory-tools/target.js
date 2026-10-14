/**
 * The knowledge base a memory tool call works in. It is decided on every call
 * from the effective knowledge bases (生效知识库), so turning a knowledge base
 * on or off applies to the very next call of every running session.
 */
import { MemoryToolError } from './errors.js';

const MEMORY_URL = 'memory://';

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../knowledge-base/index.js').createKnowledgeBases>} deps.knowledgeBases
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 */
export function createTargetResolver({ knowledgeBases, basicMemory }) {
  /**
   * The requested knowledge base, or the only effective one when none is
   * requested. Names compare regardless of case, as basic-memory's do.
   */
  async function choose(requested, effective, signal) {
    if (effective.length === 0) throw new MemoryToolError('no-knowledge-base', 'No knowledge base is enabled, so memory is unavailable.');
    const enabled = effective.map((knowledgeBase) => knowledgeBase.name).join(', ');
    if (requested === undefined || requested === null || requested === '') {
      if (effective.length === 1) return effective[0];
      throw new MemoryToolError('project-required', `Several knowledge bases are enabled; pass "project" as one of: ${enabled}.`);
    }
    const name = String(requested);
    const sameName = (knowledgeBase) => knowledgeBase.name.toLowerCase() === name.toLowerCase();
    const chosen = effective.find(sameName);
    if (chosen) return chosen;
    if ((await knowledgeBases.list(signal)).some(sameName)) {
      throw new MemoryToolError('not-enabled', `Knowledge base "${name}" is turned off; enabled knowledge bases: ${enabled}.`);
    }
    throw new MemoryToolError('unknown-knowledge-base', `There is no knowledge base named "${name}"; enabled knowledge bases: ${enabled}.`);
  }

  /**
   * basic-memory routes a `memory://<project>/...` URL into the project its
   * leading segment names, so such a URL must name the chosen knowledge base.
   */
  async function assertUrlsInside(target, args, effective, signal) {
    for (const value of Object.values(args)) {
      const prefix = projectPrefixOf(value);
      if (prefix === undefined) continue;
      const project = await basicMemory.resolveProject(prefix, signal);
      if (project === undefined || project.external_id === target.externalId) continue;
      const other = effective.find((knowledgeBase) => knowledgeBase.externalId === project.external_id);
      throw new MemoryToolError('outside-knowledge-base', other
        ? `${value} is in knowledge base "${other.name}"; pass "project": "${other.name}" to use it.`
        : `${value} points outside the enabled knowledge bases.`);
    }
  }

  return {
    /**
     * @param {Record<string, unknown>} args - the call's arguments; `project` names the knowledge base.
     * @param {AbortSignal} [signal]
     * @returns {Promise<import('../knowledge-base/index.js').KnowledgeBase>}
     * @throws {MemoryToolError} when the call cannot work in exactly one effective knowledge base.
     * @throws {import('../basic-memory/client.js').BasicMemoryUnavailableError} while basic-memory is not ready.
     */
    async resolve(args, signal) {
      const effective = await knowledgeBases.effective(signal);
      const target = await choose(args.project, effective, signal);
      await assertUrlsInside(target, args, effective, signal);
      return target;
    },
  };
}

/**
 * The leading segment basic-memory may read as a project name in a memory
 * URL, split the way its `split_project_prefix` does (`project::note` is
 * spelled `project/note`).
 * @returns {string | undefined}
 */
function projectPrefixOf(value) {
  if (typeof value !== 'string' || !value.trim().startsWith(MEMORY_URL)) return undefined;
  const raw = value.trim().slice(MEMORY_URL.length);
  const separator = raw.indexOf('::');
  const path = separator === -1 ? raw : `${raw.slice(0, separator)}/${raw.slice(separator + 2).replace(/^\/+/, '')}`;
  const slash = path.indexOf('/');
  if (slash <= 0 || slash === path.length - 1) return undefined;
  const prefix = path.slice(0, slash);
  return prefix.includes('*') ? undefined : prefix;
}
