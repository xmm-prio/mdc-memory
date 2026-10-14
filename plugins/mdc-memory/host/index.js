/**
 * Host row `mdc-memory`: hosts the basic-memory process, manages knowledge
 * bases and serves both to the settings UI, offers memory to main agents and
 * recalls lessons when the user messages one. Wiring only; the runtime, the
 * knowledge bases, the HTTP API, the memory offer with its contributions and
 * recall live in their own modules.
 */
import { fileURLToPath } from 'node:url';

import { watchMainAgents } from './agents/main-agents.js';
import { createBasicMemoryClient } from './basic-memory/client.js';
import { resolveConfig } from './config.js';
import { knowledgeBaseEndpoints } from './http/knowledge-base-endpoints.js';
import { recallEndpoints } from './http/recall-endpoints.js';
import { registerEndpoints } from './http/router.js';
import { runtimeEndpoints } from './http/runtime-endpoints.js';
import { createEnablement } from './knowledge-base/enablement.js';
import { createKnowledgeBases } from './knowledge-base/index.js';
import { createLessonSkill } from './lesson-skill/index.js';
import { createMemoryOffer } from './memory-offer/index.js';
import { createMemoryPrompt } from './memory-prompt/index.js';
import { createMemoryTools } from './memory-tools/index.js';
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

  ctx.inject(['webServer', 'connection'], (web) => registerEndpoints(web, [
    ...runtimeEndpoints(runtime),
    ...knowledgeBaseEndpoints(knowledgeBases),
    ...recallEndpoints(recallSettings),
  ]));

  const memoryTools = createMemoryTools({ basicMemory, knowledgeBases, whitelist: config.memoryTools, logger: ctx.logger });
  const lessonSkill = createLessonSkill();
  const memoryOffer = createMemoryOffer({
    knowledgeBases,
    loadTools: memoryTools.load,
    contributions: [memoryTools, createMemoryPrompt({ lessonSkillName: lessonSkill.name }), lessonSkill],
    logger: ctx.logger,
  });
  ctx.effect(() => memoryOffer.start(), 'mdc-memory: memory offer');
  ctx.inject(['agents', 'tools', 'systemPrompt'], (plane) => watchMainAgents(plane, (agent) => memoryOffer.attach(agent)));

  const recall = createRecall({ basicMemory, knowledgeBases, settings: recallSettings, logger: ctx.logger });
  ctx.inject(['agents', 'sessionProjections'], (plane) => recall.mount(plane));
}
