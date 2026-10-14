/**
 * One basic-memory MCP tool offered to agents as a native dsh tool (ADR 0002).
 * The proxy, not basic-memory, decides which project a call works in: the
 * upstream routing parameters are withheld from the model, `project` is
 * described by the proxy, and every call is resolved against the effective
 * knowledge bases before it is forwarded with an explicit `project`.
 */
import { MemoryToolError } from './errors.js';

export const TOOL_NAME_PREFIX = 'memory_';

/** Upstream parameters that select the project(s) a call works in; the proxy alone sets `project`. */
const ROUTING_PARAMETERS = new Set(['project', 'project_id', 'projects', 'search_all_projects', 'workspace']);

const PROJECT_PARAMETER = Object.freeze({
  type: 'string',
  description: 'Name of the knowledge base to work in. May be omitted while exactly one knowledge base is enabled; required when several are.',
});

/** The MCP result contract, as dsh's own MCP bridge declares it. */
const OUTPUT = Object.freeze({
  schema: {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: textOf(value.content) }],
});

/**
 * Whether an upstream tool works inside one project, the only kind the proxy
 * can scope to a knowledge base.
 * @param {import('../basic-memory/client.js').McpTool} tool
 */
export function isProjectScoped(tool) {
  return Object.hasOwn(tool.inputSchema?.properties ?? {}, 'project');
}

/**
 * @param {import('../basic-memory/client.js').McpTool} upstream - a project-scoped tool.
 * @param {object} deps
 * @param {ReturnType<typeof import('./target.js').createTargetResolver>} deps.target
 * @param {ReturnType<typeof import('../basic-memory/client.js').createBasicMemoryClient>} deps.basicMemory
 * @returns {object} the dsh tool definition.
 */
export function createProxyTool(upstream, { target, basicMemory }) {
  const parameters = scopedParameters(upstream.inputSchema);
  const accepted = Object.keys(parameters.properties);
  return Object.freeze({
    name: TOOL_NAME_PREFIX + upstream.name,
    description: upstream.description ?? '',
    parameters,
    output: OUTPUT,
    ...(upstream.annotations?.readOnlyHint === true ? { isConcurrencySafe: () => true } : {}),
    async execute(args, exec) {
      const input = args ?? {};
      const unsupported = Object.keys(input).filter((key) => !accepted.includes(key));
      if (unsupported.length > 0) {
        throw new MemoryToolError('unsupported-argument', `Unsupported argument(s): ${unsupported.join(', ')}. Accepted: ${accepted.join(', ')}.`);
      }
      const knowledgeBase = await target.resolve(input, exec.signal);
      const result = await basicMemory.callTool(upstream.name, { ...input, project: knowledgeBase.name }, exec.signal);
      if (result.isError) throw new Error(textOf(result.content));
      return { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
    },
  });
}

/** The upstream input schema with the routing parameters replaced by the proxy's `project`. */
function scopedParameters(inputSchema) {
  const properties = Object.fromEntries(Object.entries(inputSchema.properties).flatMap(([name, schema]) => {
    if (name === 'project') return [[name, PROJECT_PARAMETER]];
    return ROUTING_PARAMETERS.has(name) ? [] : [[name, schema]];
  }));
  const required = (inputSchema.required ?? []).filter((name) => !ROUTING_PARAMETERS.has(name));
  return { ...inputSchema, properties, required };
}

function textOf(content) {
  return (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}
