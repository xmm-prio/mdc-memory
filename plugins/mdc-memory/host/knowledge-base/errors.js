/**
 * Every code a knowledge base operation is refused with, and the kind of
 * refusal it is: `invalid` input, a `conflict` with what is registered, or a
 * `missing` knowledge base.
 */
export const KNOWLEDGE_BASE_REFUSALS = Object.freeze({
  /** malformed input (missing name, non-boolean flag, ...) */
  'invalid-request': 'invalid',
  /** the path is not a fully qualified absolute path */
  'path-not-absolute': 'invalid',
  /** another knowledge base has this name; details.knowledgeBase */
  'name-taken': 'conflict',
  /** the name of basic-memory's internal default project */
  'name-reserved': 'conflict',
  /** the path equals, contains or lies inside a knowledge base; details.knowledgeBase */
  'path-registered': 'conflict',
  /** the path overlaps the internal default project's directory */
  'path-reserved': 'conflict',
  /** no knowledge base has this name; details.knowledgeBase */
  'not-found': 'missing',
  /** basic-memory refused the operation; the message carries its reason */
  rejected: 'invalid',
});

/** A knowledge base operation refused for a reason the user can act on. */
export class KnowledgeBaseError extends Error {
  /**
   * @param {keyof typeof KNOWLEDGE_BASE_REFUSALS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    if (!Object.hasOwn(KNOWLEDGE_BASE_REFUSALS, code)) throw new TypeError(`unknown knowledge base refusal ${code}`);
    super(message);
    this.name = 'KnowledgeBaseError';
    this.code = code;
    this.details = details;
  }

  /** @returns {'invalid' | 'conflict' | 'missing'} */
  get kind() {
    return KNOWLEDGE_BASE_REFUSALS[this.code];
  }
}
