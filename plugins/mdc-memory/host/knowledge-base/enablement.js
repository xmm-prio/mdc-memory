/**
 * Enablement of knowledge bases, kept in the dsh plugin storage so it is
 * global (all workspaces and sessions) and survives restarts. Keyed by
 * knowledge base name; a name without a record is enabled.
 */

const BOOLEAN_SCHEMA = Object.freeze({
  parse(value) {
    if (typeof value !== 'boolean') throw new TypeError('expected a boolean');
    return value;
  },
  safeParse(value) {
    return typeof value === 'boolean' ? { success: true, data: value } : { success: false, error: new TypeError('expected a boolean') };
  },
});

/** Storage domain `mdc_memory_kb`, file `<dsh home>/storages/mdc_memory_kb.json`. */
export const ENABLEMENT_DOMAIN = Object.freeze({
  name: 'mdc_memory_kb',
  version: 1,
  tables: { enabled: { valueSchema: BOOLEAN_SCHEMA } },
});

export function createEnablement() {
  let table;
  let failure;
  const waiting = [];
  const opened = () => {
    if (table) return Promise.resolve(table);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  return {
    /**
     * Open the storage domain; operations issued before it is open wait for
     * it, and fail with the open error when it cannot be opened.
     * @param {object} storageDomain - the dsh `storageDomain` service.
     * @returns {Promise<() => Promise<void>>} closes the domain.
     */
    async mount(storageDomain) {
      let domain;
      try {
        domain = await storageDomain.open(ENABLEMENT_DOMAIN);
      } catch (error) {
        failure = error;
        for (const { reject } of waiting.splice(0)) reject(error);
        throw error;
      }
      table = domain.table('enabled');
      for (const { resolve } of waiting.splice(0)) resolve(table);
      return async () => {
        table = undefined;
        await domain.close();
      };
    },
    /** @returns {Promise<(name: string) => boolean>} reader over the current records. */
    async reader() {
      const current = await opened();
      return (name) => current.get(name) ?? true;
    },
    /** Durably record whether the knowledge base `name` is enabled. */
    async set(name, enabled) {
      await (await opened()).put(name, enabled);
    },
    /** Drop the record of a knowledge base that no longer exists. */
    async forget(name) {
      await (await opened()).delete(name);
    },
  };
}
