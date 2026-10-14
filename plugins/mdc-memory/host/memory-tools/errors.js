/**
 * A memory tool call refused before it reaches basic-memory, for a reason the
 * agent can act on. The message is what the agent reads.
 *
 * code:
 *   no-knowledge-base       - no knowledge base is enabled
 *   project-required        - several knowledge bases are enabled and the call names none
 *   not-enabled             - the named knowledge base exists but is turned off
 *   unknown-knowledge-base  - no knowledge base has the name
 *   outside-knowledge-base  - a memory:// URL points into another knowledge base or outside the enabled ones
 *   unsupported-argument    - an argument the tool does not declare
 */
export class MemoryToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MemoryToolError';
    this.code = code;
  }
}
