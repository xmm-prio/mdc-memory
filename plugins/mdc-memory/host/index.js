/**
 * Host row `mdc-memory`: hosts the basic-memory process, manages knowledge
 * bases and serves both to the settings UI. Wiring only; the runtime, the
 * knowledge bases and the HTTP API live in their own modules.
 */
import { fileURLToPath } from 'node:url';

import { createBasicMemoryClient } from './basic-memory/client.js';
import { resolveConfig } from './config.js';
import { knowledgeBaseEndpoints } from './http/knowledge-base-endpoints.js';
import { recallEndpoints } from './http/recall-endpoints.js';
import { registerEndpoints } from './http/router.js';
import { runtimeEndpoints } from './http/runtime-endpoints.js';
import { createEnablement } from './knowledge-base/enablement.js';
import { createKnowledgeBases } from './knowledge-base/index.js';
import { createRecall } from './recall/index.js';
import { createRecallSettings } from './recall/settings.js';
import { createRuntime } from './runtime/index.js';

export const name = 'mdc-memory';
export const inject = ['subprocess', 'storageDomain'];

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

  const basicMemory = createBasicMemoryClient(runtime);
  const enablement = createEnablement();
  ctx.effect(() => enablement.mount(ctx.storageDomain), 'mdc-memory: enablement store');
  const knowledgeBases = createKnowledgeBases({ basicMemory, enablement, logger: ctx.logger });

  const recallSettings = createRecallSettings();
  ctx.effect(() => recallSettings.mount(ctx.storageDomain), 'mdc-memory: recall settings store');
  const recall = createRecall({ basicMemory, knowledgeBases, settings: recallSettings, logger: ctx.logger });
  ctx.inject(['agents', 'sessionProjections'], (plane) => recall.mount(plane));

  ctx.inject(['webServer', 'connection'], (web) => registerEndpoints(web, [
    ...runtimeEndpoints(runtime),
    ...knowledgeBaseEndpoints(knowledgeBases),
    ...recallEndpoints(recallSettings),
  ]));
}
