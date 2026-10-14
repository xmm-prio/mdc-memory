/**
 * The resident system prompt section that comes with the memory tools. Its
 * text changes only with the effective knowledge bases.
 */

/**
 * @param {readonly { name: string }[]} knowledgeBases - the effective knowledge bases.
 * @param {{ name: string }} lessonSkill - the bundled skill that tells agents how to record a lesson (经验).
 * @returns {string}
 */
export function renderMemorySection(knowledgeBases, lessonSkill) {
  return [
    '## Memory',
    '',
    'The memory tools read and write long-term memory: Markdown notes kept in knowledge bases. Enabled knowledge bases:',
    ...knowledgeBases.map((knowledgeBase) => `- ${knowledgeBase.name}`),
    '',
    `Read the \`${lessonSkill.name}\` skill before you record a lesson (a pitfall worth remembering: its symptom, cause and fix): `
      + 'after solving a non-obvious problem such as an error, an environment quirk or a tool misbehavior that took real effort to figure out, '
      + 'or when the user asks you to remember something.',
  ].join('\n');
}
