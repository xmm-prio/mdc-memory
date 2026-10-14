/**
 * Recall settings (召回配置), kept in the dsh plugin storage so they are global
 * and survive restarts. Read on every recall, so a change applies to the very
 * next user message.
 *
 * onUserMessage - recall when the user sends a message to a main agent
 * minSimilarity - the semantic similarity (0..1) a lesson must reach to be recalled
 * maxLessons    - how many lessons one recall injects at most
 */
import { createDomainSlot } from '../storage/domain-slot.js';
import { defineSchema } from '../storage/schema.js';

/** @typedef {{ onUserMessage: boolean, minSimilarity: number, maxLessons: number }} RecallSettings */

/**
 * With `BAAI/bge-small-zh-v1.5`, a message and a lesson about the same problem
 * score about 0.7-0.8, while unrelated technical text reaches up to about 0.58;
 * the default threshold sits between the two.
 * @type {Readonly<RecallSettings>}
 */
export const DEFAULT_RECALL_SETTINGS = Object.freeze({ onUserMessage: true, minSimilarity: 0.65, maxLessons: 3 });

/** Inclusive bounds of the numeric settings; the settings UI offers values within them. */
export const RECALL_SETTINGS_LIMITS = Object.freeze({
  minSimilarity: Object.freeze({ min: 0, max: 1 }),
  maxLessons: Object.freeze({ min: 1, max: 10 }),
});

const within = (value, { min, max }) => value >= min && value <= max;
const { minSimilarity: SIMILARITY, maxLessons: LESSONS } = RECALL_SETTINGS_LIMITS;

const FIELDS = Object.freeze({
  onUserMessage: { valid: (value) => typeof value === 'boolean', rule: 'must be a boolean' },
  minSimilarity: {
    valid: (value) => typeof value === 'number' && within(value, SIMILARITY),
    rule: `must be a number from ${SIMILARITY.min} to ${SIMILARITY.max}`,
  },
  maxLessons: {
    valid: (value) => Number.isInteger(value) && within(value, LESSONS),
    rule: `must be an integer from ${LESSONS.min} to ${LESSONS.max}`,
  },
});

/** Settings refused for a reason the caller can fix; `details.field` names the offending field. */
export class RecallSettingsError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RecallSettingsError';
    this.code = 'invalid-request';
    this.details = details;
  }
}

/**
 * Validate a partial settings object.
 * @param {unknown} patch
 * @returns {Partial<RecallSettings>}
 * @throws {RecallSettingsError} on a non-object, an unknown field or an invalid value.
 */
function parsePatch(patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new RecallSettingsError('settings must be an object');
  for (const [field, value] of Object.entries(patch)) {
    const spec = FIELDS[field];
    if (spec === undefined) throw new RecallSettingsError(`unknown setting ${field}`, { field });
    if (!spec.valid(value)) throw new RecallSettingsError(`${field} ${spec.rule}`, { field });
  }
  return patch;
}

/** Stored settings: fields missing from an older record fall back to their defaults. */
const SETTINGS_SCHEMA = defineSchema((value) => {
  if (typeof value !== 'object' || value === null) throw new TypeError('recall settings must be an object');
  const known = Object.fromEntries(Object.keys(FIELDS).filter((field) => field in value).map((field) => [field, value[field]]));
  return Object.freeze({ ...DEFAULT_RECALL_SETTINGS, ...parsePatch(known) });
});

/** Storage domain `mdc_memory_recall`, file `<dsh home>/storages/mdc_memory_recall.json`. */
export const RECALL_SETTINGS_DOMAIN = Object.freeze({
  name: 'mdc_memory_recall',
  version: 1,
  tables: {},
  global: { schema: SETTINGS_SCHEMA, initial: DEFAULT_RECALL_SETTINGS },
});

export function createRecallSettings() {
  const slot = createDomainSlot(RECALL_SETTINGS_DOMAIN);
  let writes = Promise.resolve();

  return {
    /**
     * Open the storage domain; reads and updates issued before it is open wait for it.
     * @param {object} storageDomain - the dsh `storageDomain` service.
     * @returns {Promise<() => Promise<void>>} closes the domain.
     */
    mount: (storageDomain) => slot.mount(storageDomain),
    /** @returns {Promise<Readonly<RecallSettings>>} */
    async current() {
      return (await slot.opened()).global.get();
    },
    /**
     * Durably change some settings; updates apply one after another.
     * @param {unknown} patch - a subset of the settings fields.
     * @returns {Promise<Readonly<RecallSettings>>} the settings after the change.
     * @throws {RecallSettingsError}
     */
    update(patch) {
      const change = parsePatch(patch);
      const write = writes.then(async () => {
        const { global } = await slot.opened();
        const next = Object.freeze({ ...global.get(), ...change });
        await global.set(next);
        return next;
      });
      writes = write.catch(() => {});
      return write;
    },
  };
}
