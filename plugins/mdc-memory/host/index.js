/**
 * Host row `mdc-memory`: hosts the basic-memory process, manages knowledge
 * bases and serves both to the settings UI, and offers memory tools to main
 * agents. Wiring only; the runtime, the knowledge bases, the HTTP API and the
 * memory tools live in their own modules.
 */
import { fileURLToPath } from 'node:url';

import { watchMainAgents } from './agents/main-agents.js';
import { createBasicMemoryClient } from './basic-memory/client.js';
import { resolveConfig } from './config.js';
import { knowledgeBaseEndpoints } from './http/knowledge-base-endpoints.js';
import { registerEndpoints } from './http/router.js';
import { runtimeEndpoints } from './http/runtime-endpoints.js';
import { createEnablement } from './knowledge-base/enablement.js';
import { createKnowledgeBases } from './knowledge-base/index.js';
import { createMemoryTools } from './memory-tools/index.js';
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

  ctx.inject(['webServer', 'connection'], (web) => registerEndpoints(web, [
    ...runtimeEndpoints(runtime),
    ...knowledgeBaseEndpoints(knowledgeBases),
  ]));

  const memoryTools = createMemoryTools({ basicMemory, knowledgeBases, whitelist: config.memoryTools, logger: ctx.logger });
  ctx.effect(() => memoryTools.start(), 'mdc-memory: memory tools');
  ctx.inject(['agents', 'tools', 'systemPrompt'], (plane) => watchMainAgents(plane, (agent) => memoryTools.attach(agent)));
}
