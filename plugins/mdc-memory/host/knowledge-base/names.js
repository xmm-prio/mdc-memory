/**
 * Knowledge base names compare regardless of case: basic-memory addresses a
 * project by its case-folded permalink, so two names that differ only in
 * case designate the same knowledge base.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameKnowledgeBaseName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
