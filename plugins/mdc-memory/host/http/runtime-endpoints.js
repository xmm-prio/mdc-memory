/** HTTP API of the managed basic-memory runtime: status query and retry. */
import { HttpError } from './router.js';

/**
 * @param {ReturnType<typeof import('../runtime/index.js').createRuntime>} runtime
 * @returns {import('./router.js').Endpoint[]}
 */
export function runtimeEndpoints(runtime) {
  return [
    { method: 'GET', path: '/mdc-memory/status', handle: () => runtime.status() },
    {
      method: 'POST',
      path: '/mdc-memory/retry',
      handle() {
        if (!runtime.retry()) throw new HttpError(409, 'not-retryable', 'retry is only available after an error');
        return runtime.status();
      },
    },
  ];
}
