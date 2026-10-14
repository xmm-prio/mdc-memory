/**
 * The bundled `lesson` skill (skills/lesson/SKILL.md): how an agent records a
 * lesson (经验) with the memory tools. It is read once, as a runtime skill
 * registration for dsh's skill registry; upstream basic-memory skills are
 * never registered.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_FILE = fileURLToPath(new URL('../../skills/lesson/SKILL.md', import.meta.url));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
/** A flat `key: value` line; a double-quoted value is read as a JSON string. */
const FIELD = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/;

/**
 * @returns {Readonly<{ name: string, description: string, source: 'bundled', content: string, path: string }>}
 *   the registration for `ctx.skills.register`: the frontmatter's `name` and
 *   `description`, and the instructions after the frontmatter.
 * @throws {Error} when the bundled file lacks a frontmatter `name` or `description`.
 */
export function loadLessonSkill() {
  const text = readFileSync(SKILL_FILE, 'utf8');
  const frontmatter = FRONTMATTER.exec(text);
  if (frontmatter === null) throw new Error(`mdc-memory: ${SKILL_FILE} has no frontmatter`);
  const fields = Object.fromEntries(frontmatter[1].split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const field = FIELD.exec(line);
    if (field === null) throw new Error(`mdc-memory: ${SKILL_FILE} has an unsupported frontmatter line: ${line}`);
    const value = field[2].trim();
    return [field[1], value.startsWith('"') ? JSON.parse(value) : value];
  }));
  for (const key of ['name', 'description']) {
    if (typeof fields[key] !== 'string' || fields[key] === '') throw new Error(`mdc-memory: ${SKILL_FILE} has no frontmatter ${key}`);
  }
  return Object.freeze({
    name: fields.name,
    description: fields.description,
    source: 'bundled',
    content: text.slice(frontmatter[0].length).trimStart(),
    path: SKILL_FILE,
  });
}
