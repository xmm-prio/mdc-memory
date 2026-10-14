/**
 * Lesson search for recall: the current lessons (经验) of the given knowledge
 * bases that relate to a text, best first, merged across knowledge bases.
 *
 * - Only notes of type `lesson`; reference notes (参考笔记) never match.
 * - Current lessons only: none with `status: outdated` and none that a lesson
 *   targets with a `supersedes` relation. Both are read from the index at
 *   search time; no note file is ever rewritten.
 * - Eligibility is semantic: a lesson qualifies when its similarity to the
 *   text reaches `minSimilarity`. basic-memory's hybrid score cannot carry such
 *   a threshold: it scales keyword hits against the best keyword hit of the
 *   same query (which always scores 1.0) and applies `min_similarity` to its
 *   semantic leg only. So a semantic search decides which lessons qualify and
 *   the hybrid (semantic + keyword) search decides their order.
 */

/** How many top hits each ranking contributes before exclusions. */
const CANDIDATES = 50;
const EXCLUSION_PAGE_SIZE = 1000;

/**
 * @typedef {object} RecalledLesson
 * @property {string} title
 * @property {string} permalink - unique across knowledge bases; `memory://<permalink>` links the note.
 * @property {string} knowledgeBase - name of the knowledge base the lesson comes from.
 */

/**
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} basicMemory
 * @param {object} request
 * @param {string} request.text - natural-language text to relate lessons to.
 * @param {readonly import('../knowledge-base/index.js').KnowledgeBase[]} request.knowledgeBases - where to search.
 * @param {number} request.minSimilarity - semantic similarity (0..1) a lesson must reach.
 * @param {number} request.limit - at most this many lessons.
 * @param {ReadonlySet<string>} request.exclude - permalinks of lessons to leave out.
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<RecalledLesson[]>}
 */
export async function findLessons(basicMemory, { text, knowledgeBases, minSimilarity, limit, exclude, signal }) {
  if (knowledgeBases.length === 0) return [];
  const projectIds = knowledgeBases.map((knowledgeBase) => knowledgeBase.projectId);
  const lessons = { note_types: ['lesson'], entity_types: ['entity'], project_ids: projectIds };
  const related = { ...lessons, text, min_similarity: minSimilarity };
  const [ranked, semantic, outdated, supersedes] = await Promise.all([
    basicMemory.search({ ...related, retrieval_mode: 'hybrid' }, { pageSize: CANDIDATES, signal }),
    basicMemory.search({ ...related, retrieval_mode: 'vector' }, { pageSize: CANDIDATES, signal }),
    searchAll(basicMemory, { ...lessons, status: 'outdated' }, signal),
    searchAll(basicMemory, { note_types: ['lesson'], entity_types: ['relation'], permalink_match: '*/supersedes/*', project_ids: projectIds }, signal),
  ]);

  const qualifying = new Set(semantic.results.map((hit) => hit.permalink));
  const stale = new Set([
    ...outdated.map((hit) => hit.permalink),
    ...supersedes.filter((hit) => hit.relation_type === 'supersedes' && hit.to_entity).map((hit) => hit.to_entity),
  ]);
  const nameOf = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.projectId, knowledgeBase.name]));
  return ranked.results
    .filter((hit) => qualifying.has(hit.permalink) && !stale.has(hit.permalink) && !exclude.has(hit.permalink) && nameOf.has(hit.project_id))
    .slice(0, limit)
    .map((hit) => Object.freeze({ title: hit.title, permalink: hit.permalink, knowledgeBase: nameOf.get(hit.project_id) }));
}

async function searchAll(basicMemory, query, signal) {
  const results = [];
  for (let page = 1; ; page += 1) {
    const response = await basicMemory.search(query, { page, pageSize: EXCLUSION_PAGE_SIZE, signal });
    results.push(...response.results);
    if (!response.has_more || response.results.length === 0) return results;
  }
}
