/**
 * The schema note for lessons (经验), shipped as lesson-schema.md. It is a
 * plain Markdown file in the knowledge base: written to disk before the
 * knowledge base is indexed, so basic-memory picks it up like any user note.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TEMPLATE = new URL('./lesson-schema.md', import.meta.url);
/** basic-memory keeps schema notes under `schema/`, named after their entity. */
const NOTE_PATH = ['schema', 'lesson.md'];

/**
 * Write the lesson schema note into a knowledge base unless the file already
 * exists; an existing note (possibly edited by the user) is never replaced.
 * @param {string} root - absolute root directory of the knowledge base.
 * @returns {Promise<boolean>} whether the note was written.
 */
export async function seedLessonSchema(root) {
  const file = join(root, ...NOTE_PATH);
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, await readFile(TEMPLATE), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}
