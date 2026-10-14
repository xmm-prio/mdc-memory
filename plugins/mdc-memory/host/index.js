/**
 * Host row `mdc-memory`: hosts the basic-memory process and serves its status
 * to the settings UI. Wiring only; the runtime and the HTTP API live in their
 * own modules.
 */
import { fileURLToPath } from 'node:url';

import { resolveConfig } from './config.js';
import { registerEndpoints } from './http/router.js';
import { runtimeEndpoints } from './http/runtime-endpoints.js';
import { createRuntime } from './runtime/index.js';

export const name = 'mdc-memory';
export const inject = ['subprocess'];

/** The basic-memory source tools/pack stages into the bundle (ADR 0003). */
const PACKAGED_PYTHON_SOURCE = fileURLToPath(new URL('../python', import.meta.url));

/**
 * Synchronous on purpose: cordis does not await a function plugin's return
 * value, so long-running preparation runs in the background under an effect.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, {
    dataDir: ctx.get('dshHomePath')?.('memory'),
    pythonSource: PACKAGED_PYTHON_SOURCE,
  });
  const runtime = createRuntime({ config, subprocess: ctx.subprocess, logger: ctx.logger });
  ctx.effect(() => {
    runtime.start();
    return () => runtime.stop();
  }, 'mdc-memory: basic-memory runtime');
  ctx.inject(['webServer', 'connection'], (web) => registerEndpoints(web, runtimeEndpoints(runtime)));
}
