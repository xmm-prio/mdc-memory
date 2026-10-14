/**
 * The memory offer: what main agents are given for long-term memory. While
 * basic-memory is ready, at least one knowledge base is effective and the
 * memory tool catalog is not empty, every main agent is offered the memory
 * tools and their companion contributions (the Memory prompt section, the
 * lesson skill); otherwise it is offered nothing.
 *
 * The flow has two steps: compute the offer from the effective knowledge
 * bases and the tool catalog, then attach it to each main agent by running
 * the contributions as stages, in order, in the agent's own scope. An agent
 * gets all of the contributions or none of them.
 */
import { BasicMemoryUnavailableError } from '../basic-memory/client.js';

/**
 * @typedef {object} Offer
 * @property {readonly import('../knowledge-base/index.js').KnowledgeBase[]} knowledgeBases - the effective knowledge bases.
 * @property {readonly object[]} tools - the memory tool definitions; empty when nothing is offered.
 */

/**
 * @typedef {object} Contribution - one stage of attaching the offer to an agent.
 * @property {(agent: object, current: () => Offer) => () => void} register - register in the agent's own scope and
 *   return the withdrawal. `current` reads the live offer, which may change without registering again while its
 *   tools stay the same. A throw fails the whole attachment.
 */

/** @type {Offer} */
const NOTHING = Object.freeze({ knowledgeBases: Object.freeze([]), tools: Object.freeze([]) });

const sameOffer = (a, b) => a.tools === b.tools
  && a.knowledgeBases.length === b.knowledgeBases.length
  && a.knowledgeBases.every((knowledgeBase, index) => knowledgeBase.name === b.knowledgeBases[index].name);

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../knowledge-base/index.js').createKnowledgeBases>} deps.knowledgeBases
 * @param {() => Promise<readonly object[]>} deps.loadTools - the memory tool definitions; the same array while they stay the same.
 * @param {readonly Contribution[]} deps.contributions - registered in this order.
 * @param {object} deps.logger - the plugin logger.
 */
export function createMemoryOffer({ knowledgeBases, loadTools, contributions, logger }) {
  const followers = new Set();
  let offer = NOTHING;
  let started = false;
  let refreshing = false;
  let stale = false;
  const current = () => offer;

  async function compute() {
    let effective;
    try {
      effective = await knowledgeBases.effective();
    } catch (error) {
      if (error instanceof BasicMemoryUnavailableError) return NOTHING;
      throw error;
    }
    if (effective.length === 0) return NOTHING;
    const tools = await loadTools();
    return tools.length === 0 ? NOTHING : Object.freeze({ knowledgeBases: effective, tools });
  }

  function publish(next) {
    if (!started || sameOffer(next, offer)) return;
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
        logger.warn(`mdc-memory: memory is unavailable to agents: ${error?.message ?? error}`);
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
     * Keep one main agent in step with the offer: every contribution is
     * registered while there is an offer, and withdrawn otherwise. They are
     * registered again only when the offered tools change. A failing
     * contribution stays with this agent: it is logged, the agent is offered
     * nothing, and the next change of the offer tries again; other agents are
     * unaffected.
     * @param {object} agent - a main agent.
     * @returns {() => void} withdraws everything from the agent.
     */
    attach(agent) {
      const registered = [];
      let attachedTools;
      const withdraw = () => {
        for (const off of registered.splice(0).reverse()) off();
      };
      const follow = () => {
        if (attachedTools === offer.tools) return;
        attachedTools = offer.tools;
        try {
          withdraw();
          if (offer.tools.length > 0) {
            for (const contribution of contributions) registered.push(contribution.register(agent, current));
          }
        } catch (error) {
          attachedTools = undefined;
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
