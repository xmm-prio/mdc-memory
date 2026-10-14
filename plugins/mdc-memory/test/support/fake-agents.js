/**
 * Stand-in for dsh's agent plane: the `agents` registry, agent-scoped event
 * dispatch, the `sessionProjections` registry and the agent loop's pre-step.
 * Agents carry a live session log; a user turn runs the `agent/pre-step`
 * waterfall and commits the messages that enter the step as `user/message`
 * events, as the loop does, so session projections fold what was injected.
 */
import { randomUUID } from 'node:crypto';

/** Normalize what an effect's execute returned into an idempotent disposer. */
export function disposerOf(result) {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    const resolved = await result;
    if (typeof resolved === 'function') await resolved();
  };
}

export function createFakeAgentPlane() {
  const listeners = new Set();
  const live = [];
  const projections = new Map();

  /** Register a listener; agent-scoped ones receive only events about their agent. */
  const listen = (scope, name, listener) => {
    const entry = { scope, name, listener };
    listeners.add(entry);
    return () => listeners.delete(entry);
  };
  const listenersOf = (name, agent) => [...listeners]
    .filter((entry) => entry.name === name && (entry.scope === undefined || entry.scope === agent))
    .map((entry) => entry.listener);

  /** The agent's own scope: registrations unwind when the agent is disposed. */
  function scopeOf(agent) {
    const disposers = [];
    const ctx = {
      on(name, listener) {
        const off = disposerOf(listen(agent, name, listener));
        disposers.push(off);
        return off;
      },
      effect(execute) {
        const dispose = disposerOf(execute());
        disposers.push(dispose);
        return dispose;
      },
    };
    return { ctx, unwind: async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); } };
  }

  /** Run a waterfall event: each listener gets `next()` for the rest of the chain, `final` last. */
  function waterfall(name, payload, final) {
    const chain = listenersOf(name, payload.agent);
    const run = (index) => (index < chain.length ? chain[index](payload, () => run(index + 1)) : final());
    return run(0);
  }

  const plane = {
    services: {
      agents: {
        list: () => live.map((entry) => entry.agent),
        roots: () => live.filter((entry) => entry.owner === undefined).map((entry) => entry.agent),
        get: (id) => live.find((entry) => entry.agent.id === id)?.agent,
      },
      sessionProjections: {
        register(definition) {
          projections.set(definition.key, definition);
          return () => projections.delete(definition.key);
        },
        stateOf(session, key) {
          const definition = projections.get(key);
          if (definition === undefined) return undefined;
          return session.events.reduce((state, event) => definition.apply(state, event), definition.init(session.header, 0));
        },
      },
    },
    /** Plugin-level (unscoped) listener registration. */
    on: (name, listener) => listen(undefined, name, listener),
    waterfall,
    /**
     * Create and announce an agent, awaiting the serial `agent/created` listeners.
     * @param {{ owner?: object, origin?: string }} [options] - `owner` makes it a subagent created
     *   through that agent's context; `origin` is its session header's durable origin mark.
     */
    async create({ owner, origin } = {}) {
      const id = randomUUID();
      const agent = { id, session: { id, header: { id, ...(origin ? { origin } : {}) }, events: [] } };
      const scope = scopeOf(agent);
      agent.ctx = scope.ctx;
      live.push({ agent, owner, scope });
      for (const listener of listenersOf('agent/created', agent)) await listener({ agent, source: 'startup' });
      return agent;
    },
    /** Unwind the agent's scope, unregister it and emit `agent/disposed`. */
    async dispose(agent) {
      const at = live.findIndex((entry) => entry.agent === agent);
      const [entry] = live.splice(at, 1);
      await entry.scope.unwind();
      for (const listener of listenersOf('agent/disposed', agent)) listener({ agent });
    },
    /**
     * One user message through the pre-step, committing what enters the step.
     * @returns {Promise<object[]>} the messages that entered the step (empty when rejected).
     */
    async sendUserMessage(agent, text, { signal = new AbortController().signal } = {}) {
      const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
      const turn = agent.session.events.filter((event) => event.type === 'turn/start').length + 1;
      agent.session.events.push({ type: 'turn/start', data: { turn } });
      const decision = await waterfall('agent/pre-step', { agent, messages: [message], turn, step: 1, signal }, async () => ({ kind: 'enter', messages: [message] }));
      if (decision.kind !== 'enter') return [];
      for (const entered of decision.messages) agent.session.events.push({ type: 'user/message', data: entered });
      return decision.messages;
    },
  };
  return plane;
}
