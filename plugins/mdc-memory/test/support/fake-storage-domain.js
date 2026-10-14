/**
 * In-memory stand-in for the dsh `storageDomain` service: one domain name can
 * be open at a time, records and the global are validated on open, and closed
 * domains keep their data in `medium` so a later open sees it (a plugin reload).
 */
/** Medium key of a domain's global; not a valid table name, so it never collides. */
const GLOBAL = '#global';

export function createFakeStorageDomain(medium = new Map()) {
  const open = new Set();
  return {
    medium,
    async open(spec) {
      if (spec.global && spec.global.schema.safeParse(null).success) throw new Error(`storage-domain: ${spec.name} global schema accepts null`);
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
      let globalValue = spec.global && (stored.has(GLOBAL) ? spec.global.schema.parse(stored.get(GLOBAL)) : spec.global.initial);
      let closed = false;
      return {
        name: spec.name,
        table(name) {
          if (!tables.has(name)) throw new Error(`storage-domain: undeclared table ${name}`);
          return tables.get(name);
        },
        get global() {
          if (!spec.global) throw new Error(`storage-domain: ${spec.name} declares no global`);
          return {
            get: () => globalValue,
            async set(value) {
              globalValue = value;
              stored.set(GLOBAL, value);
            },
          };
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
