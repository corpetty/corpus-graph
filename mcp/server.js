#!/usr/bin/env node
// Optional MCP server — exposes the graph to an agent/IDE as two tools:
//   list_centers(profile?, type?)            -> resolvable node ids + labels
//   get_bundle(center, profile?, hop?, ...)  -> the rendered Markdown packet
//
// Opt-in: requires `npm i @modelcontextprotocol/sdk`. The CLI (`corpus-graph
// context`) needs none of this. Run: `node mcp/server.js` (stdio transport).
import { loadContext } from '../core/lib/config.js';
import { buildGraph, emit } from '../core/build-graph.js';
import { buildBundle, loadGraph } from '../core/context-bundle.js';

let Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server } = await import('@modelcontextprotocol/sdk/server/index.js'));
  ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js'));
} catch {
  console.error(
    'corpus-graph MCP server needs the SDK. Install it:\n  npm install @modelcontextprotocol/sdk\n',
  );
  process.exit(1);
}

// Rebuild (sub-second) so the served graph always reflects current inputs.
function freshContext(profile) {
  const ctx = loadContext(profile || undefined);
  emit(ctx, buildGraph(ctx));
  return ctx;
}

const TOOLS = [
  {
    name: 'list_centers',
    description:
      'List resolvable node ids (and labels) for a corpus-graph profile, to pick a center for get_bundle. Optionally filter by node type.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Profile name (default: software-docs / $PROFILE).' },
        type: { type: 'string', description: 'Optional node-type filter, e.g. "Decision".' },
      },
    },
  },
  {
    name: 'get_bundle',
    description:
      'Return a citeable, bounded Markdown context bundle for a center node: its claims/decisions with verbatim source evidence, open questions, related nodes, and editorial flags. Paste this into a drafting/review session.',
    inputSchema: {
      type: 'object',
      required: ['center'],
      properties: {
        center: { type: 'string', description: 'Center node id or slug, e.g. "decision:immutable-cache-keys".' },
        profile: { type: 'string', description: 'Profile name (default: software-docs / $PROFILE).' },
        hop: { type: 'number', description: 'BFS radius (default from render-spec, usually 2). Use 1 for a tighter packet.' },
        tokenBudget: { type: 'number', description: 'Soft token budget (default from render-spec).' },
      },
    },
  },
];

const server = new Server({ name: 'corpus-graph', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    if (name === 'list_centers') {
      const ctx = freshContext(a.profile);
      const { nodeById } = loadGraph(ctx);
      const rows = [...nodeById.values()]
        .filter((n) => !a.type || n.type === a.type)
        .map((n) => `${n.id}\t${n.type}\t${n.label || n.title || ''}`);
      return { content: [{ type: 'text', text: rows.join('\n') || '(no nodes)' }] };
    }
    if (name === 'get_bundle') {
      const ctx = freshContext(a.profile);
      const opts = {};
      if (a.hop != null) opts.hop = Number(a.hop);
      if (a.tokenBudget != null) opts.tokenBudget = Number(a.tokenBudget);
      const res = buildBundle(ctx, a.center, opts);
      return {
        content: [{ type: 'text', text: res.text }],
        // surface the budget signal so the agent can re-request at a lower hop
        _meta: { tokens: res.tokens, nodesInScope: res.nodesInScope, hop: res.hop, overBudget: res.overBudget },
      };
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error('corpus-graph MCP server running on stdio');
