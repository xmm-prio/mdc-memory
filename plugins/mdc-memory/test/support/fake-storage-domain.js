/**
 * In-memory stand-in for the dsh `storageDomain` service: one domain name can
 * be open at a time, records are validated on open, and closed domains keep
 * their records in `medium` so a later open sees them (a plugin reload).
 */
export function createFakeStorageDomain(medium = new Map()) {
  const open = new Set();
  return {
    medium,
    async open(spec) {
      if (open.has(spec.name)) throw new Error(`storage-domain: ${spec.name} is already open`);
      open.add(spec.name);
      if (!medium.has(spec.name)) medium.set(spec.name, new Map());
      const stored = medium.get(spec.name);
      const tables = new Map(Object.entries(spec.tables).map(([name, { valueSchema }]) => {
        if (!stored.has(name)) stored.set(name, new Map());
        const records = stored.get(name);
        for (const value of records.values()) valueSchema.parse(value);
        return [name, tableOf(records)];
      }));
      let closed = false;
      return {
        name: spec.name,
        table(name) {
          if (!tables.has(name)) throw new Error(`storage-domain: undeclared table ${name}`);
          return tables.get(name);
        },
        async close() {
          if (closed) return;
          closed = true;
          open.delete(spec.name);
        },
      };
    },
  };
}

function tableOf(records) {
  return {
    get: (key) => records.get(key),
    entries: () => new Map(records).entries(),
    keys: () => new Map(records).keys(),
    get size() { return records.size; },
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); },
  };
}
