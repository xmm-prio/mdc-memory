/**
 * Real dsh services and test-data settings shared by the opt-in tests that
 * drive a real basic-memory. Services come from dsh's bundled packages,
 * mounted on a bare cordis root; nothing is installed into a dsh profile.
 *
 *   MDC_MEMORY_REAL_TEST=1             enable
 *   MDC_MEMORY_TEST_DATA_DIR=<dir>     persistent dataDir; reruns reuse its venv and model (default: OS temp)
 *   MDC_MEMORY_TEST_MODEL_CACHE=<dir>  optional FastEmbed cache to seed the model from instead of downloading
 *   MDC_MEMORY_PYTHON_SOURCE=<dir>     basic-memory checkout (default: vendor/basic-memory of this repo)
 *   DSH_PKGS=<dir>                     dsh's bundled @deepseek-ai packages (default: from `npm root -g`)
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REAL_TEST_ENABLED = process.env.MDC_MEMORY_REAL_TEST === '1';
export const REAL_TEST_SKIP = !REAL_TEST_ENABLED && 'set MDC_MEMORY_REAL_TEST=1';

const MODEL_DIR = 'models--Qdrant--bge-small-zh-v1.5';

/**
 * Host config for the real tests; seeds the model cache when a seed is given.
 * @returns {{ pythonSource: string, dataDir: string }}
 */
export function realHostConfig() {
  const pythonSource = process.env.MDC_MEMORY_PYTHON_SOURCE ?? fileURLToPath(new URL('../../../../vendor/basic-memory', import.meta.url));
  const dataDir = process.env.MDC_MEMORY_TEST_DATA_DIR ?? join(tmpdir(), 'mdc-memory-real-test');
  const seed = process.env.MDC_MEMORY_TEST_MODEL_CACHE;
  const modelCache = join(dataDir, 'fastembed_cache');
  if (seed && !existsSync(join(modelCache, MODEL_DIR))) cpSync(seed, modelCache, { recursive: true });
  return { pythonSource, dataDir };
}

function dshPackages() {
  if (process.env.DSH_PKGS) return process.env.DSH_PKGS;
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
}

/**
 * The dsh process facts the Host row runs under, set up as the launcher does:
 * the proxy policy installed from the environment (it appends dsh's loopback
 * bypass entries, `[::1]` included, to NO_PROXY), the real `subprocess`
 * service, the real `storageDomain` service persisting JSON files under
 * `storageRoot` like dsh's own `storages` directory, and dsh's tool registry,
 * system prompt and skill registry services behind an agent scopes adapter
 * (see agent-plane.js). Agent contexts are minted as dsh's AgentLoop mints
 * them: from a context declaring AgentLoop's own `inject` list (as far as this
 * composition provides it), so they reach no other service, the skill
 * registry included. Disposing and mounting again over the same root behaves
 * like a dsh restart. dsh exits on an unhandled promise rejection (a fatal
 * load failure), so disposing rethrows the first one raised meanwhile.
 * @param {{ storageRoot: string }} options
 * @returns {Promise<{ subprocess: object, real: object, spawned: object[], storageDomain: object, agentScopes: object, dispose: () => Promise<void> }>}
 *   `subprocess` records every spawn spec in `spawned`; `real` is the unwrapped service.
 */
export async function realDsh({ storageRoot }) {
  const unhandled = [];
  const recordUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', recordUnhandled);
  const pkgs = dshPackages();
  const load = (name) => import(pathToFileURL(join(pkgs, name, 'lib', 'index.js')).href);
  const { installProxyFromEnvironment } = await load('dsh-http-proxy');
  const uninstallProxy = await installProxyFromEnvironment(
    { get: (name) => (process.env[name] === undefined ? undefined : { value: process.env[name] }) },
    (message) => console.warn(`dsh proxy: ${message}`),
  );
  const { Context } = await load('cordis');
  const systemPrompt = await load('dsh-system-prompt');
  const root = new Context();
  const fibers = [
    root.plugin((await load('dsh-subprocess-local')).default),
    root.plugin((await load('dsh-storage')).default),
    root.plugin(await load('dsh-storage-json'), { root: storageRoot }),
    root.plugin(await load('dsh-storage-domain'), { backend: 'json' }),
    root.plugin(systemPrompt.default, {}),
    root.plugin((await load('dsh-tools')).default, {}),
    root.plugin((await load('dsh-skill')).default, {}),
  ];
  await Promise.all(fibers);
  const { AgentLoop } = await load('dsh-agent-loop');
  const loopServices = AgentLoop.inject.filter((name) => root.get(name) !== undefined);
  const agentLoop = await new Promise((resolve) => root.inject(loopServices, (ctx) => { resolve(ctx); }));
  const real = root.get('subprocess');
  const spawned = [];
  return {
    real,
    spawned,
    subprocess: {
      resolveExecutable: (...args) => real.resolveExecutable(...args),
      spawn(spec) {
        spawned.push(spec);
        return real.spawn(spec);
      },
    },
    storageDomain: root.get('storageDomain'),
    agentScopes: realAgentScopes(agentLoop, root.get('skills'), systemPrompt.renderPrompt, await load('dsh-scope')),
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await uninstallProxy();
      process.off('unhandledRejection', recordUnhandled);
      if (unhandled.length > 0) throw unhandled[0];
    },
  };
}

/**
 * Agent scopes minted by dsh-scope from the AgentLoop-like context `loop`,
 * over dsh's real tool registry and system prompt. Skills are read the way
 * dsh's `skill` tool reads them for the calling agent: the skill registry
 * viewed from the agent's scope.
 */
function realAgentScopes(loop, skills, renderPrompt, { createScope }) {
  const assemble = (agent) => loop.systemPrompt.assemble({ scope: agent });
  return {
    services: { tools: loop.tools, systemPrompt: loop.systemPrompt, skills },
    open(agent, { parent } = {}) {
      const scope = createScope(loop, agent, parent ? { parent } : {});
      return { ctx: scope.ctx, dispose: () => scope.dispose() };
    },
    schemas: async (agent) => (await assemble(agent)).tools,
    prompt: async (agent) => renderPrompt(await assemble(agent)),
    async call(agent, name, args) {
      const result = await loop.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal });
      return { isError: result.isError, text: result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') };
    },
    async skills(agent) {
      return (await skills.list({ scope: agent })).filter((skill) => skill.invocation.modelInvocable).map((skill) => skill.name);
    },
    skill: (agent, name) => skills.get(name, { scope: agent }),
  };
}
