/**
 * Memory tools (ADR 0002): basic-memory's MCP tools offered to main agents as
 * native dsh tools, scoped to the effective knowledge bases. The catalog says
 * which tools are on offer; as a contribution to the memory offer, they are
 * registered in an agent's own scope.
 */
import { createCatalog } from './catalog.js';
import { createTargetResolver } from './target.js';

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 * @param {ReturnType<typeof import('../knowledge-base/index.js').createKnowledgeBases>} deps.knowledgeBases
 * @param {readonly string[]} deps.whitelist - upstream tool names offered to agents.
 * @param {object} deps.logger - the plugin logger.
 */
export function createMemoryTools({ basicMemory, knowledgeBases, whitelist, logger }) {
  const target = createTargetResolver({ knowledgeBases, basicMemory });
  const catalog = createCatalog({ basicMemory, whitelist, target, logger });

  return {
    /**
     * The tool definitions on offer, read from basic-memory's tool list.
     * @returns {Promise<readonly object[]>} the same array while the upstream tools stay the same.
     */
    load: () => catalog.load(),
    /**
     * Register the offered tools in the agent's own scope. A tool another
     * registration already claims there is skipped with a warning; when no
     * tool can be registered, the contribution fails.
     * @type {import('../memory-offer/index.js').Contribution['register']}
     */
    register(agent, current) {
      const registered = [];
      for (const tool of current().tools) {
        try {
          registered.push(agent.ctx.tools.register(tool));
        } catch (error) {
          logger.warn(`mdc-memory: could not offer ${tool.name} to agent ${agent.id}: ${error?.message ?? error}`);
        }
      }
      if (registered.length === 0) throw new Error('every memory tool is already claimed in the agent scope');
      return () => {
        for (const off of registered.reverse()) off();
      };
    },
  };
}
