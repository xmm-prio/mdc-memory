/**
 * Knowledge base setup through the settings routes, for tests that need
 * knowledge bases in a given state rather than test the routes themselves:
 * every call asserts that the route succeeded.
 */
import assert from 'node:assert/strict';

/**
 * @param {() => { request: Function }} http - the routes of the Host row currently running.
 * @param {(name: string) => string} rootOf - the directory a knowledge base named `name` is added at.
 */
export function knowledgeBaseRoutes(http, rootOf) {
  const add = async (name) => {
    const added = await http().request('POST', '/mdc-memory/kbs/add', { body: { name, path: rootOf(name) } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  };
  const setEnabled = async (name, enabled) => {
    const set = await http().request('POST', '/mdc-memory/kbs/set-enabled', { body: { name, enabled } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  };
  return {
    add,
    setEnabled,
    /** Afterwards exactly `names` are enabled; the missing ones are added. */
    async useKnowledgeBases(...names) {
      const { items } = (await http().request('GET', '/mdc-memory/kbs')).body;
      for (const name of names) if (!items.some((item) => item.name === name)) await add(name);
      for (const item of items) await setEnabled(item.name, names.includes(item.name));
      for (const name of names) await setEnabled(name, true);
    },
  };
}
