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
 *   the hybrid (semantic + keyword) search only orders them.
 * - Every qualifying lesson stays a candidate: exclusions apply to all of
 *   them before the best `limit` are taken, and a qualifying lesson the
 *   hybrid ranking does not reach keeps its semantic order after the ones it
 *   ranks.
 */

/** How many hybrid hits order the qualifying lessons. */
const RANKING_WINDOW = 50;
const PAGE_SIZE = 1000;

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
  const [qualifying, ranked, outdated, supersedes] = await Promise.all([
    searchAll(basicMemory, { ...related, retrieval_mode: 'vector' }, signal),
    basicMemory.search({ ...related, retrieval_mode: 'hybrid' }, { pageSize: RANKING_WINDOW, signal }),
    searchAll(basicMemory, { ...lessons, status: 'outdated' }, signal),
    searchAll(basicMemory, { note_types: ['lesson'], entity_types: ['relation'], permalink_match: '*/supersedes/*', project_ids: projectIds }, signal),
  ]);

  const stale = new Set([
    ...outdated.map((hit) => hit.permalink),
    ...supersedes.filter((hit) => hit.relation_type === 'supersedes' && hit.to_entity).map((hit) => hit.to_entity),
  ]);
  const nameOf = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.projectId, knowledgeBase.name]));
  const rank = new Map(ranked.results.map((hit, index) => [hit.permalink, index]));
  const rankOf = (hit) => rank.get(hit.permalink) ?? ranked.results.length;
  return qualifying
    .filter((hit) => !stale.has(hit.permalink) && !exclude.has(hit.permalink) && nameOf.has(hit.project_id))
    .toSorted((a, b) => rankOf(a) - rankOf(b))
    .slice(0, limit)
    .map((hit) => Object.freeze({ title: hit.title, permalink: hit.permalink, knowledgeBase: nameOf.get(hit.project_id) }));
}

async function searchAll(basicMemory, query, signal) {
  const results = [];
  for (let page = 1; ; page += 1) {
    const response = await basicMemory.search(query, { page, pageSize: PAGE_SIZE, signal });
    results.push(...response.results);
    if (!response.has_more || response.results.length === 0) return results;
  }
}
