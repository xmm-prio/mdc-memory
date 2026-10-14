/**
 * Stand-in for dsh's agent plane as a Host row sees it: the `agents` registry
 * service, the agent lifecycle events, and each agent's scoped context. What
 * an agent can see comes from a scopes adapter: `memoryScopes()` keeps
 * registrations in memory under dsh's visibility rule (an agent sees global
 * registrations and its own, never those of the agent that delegated to it);
 * `realDsh().agentScopes` mounts dsh's own tool, system prompt and skill
 * services.
 *
 * Scopes adapter contract:
 *   services              - `{ tools, systemPrompt, skills }` provided to the plugin context
 *   open(agent, options)  - mint the agent's scoped context: `{ ctx, dispose }`;
 *                           `options.parent` is the enclosing scope key
 *   schemas(agent)        - tool schemas the agent's model is offered
 *   prompt(agent)         - the agent's rendered system prompt
 *   call(agent, name, args) - run a tool call as the agent: `{ isError, text }`
 *   skills(agent)         - names of the skills the agent's model can discover
 *   skill(agent, name)    - the skill as the agent loads it (`name`, `description`, `content`), or undefined
 */
import { randomUUID } from 'node:crypto';

/**
 * @param {object} scopes - scopes adapter.
 * @param {(name: string, payload: object) => Promise<void>} emit - dispatch to the plugin's listeners.
 */
export function createAgentPlane(scopes, emit) {
  const live = new Map();
  /** Subagents are composed under their preset's scope, not under the delegating agent. */
  const presetScope = {};

  const agents = {
    roots: () => [...live.values()].filter((entry) => entry.owner === undefined).map((entry) => entry.agent),
    list: () => [...live.values()].map((entry) => entry.agent),
    get: (id) => [...live.values()].find((entry) => entry.agent.id === id)?.agent,
  };

  return {
    services: { agents, ...scopes.services },
    /**
     * Create and announce an agent. With `parent` it is a subagent delegated
     * by that agent, whose session records `origin: 'subagent'`.
     * @param {{ parent?: object, origin?: 'subagent' }} [options]
     */
    async create({ parent, origin = parent ? 'subagent' : undefined } = {}) {
      const id = randomUUID();
      const agent = { id, session: { header: { id, ...(origin ? { origin } : {}) } } };
      const scope = scopes.open(agent, parent ? { parent: presetScope } : {});
      agent.ctx = scope.ctx;
      live.set(agent, { agent, owner: parent, scope });
      await emit('agent/created', { agent, source: { kind: 'new' } });
      return agent;
    },
    /** Unwind the agent's scoped registrations, then announce its disposal. */
    async dispose(agent) {
      const entry = live.get(agent);
      live.delete(agent);
      await entry.scope.dispose();
      await emit('agent/disposed', { agent });
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

/** Scopes adapter keeping registrations in memory. */
export function memoryScopes() {
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
      skills: { register: (skill) => add('skills', skill) },
    };
  }

  return {
    services: services(undefined),
    open(agent) {
      const disposers = new Set();
      const ctx = {
        ...services(agent, disposers),
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
      };
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
