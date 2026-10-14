/**
 * The schema note for lessons (经验), shipped as lesson-schema.md. It is a
 * plain Markdown file in the knowledge base, indexed by basic-memory like any
 * user note.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TEMPLATE = new URL('./lesson-schema.md', import.meta.url);
const LESSON_TYPE = 'lesson';
/** basic-memory keeps schema notes under `schema/`, named after their entity. */
const NOTE_PATH = ['schema', 'lesson.md'];

/**
 * Write the lesson schema note into an indexed knowledge base unless
 * basic-memory already resolves a schema for lessons from its index, wherever
 * that note lives; an existing note (possibly edited by the user) is never
 * replaced, nor is a file already at the note's path.
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} basicMemory
 * @param {string} externalId - the knowledge base's basic-memory project.
 * @param {string} root - absolute root directory of the knowledge base.
 * @returns {Promise<boolean>} whether the note was written.
 */
export async function seedLessonSchema(basicMemory, externalId, root) {
  if (await basicMemory.hasSchemaFor(externalId, LESSON_TYPE)) return false;
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
