/**
 * Status of the managed basic-memory runtime: one immutable snapshot that the
 * pipeline advances and the HTTP API serves.
 *
 * state  - 'preparing' | 'ready' | 'error'
 * stages - every pipeline stage with 'pending' | 'running' | 'done' | 'failed'
 * detail - latest progress line of the running stage (preparing only)
 * endpoint - base URL of the basic-memory server (ready only)
 * error  - { stage, message, output? } (error only)
 */

/** @param {readonly string[]} stageIds - pipeline stage ids in run order. */
export function createStatus(stageIds) {
  let current;
  const publish = (next) => {
    current = Object.freeze({ ...next, updatedAt: new Date().toISOString() });
  };
  const stages = (stateOf) => stageIds.map((id) => Object.freeze({ id, state: stateOf(id) }));
  const stateOf = (id) => current.stages.find((stage) => stage.id === id)?.state;

  const begin = () => publish({ state: 'preparing', stages: stages(() => 'pending') });
  begin();

  return {
    snapshot: () => current,
    begin,
    /** Mark `id` running; stages before it are done. */
    enter(id) {
      const at = stageIds.indexOf(id);
      publish({ state: 'preparing', stages: stages((other) => {
        const index = stageIds.indexOf(other);
        return index < at ? 'done' : index === at ? 'running' : 'pending';
      }) });
    },
    /** Record the latest progress line of the running stage. */
    progress(id, detail) {
      if (current.state !== 'preparing' || stateOf(id) !== 'running') return;
      publish({ ...current, detail });
    },
    ready(endpoint) {
      publish({ state: 'ready', stages: stages(() => 'done'), endpoint });
    },
    fail(id, message, output) {
      const failed = stages((other) => (other === id ? 'failed' : stateOf(other)));
      publish({ state: 'error', stages: failed, error: Object.freeze({ stage: id, message, ...(output ? { output } : {}) }) });
    },
  };
}
