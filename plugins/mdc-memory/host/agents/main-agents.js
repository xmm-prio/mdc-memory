/**
 * Main agents (主 agent): the agents a user converses with. A main agent is a
 * runtime root (created without an owning agent) whose session was not
 * started as a delegated subagent. Subagents are composed under their
 * preset's scope rather than under the agent that delegated to them, so
 * registrations made on a main agent's own context stay invisible to them.
 */

/**
 * Call `attach` for every current and future main agent, never for a
 * subagent. What `attach` sets up has two owners: the cleanup it returns runs
 * when the agent goes away or when the plugin owning `plane` is disposed,
 * whichever happens first.
 * @param {object} plane - plugin context carrying the dsh `agents` service, `on` and `effect`.
 * @param {(agent: object) => void | (() => void | Promise<void>)} attach
 */
export function watchMainAgents(plane, attach) {
  const attached = new Map();
  const isMain = (agent) => plane.agents.roots().includes(agent) && agent.session.header.origin !== 'subagent';

  const track = (agent) => {
    if (attached.has(agent) || !isMain(agent)) return;
    attached.set(agent, plane.effect(
      () => agent.ctx.effect(() => attach(agent), 'mdc-memory: main agent'),
      `mdc-memory: main agent ${agent.id}`,
    ));
  };

  plane.on('agent/created', ({ agent }) => { track(agent); });
  plane.on('agent/disposed', ({ agent }) => {
    const detach = attached.get(agent);
    if (detach === undefined) return;
    attached.delete(agent);
    void detach();
  });
  for (const agent of plane.agents.list()) track(agent);
}
