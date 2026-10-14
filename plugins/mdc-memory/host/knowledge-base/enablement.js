/**
 * Enablement of knowledge bases, kept in the dsh plugin storage so it is
 * global (all workspaces and sessions) and survives restarts. Keyed by
 * knowledge base name; a name without a record is enabled.
 */
import { createDomainSlot } from '../storage/domain-slot.js';
import { defineSchema } from '../storage/schema.js';

const BOOLEAN_SCHEMA = defineSchema((value) => {
  if (typeof value !== 'boolean') throw new TypeError('expected a boolean');
  return value;
});

/** Storage domain `mdc_memory_kb`, file `<dsh home>/storages/mdc_memory_kb.json`. */
export const ENABLEMENT_DOMAIN = Object.freeze({
  name: 'mdc_memory_kb',
  version: 1,
  tables: { enabled: { valueSchema: BOOLEAN_SCHEMA } },
});

export function createEnablement() {
  const slot = createDomainSlot(ENABLEMENT_DOMAIN);
  const table = async () => (await slot.opened()).table('enabled');

  return {
    /**
     * Open the storage domain; operations issued before it is open wait for
     * it, and fail with the open error when it cannot be opened.
     * @param {object} storageDomain - the dsh `storageDomain` service.
     * @returns {Promise<() => Promise<void>>} closes the domain.
     */
    mount: (storageDomain) => slot.mount(storageDomain),
    /** @returns {Promise<(name: string) => boolean>} reader over the current records. */
    async reader() {
      const current = await table();
      return (name) => current.get(name) ?? true;
    },
    /** Durably record whether the knowledge base `name` is enabled. */
    async set(name, enabled) {
      await (await table()).put(name, enabled);
    },
    /** Drop the record of a knowledge base that no longer exists. */
    async forget(name) {
      await (await table()).delete(name);
    },
  };
}
