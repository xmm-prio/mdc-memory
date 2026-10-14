/**
 * The Memory prompt section: a resident system prompt section that comes
 * with the memory tools. It lists the effective knowledge bases and tells the
 * agent when to read the lesson skill; its text follows the effective
 * knowledge bases without being registered again.
 */

const SECTION_NAME = 'mdc-memory';
/** After dsh's MCP server section (3100), before its tool SDK section (5000). */
const SECTION_ORDER = 3150;

/**
 * @param {object} options
 * @param {string} options.lessonSkillName - the skill that tells agents how to record a lesson (经验).
 * @returns {import('../memory-offer/index.js').Contribution}
 */
export function createMemoryPrompt({ lessonSkillName }) {
  return {
    register: (agent, current) => agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => renderMemorySection(current().knowledgeBases, lessonSkillName),
    }),
  };
}

/**
 * @param {readonly { name: string }[]} knowledgeBases - the effective knowledge bases.
 * @param {string} lessonSkillName
 * @returns {string}
 */
function renderMemorySection(knowledgeBases, lessonSkillName) {
  return [
    '## Memory',
    '',
    'The memory tools read and write long-term memory: Markdown notes kept in knowledge bases. Enabled knowledge bases:',
    ...knowledgeBases.map((knowledgeBase) => `- ${knowledgeBase.name}`),
    '',
    `Read the \`${lessonSkillName}\` skill before you record a lesson (a pitfall worth remembering: its symptom, cause and fix): `
      + 'after solving a non-obvious problem such as an error, an environment quirk or a tool misbehavior that took real effort to figure out, '
      + 'or when the user asks you to remember something.',
  ].join('\n');
}
