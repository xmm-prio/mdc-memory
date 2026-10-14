/**
 * Memory tools (ADR 0002): basic-memory's MCP tools offered to main agents as
 * native dsh tools, scoped to the effective knowledge bases, together with a
 * resident system prompt section that lists those knowledge bases. Agents are
 * offered both only while basic-memory is ready and at least one knowledge
 * base is effective; otherwise they are offered nothing.
 */
import { BasicMemoryUnavailableError } from '../basic-memory/client.js';
import { createCatalog } from './catalog.js';
import { renderMemorySection } from './prompt.js';
import { createTargetResolver } from './target.js';

const SECTION_NAME = 'mdc-memory';
/** After dsh's MCP server section (3100), before its tool SDK section (5000). */
const SECTION_ORDER = 3150;

/** What every main agent is offered: the tool definitions and the section text. */
const NOTHING = Object.freeze({ tools: Object.freeze([]), prompt: '' });

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
  const followers = new Set();
  let offer = NOTHING;
  let started = false;
  let refreshing = false;
  let stale = false;

  async function compute() {
    let effective;
    try {
      effective = await knowledgeBases.effective();
    } catch (error) {
      if (error instanceof BasicMemoryUnavailableError) return NOTHING;
      throw error;
    }
    if (effective.length === 0) return NOTHING;
    const tools = await catalog.load();
    return tools.length === 0 ? NOTHING : { tools, prompt: renderMemorySection(effective) };
  }

  function publish(next) {
    if (!started || (next.tools === offer.tools && next.prompt === offer.prompt)) return;
    offer = next;
    for (const follow of [...followers]) follow();
  }

  /** Recompute the offer; changes arriving meanwhile cause one more pass. */
  async function refresh() {
    stale = true;
    if (refreshing) return;
    refreshing = true;
    while (stale && started) {
      stale = false;
      publish(await compute().catch((error) => {
        logger.warn(`mdc-memory: memory tools are unavailable: ${error?.message ?? error}`);
        return NOTHING;
      }));
    }
    refreshing = false;
  }

  return {
    /**
     * Follow the effective knowledge bases until the returned function is called.
     * @returns {() => void} stops following and withdraws the offer.
     */
    start() {
      started = true;
      const off = knowledgeBases.onChange(() => { void refresh(); });
      void refresh();
      return () => {
        off();
        publish(NOTHING);
        started = false;
      };
    },
    /**
     * Keep one main agent's memory tools and prompt section in step with the
     * offer: registered on the agent's own context while there is something
     * to offer, withdrawn otherwise. A tool another registration already
     * claims in the agent's scope is skipped.
     * @param {object} agent - a main agent.
     * @returns {() => void} withdraws everything from the agent.
     */
    attach(agent) {
      const registered = [];
      let current;
      const withdraw = () => {
        for (const off of registered.splice(0).reverse()) off();
      };
      const follow = () => {
        if (current === offer.tools) return;
        withdraw();
        current = offer.tools;
        for (const tool of current) {
          try {
            registered.push(agent.ctx.tools.register(tool));
          } catch (error) {
            logger.warn(`mdc-memory: could not offer ${tool.name} to agent ${agent.id}: ${error?.message ?? error}`);
          }
        }
        if (registered.length === 0) return;
        registered.push(agent.ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: () => offer.prompt }));
      };
      follow();
      followers.add(follow);
      return () => {
        followers.delete(follow);
        withdraw();
      };
    },
  };
}
