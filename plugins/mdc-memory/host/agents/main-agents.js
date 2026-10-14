/**
 * Main agents (主 agent): the agents a user talks to directly. Memory tools
 * and recall attach to them only; subagents never get either.
 *
 * A main agent is a runtime root (created without an owning agent) whose
 * session is not a subagent's: a resumed subagent session can be a runtime
 * root, but keeps its durable `origin: 'subagent'` mark.
 */

/**
 * Call `attach` for every current and future main agent. Whatever `attach`
 * registers has two owners: it is cleaned up when the agent goes away and
 * when the plugin context `plane` is disposed, whichever comes first.
 * @param {object} plane - plugin context carrying the dsh `agents` service (`agents`, `on`, `effect`, `logger`).
 * @param {(agent: object) => (void | (() => void | Promise<void>))} attach - may return its cleanup. A throw is
 *   logged and contained, so it never fails the agent's creation.
 */
export function watchMainAgents(plane, attach) {
  const detachers = new Map();
  const isMain = (agent) => plane.agents.roots().includes(agent) && agent.session.header.origin !== 'subagent';

  const track = (agent) => {
    if (detachers.has(agent) || !isMain(agent)) return;
    detachers.set(agent, plane.effect(() => agent.ctx.effect(() => {
      let cleanup;
      try {
        cleanup = attach(agent);
      } catch (error) {
        plane.logger.warn(`mdc-memory: attaching to agent ${agent.id} failed: ${error?.stack ?? error}`);
      }
      return () => cleanup?.();
    }), `mdc-memory: main agent ${agent.id}`));
  };

  plane.on('agent/created', ({ agent }) => {
    track(agent);
  });
  plane.on('agent/disposed', ({ agent }) => {
    const detach = detachers.get(agent);
    if (detach === undefined) return;
    detachers.delete(agent);
    void detach();
  });
  for (const agent of plane.agents.list()) track(agent);
}
