/** HTTP API of the recall settings for the settings UI. */
import { RecallSettingsError } from '../recall/settings.js';
import { HttpError, mapErrors } from './router.js';

/**
 * @param {ReturnType<typeof import('../recall/settings.js').createRecallSettings>} recallSettings
 * @returns {import('./router.js').Endpoint[]}
 */
export function recallEndpoints(recallSettings) {
  return mapErrors(toHttpError, [
    { method: 'GET', path: '/mdc-memory/recall-settings', handle: () => recallSettings.current() },
    { method: 'POST', path: '/mdc-memory/recall-settings/update', handle: (body) => recallSettings.update(body) },
  ]);
}

function toHttpError(error) {
  if (error instanceof RecallSettingsError) return new HttpError(400, error.code, error.message, error.details);
  return error;
}
