/**
 * Memory tools (ADR 0002): basic-memory's MCP tools offered to main agents as
 * native dsh tools, scoped to the effective knowledge bases, together with
 * what tells agents how to use them: a resident system prompt section that
 * lists those knowledge bases, and the bundled `lesson` skill. Agents are
 * offered all of it only while basic-memory is ready and at least one
 * knowledge base is effective; otherwise they are offered nothing.
 */
import { BasicMemoryUnavailableError } from '../basic-memory/client.js';
import { createCatalog } from './catalog.js';
import { loadLessonSkill } from './lesson-skill.js';
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
  const lessonSkill = loadLessonSkill();
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
    return tools.length === 0 ? NOTHING : { tools, prompt: renderMemorySection(effective, lessonSkill) };
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
     * Keep one main agent's memory tools, prompt section and lesson skill in
     * step with the offer: registered in the agent's own scope while there
     * is something to offer, withdrawn otherwise. A tool another registration
     * already claims in the agent's scope is skipped. Any other failure stays
     * with this agent: it is logged, the agent is offered nothing, and the
     * next change of the offer tries again; other agents are unaffected.
     * @param {object} agent - a main agent.
     * @returns {() => void} withdraws everything from the agent.
     */
    attach(agent) {
      const registered = [];
      let current;
      const withdraw = () => {
        for (const off of registered.splice(0).reverse()) off();
      };
      const register = (tools) => {
        for (const tool of tools) {
          try {
            registered.push(agent.ctx.tools.register(tool));
          } catch (error) {
            logger.warn(`mdc-memory: could not offer ${tool.name} to agent ${agent.id}: ${error?.message ?? error}`);
          }
        }
        if (registered.length === 0) return;
        registered.push(agent.ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: () => offer.prompt }));
        registered.push(registerSkill(agent, lessonSkill));
      };
      const follow = () => {
        if (current === offer.tools) return;
        current = offer.tools;
        try {
          withdraw();
          register(current);
        } catch (error) {
          current = undefined;
          withdraw();
          logger.warn(`mdc-memory: could not offer memory to agent ${agent.id}; it is offered nothing until the offer changes: ${error?.stack ?? error}`);
        }
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

/**
 * Register a skill in the agent's own scope. An agent's context reaches only
 * the services its agent loop declares, and the skill registry is not one of
 * them, so the skill is registered from a child context that declares it; the
 * child keeps the agent's scope. Without a skill registry nothing is registered.
 * @returns {() => void} withdraws the skill.
 */
function registerSkill(agent, skill) {
  const fiber = agent.ctx.inject(['skills'], (scoped) => {
    scoped.skills.register(skill);
  });
  return () => fiber.dispose();
}
