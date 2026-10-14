/**
 * Stand-in for dsh's agent plane as a Host row sees it: the `agents` registry
 * service, the agent lifecycle events, each agent's scoped context, agent-scoped
 * event dispatch (an agent's own listeners receive only events about it), the
 * `sessionProjections` registry, and the agent loop's pre-step. Agents carry a
 * live session log: a user message runs the `agent/pre-step` waterfall and the
 * messages that enter the step are committed as `user/message` events, as the
 * loop does, so session projections fold what was injected.
 *
 * What an agent can see comes from a scopes adapter: `memoryScopes()` keeps
 * registrations in memory under dsh's visibility rule (an agent sees global
 * registrations and its own, never those of the agent that delegated to it);
 * `realDsh().agentScopes` mounts dsh's own tool, system prompt and skill
 * services.
 *
 * An agent's context is minted the way dsh's AgentLoop mints it: it reaches
 * only the services AgentLoop declares (`AGENT_LOOP_INJECT`), reading any
 * other service throws as Cordis does, and another service is reached
 * through `agent.ctx.inject(names, callback)`, whose child context keeps the
 * agent's scope.
 *
 * Scopes adapter contract:
 *   services              - `{ tools, systemPrompt, skills? }` provided to the plugin context
 *   open(agent, options)  - mint the agent's scoped context: `{ ctx, dispose }`;
 *                           `options.parent` is the enclosing scope key
 *   schemas(agent)        - tool schemas the agent's model is offered
 *   prompt(agent)         - the agent's rendered system prompt
 *   call(agent, name, args) - run a tool call as the agent: `{ isError, text }`
 *   skills(agent)         - names of the skills the agent's model can discover
 *   skill(agent, name)    - the skill as the agent loads it (`name`, `description`, `content`), or undefined
 */
import { randomUUID } from 'node:crypto';

/** The services dsh's AgentLoop declares (`AgentLoop.inject`), the only ones its agents' contexts reach. */
export const AGENT_LOOP_INJECT = Object.freeze(['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']);

/** A context that, like a Cordis context, refuses to read a service it does not carry. */
function strictContext(members) {
  return new Proxy(members, {
    get(target, property) {
      if (typeof property === 'symbol' || property === 'then' || Object.hasOwn(target, property)) return target[property];
      throw new Error(`cannot get property "${property}" without inject`);
    },
  });
}

/** Normalize what an effect's execute returned (a disposer, maybe async, or nothing) into an idempotent disposer. */
export function disposerOf(result) {
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    const resolved = await result;
    if (typeof resolved === 'function') await resolved();
  };
}

/** @param {object} scopes - scopes adapter. */
export function createAgentPlane(scopes) {
  const live = new Map();
  const listeners = new Set();
  const projections = new Map();
  /** Subagents are composed under their preset's scope, not under the delegating agent. */
  const presetScope = {};

  /** `scope` undefined: a plugin-level listener, which receives the events about every agent. */
  const listen = (scope, name, listener) => {
    const entry = { scope, name, listener };
    listeners.add(entry);
    return () => listeners.delete(entry);
  };
  const listenersOf = (name, agent) => [...listeners]
    .filter((entry) => entry.name === name && (entry.scope === undefined || entry.scope === agent))
    .map((entry) => entry.listener);

  /** Serial dispatch: listeners run in registration order and are awaited. */
  async function emit(name, payload) {
    for (const listener of listenersOf(name, payload.agent)) await listener(payload);
  }

  /** Waterfall dispatch: each listener gets `next()` for the rest of the chain, `final` last. */
  function waterfall(name, payload, final) {
    const chain = listenersOf(name, payload.agent);
    const run = (index) => (index < chain.length ? chain[index](payload, () => run(index + 1)) : final());
    return run(0);
  }

  /** The agent's scoped context with agent-scoped `on` added; everything else is the scope's own. */
  const withEvents = (ctx, agent) => new Proxy(ctx, {
    get(target, property) {
      if (property === 'on') return (name, listener) => listen(agent, name, listener);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const agents = {
    roots: () => [...live.values()].filter((entry) => entry.owner === undefined).map((entry) => entry.agent),
    list: () => [...live.values()].map((entry) => entry.agent),
    get: (id) => [...live.values()].find((entry) => entry.agent.id === id)?.agent,
  };
  const sessionProjections = {
    register(definition) {
      projections.set(definition.key, definition);
      return () => projections.delete(definition.key);
    },
    stateOf(session, key) {
      const definition = projections.get(key);
      if (definition === undefined) return undefined;
      return session.events.reduce((state, event) => definition.apply(state, event), definition.init(session.header, 0));
    },
  };

  return {
    services: { agents, sessionProjections, ...scopes.services },
    /** Plugin-level listener registration; returns the unsubscribe. */
    on: (name, listener) => listen(undefined, name, listener),
    waterfall,
    /**
     * Create and announce an agent. With `parent` it is a subagent delegated
     * by that agent, whose session records `origin: 'subagent'`.
     * @param {{ parent?: object, origin?: 'subagent' }} [options]
     */
    async create({ parent, origin = parent ? 'subagent' : undefined } = {}) {
      const id = randomUUID();
      const agent = { id, session: { id, header: { id, ...(origin ? { origin } : {}) }, events: [] } };
      const scope = scopes.open(agent, parent ? { parent: presetScope } : {});
      agent.ctx = withEvents(scope.ctx, agent);
      live.set(agent, { agent, owner: parent, scope });
      await emit('agent/created', { agent, source: { kind: 'new' } });
      return agent;
    },
    /** Unwind the agent's scoped registrations and listeners, then announce its disposal. */
    async dispose(agent) {
      const entry = live.get(agent);
      live.delete(agent);
      await entry.scope.dispose();
      for (const listener of [...listeners]) if (listener.scope === agent) listeners.delete(listener);
      await emit('agent/disposed', { agent });
    },
    /**
     * One user message through the pre-step, committing what enters the step.
     * @returns {Promise<object[]>} the messages that entered the step; empty when it was rejected.
     */
    async sendUserMessage(agent, text) {
      const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
      const turn = agent.session.events.filter((event) => event.type === 'turn/start').length + 1;
      agent.session.events.push({ type: 'turn/start', data: { turn } });
      const payload = { agent, messages: [message], turn, step: 1, signal: new AbortController().signal };
      const decision = await waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [message] }));
      if (decision.kind !== 'enter') return [];
      for (const entered of decision.messages) agent.session.events.push({ type: 'user/message', data: entered });
      return decision.messages;
    },
    /** @returns {Promise<string[]>} names of the tools the agent's model is offered. */
    async toolNames(agent) {
      return (await scopes.schemas(agent)).map((schema) => schema.name).sort();
    },
    /** @returns {Promise<object | undefined>} the schema of one tool as the agent's model sees it. */
    async schema(agent, name) {
      return (await scopes.schemas(agent)).find((schema) => schema.name === name);
    },
    prompt: (agent) => scopes.prompt(agent),
    call: (agent, name, args) => scopes.call(agent, name, args),
    /** @returns {Promise<string[]>} names of the skills the agent's model can discover. */
    async skillNames(agent) {
      return (await scopes.skills(agent)).sort();
    },
    /** @returns {Promise<object | undefined>} the skill as the agent loads it. */
    loadSkill: (agent, name) => scopes.skill(agent, name),
  };
}

/**
 * Scopes adapter keeping registrations in memory.
 * @param {{ skills?: boolean }} [options] - `skills: false` composes no skill registry.
 */
export function memoryScopes({ skills = true } = {}) {
  const layers = new Map();
  const layerOf = (key) => {
    if (!layers.has(key)) layers.set(key, { tools: new Map(), sections: new Map(), skills: new Map() });
    return layers.get(key);
  };
  const visible = (agent, kind) => [...layerOf(undefined)[kind].values(), ...layerOf(agent)[kind].values()];

  function services(key, own) {
    const add = (kind, item) => {
      const entries = layerOf(key)[kind];
      if (entries.has(item.name)) throw new Error(`duplicate ${kind} registration ${item.name}`);
      entries.set(item.name, item);
      const off = () => { if (entries.get(item.name) === item) entries.delete(item.name); };
      own?.add(off);
      return off;
    };
    return {
      tools: { register: (definition) => add('tools', definition) },
      systemPrompt: { section: (section) => add('sections', section) },
      ...(skills ? { skills: { register: (skill) => add('skills', skill) } } : {}),
    };
  }

  return {
    services: services(undefined),
    open(agent) {
      const disposers = new Set();
      const own = services(agent, disposers);
      const ctx = strictContext({
        ...Object.fromEntries(AGENT_LOOP_INJECT.filter((name) => name in own).map((name) => [name, own[name]])),
        /** Like Cordis: the callback runs once every named service exists, on a child context in the agent's scope. */
        inject(names, callback) {
          const registrations = new Set();
          const available = services(agent, registrations);
          const fiber = {
            async dispose() {
              disposers.delete(fiber.dispose);
              for (const off of [...registrations].reverse()) off();
              registrations.clear();
            },
          };
          disposers.add(fiber.dispose);
          if (names.every((name) => name in available)) {
            callback(strictContext(Object.fromEntries(names.map((name) => [name, available[name]]))));
          }
          return fiber;
        },
        effect(execute) {
          let done = false;
          const cleanup = execute();
          const dispose = () => {
            if (done) return undefined;
            done = true;
            disposers.delete(dispose);
            return typeof cleanup === 'function' ? cleanup() : undefined;
          };
          disposers.add(dispose);
          return dispose;
        },
      });
      return {
        ctx,
        async dispose() {
          for (const dispose of [...disposers].reverse()) await dispose();
        },
      };
    },
    async schemas(agent) {
      return visible(agent, 'tools').map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
    async prompt(agent) {
      return visible(agent, 'sections')
        .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
        .map((section) => (typeof section.text === 'function' ? section.text({ scope: agent }) : section.text))
        .filter((text) => text !== '')
        .join('\n\n');
    },
    async call(agent, name, args) {
      const definition = layerOf(agent).tools.get(name) ?? layerOf(undefined).tools.get(name);
      if (!definition) return { isError: true, text: `Error: unknown tool "${name}"` };
      try {
        const value = await definition.execute(Object.freeze({ ...args }), { callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal });
        return { isError: false, text: definition.output.render(args, value).map((block) => block.text).join('\n') };
      } catch (error) {
        return { isError: true, text: `Error: ${error.message}` };
      }
    },
    async skills(agent) {
      return visible(agent, 'skills').map((skill) => skill.name);
    },
    async skill(agent, name) {
      return visible(agent, 'skills').find((skill) => skill.name === name);
    },
  };
}
