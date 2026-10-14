/**
 * A knowledge base operation refused for a reason the user can act on.
 *
 * code:
 *   invalid-request    - malformed input (missing name, non-boolean flag, ...)
 *   path-not-absolute  - the path is not a fully qualified absolute path
 *   name-taken         - another knowledge base has this name; details.knowledgeBase
 *   name-reserved      - the name of basic-memory's internal default project
 *   path-registered    - the path equals, contains or lies inside a knowledge base; details.knowledgeBase
 *   path-reserved      - the path overlaps the internal default project's directory
 *   not-found          - no knowledge base has this name; details.knowledgeBase
 *   rejected           - basic-memory refused the operation; the message carries its reason
 */
export class KnowledgeBaseError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'KnowledgeBaseError';
    this.code = code;
    this.details = details;
  }
}
