/**
 * The memory tools on offer: the whitelisted basic-memory MCP tools that work
 * inside one project, read from the MCP server's own tool list. A tool
 * basic-memory adds upstream is offered by naming it in the whitelist.
 */
import { createProxyTool, isProjectScoped } from './proxy-tool.js';

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 * @param {readonly string[]} deps.whitelist - upstream tool names, in the order they are offered.
 * @param {ReturnType<typeof import('./target.js').createTargetResolver>} deps.target
 * @param {object} deps.logger - the plugin logger.
 */
export function createCatalog({ basicMemory, whitelist, target, logger }) {
  let signature;
  let tools = Object.freeze([]);

  function report(upstream) {
    for (const name of whitelist) {
      const tool = upstream.get(name);
      if (tool === undefined) logger.warn(`mdc-memory: basic-memory offers no tool named ${name}; it is not offered to agents`);
      else if (!isProjectScoped(tool)) logger.warn(`mdc-memory: basic-memory tool ${name} does not work inside one project; it is not offered to agents`);
    }
  }

  return {
    /**
     * Read the upstream tool list and return the dsh tool definitions. While
     * the upstream tools stay the same, the same frozen array is returned, so
     * a change is visible by identity.
     * @param {AbortSignal} [signal]
     * @returns {Promise<readonly object[]>}
     */
    async load(signal) {
      const upstream = new Map((await basicMemory.listTools(signal)).map((tool) => [tool.name, tool]));
      const offered = whitelist.map((name) => upstream.get(name)).filter((tool) => tool !== undefined && isProjectScoped(tool));
      const next = JSON.stringify(offered);
      if (next === signature) return tools;
      signature = next;
      report(upstream);
      tools = Object.freeze(offered.map((tool) => createProxyTool(tool, { target, basicMemory })));
      return tools;
    },
  };
}
