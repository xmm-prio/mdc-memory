/**
 * User-message recall (召回): when the user sends a message to a main agent,
 * the current lessons of the effective knowledge bases that relate to it
 * enter the same step right after it, each lesson at most once per session.
 * Settings are read per message. Fail-open: when basic-memory is not ready or
 * recall fails or takes too long, the message goes on alone.
 */
import { watchMainAgents } from '../agents/main-agents.js';
import { BasicMemoryUnavailableError } from '../basic-memory/client.js';
import { INJECTED_LESSONS, recallMessage } from './injection.js';
import { findLessons } from './lessons.js';

/** Recall holds up the user's turn, so it gets a bounded budget. */
const RECALL_TIMEOUT_MS = 10_000;
/** Only the start of a long message (a pasted log, say) is searched. */
const MAX_QUERY_CHARS = 2000;

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 * @param {ReturnType<typeof import('../knowledge-base/index.js').createKnowledgeBases>} deps.knowledgeBases
 * @param {ReturnType<typeof import('./settings.js').createRecallSettings>} deps.settings
 * @param {object} deps.logger - the plugin logger.
 */
export function createRecall({ basicMemory, knowledgeBases, settings, logger }) {
  async function lessonsFor(text, injected, signal) {
    const { onUserMessage, minSimilarity, maxLessons } = await settings.current();
    if (!onUserMessage) return [];
    const effective = await knowledgeBases.effective(signal);
    return findLessons(basicMemory, { text, knowledgeBases: effective, minSimilarity, limit: maxLessons, exclude: injected, signal });
  }

  return {
    /**
     * Recall for every main agent of the composition.
     * @param {object} plane - plugin context carrying the dsh `agents` and `sessionProjections` services.
     */
    mount(plane) {
      plane.sessionProjections.register(INJECTED_LESSONS);
      const injectedIn = (session) => new Set(plane.sessionProjections.stateOf(session, INJECTED_LESSONS.key)?.lessons ?? []);

      watchMainAgents(plane, (agent) => agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
        const decision = await next();
        if (decision.kind !== 'enter') return decision;
        const text = userText(decision.messages);
        if (text === '') return decision;
        try {
          const budget = AbortSignal.any([signal, AbortSignal.timeout(RECALL_TIMEOUT_MS)]);
          const lessons = await lessonsFor(text, injectedIn(agent.session), budget);
          if (lessons.length === 0) return decision;
          return { ...decision, messages: [...decision.messages, recallMessage(lessons)] };
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof BasicMemoryUnavailableError) logger.debug(`mdc-memory: no recall: ${error.message}`);
          else logger.warn(`mdc-memory: recall failed; the message goes on without lessons: ${error?.message ?? error}`);
          return decision;
        }
      }));
    },
  };
}

/** The text the user typed into the step's messages. */
function userText(messages) {
  return messages
    .filter((message) => message.source?.kind === 'user')
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}
