/**
 * The schema contract dsh validates persisted plugin state with, both storage
 * domain values and session projection states: `parse` returns the value or
 * throws, `safeParse` reports the outcome instead of throwing.
 */

/**
 * @template T
 * @param {(value: unknown) => T} parse - returns the parsed value; throws on an invalid one.
 * @returns {Readonly<{
 *   parse: (value: unknown) => T,
 *   safeParse: (value: unknown) => { success: true, data: T } | { success: false, error: unknown },
 * }>}
 */
export function defineSchema(parse) {
  return Object.freeze({
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        return { success: false, error };
      }
    },
  });
}
