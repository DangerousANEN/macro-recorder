#!/usr/bin/env node
// MCP stdio server. Wraps the local Macro Recorder HTTP API so an LLM agent can
// list / inspect / run macros over MCP.
//
// Configure with MCP_RECORDER_URL (default http://127.0.0.1:3700).
// Connect a client (Claude Desktop, Devin, Cursor) by pointing it at the
// `macro-recorder-mcp` binary or `node mcp/index.js`.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.MCP_RECORDER_URL || 'http://127.0.0.1:3700').replace(/\/$/, '');

// Each tool: name, description, inputSchema, and handler returning JSON-serialisable data.
const TOOLS = [
  {
    name: 'list_macros',
    description: 'List all saved macros (id, name, step count).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await getJson('/api/macros');
      return Array.isArray(data)
        ? data.map(m => ({ id: m.id, name: m.name, stepCount: Array.isArray(m.steps) ? m.steps.length : 0 }))
        : data;
    },
  },
  {
    name: 'get_macro',
    description: 'Fetch a single macro by id, returning the full JSON (steps, settings, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Macro id (UUID).' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id }) => getJson(`/api/macros/${encodeURIComponent(id)}`),
  },
  {
    name: 'run_macro',
    description: 'Run a macro. Use fromStep+toStep to run a slice (toStep alone = "run up to step toStep"; fromStep == toStep = "run only that single step").',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        fromStep: { type: 'integer', minimum: 0 },
        toStep: { type: 'integer', minimum: 0 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id, fromStep, toStep }) => {
      const enc = encodeURIComponent(id);
      // Single-step execution
      if (Number.isInteger(fromStep) && Number.isInteger(toStep) && fromStep === toStep) {
        return postJson(`/api/macros/${enc}/steps/${fromStep}/run`, {});
      }
      // Run up to a specific step
      if (Number.isInteger(toStep)) {
        return postJson(`/api/macros/${enc}/run-to/${toStep}`, {});
      }
      // Full run
      return postJson(`/api/macros/${enc}/run`, fromStep != null ? { fromStep } : {});
    },
  },
  {
    name: 'stop_macro',
    description: 'Stop a currently running macro by its runId (from list_running).',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async ({ runId }) => postJson(`/api/running/${encodeURIComponent(runId)}/stop`, {}),
  },
  {
    name: 'list_running',
    description: 'List currently running macros with their status, type, and start time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => getJson('/api/running'),
  },
  {
    name: 'list_blocks',
    description: 'List all available block (action) types. Useful to know what step.action values exist when constructing a macro.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => getJson('/api/blocks'),
  },
  {
    name: 'export_macro',
    description: 'Export a macro as JSON (same shape as the editor download).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id }) => getJson(`/api/macros/${encodeURIComponent(id)}/export`),
  },
  {
    name: 'import_macro',
    description: 'Import a macro JSON (with steps[], optional name). Returns {id, name} of the saved macro.',
    inputSchema: {
      type: 'object',
      properties: {
        macro: { type: 'object', description: 'Macro JSON. Must include steps array. id will be regenerated.' },
      },
      required: ['macro'],
      additionalProperties: false,
    },
    handler: async ({ macro }) => postJson('/api/macros/import', macro),
  },

  // === Agent debugging tools ===========================================
  {
    name: 'get_run_events',
    description: 'Return structured progress events for a running (or recently finished) macro. Use `since` to poll incrementally — only events with seq > since are returned. Replaces "watch the WebSocket"; lets the agent see step-completed, click-failed, fill-failed, var-saved, debug-dump, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        since: { type: 'integer', minimum: 0, default: 0, description: 'Last seq seen; 0 = full history.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async ({ runId, since }) => {
      const q = since ? `?since=${encodeURIComponent(since)}` : '';
      return getJson(`/api/running/${encodeURIComponent(runId)}/events${q}`);
    },
  },
  {
    name: 'get_last_failure',
    description: 'Return the most recent failure event for a run (or null). Includes which selectors were tried, the underlying error, and the step path. Use this first when a run errors — much cheaper than scanning the full event log.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async ({ runId }) => getJson(`/api/running/${encodeURIComponent(runId)}/failures?last=1`),
  },
  {
    name: 'inspect_running_page',
    description: 'Snapshot the live Playwright page of a running macro: URL, title, readyState, cookie names, and a structured DOM outline (tag/id/classes/text/visible/children) truncated by depth and node count. Lets the agent see what the page actually contains without taking screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        maxNodes: { type: 'integer', minimum: 10, maximum: 1000, default: 200 },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async ({ runId, depth, maxNodes }) => {
      const params = new URLSearchParams();
      if (depth != null) params.set('depth', String(depth));
      if (maxNodes != null) params.set('maxNodes', String(maxNodes));
      const q = params.toString() ? `?${params}` : '';
      return getJson(`/api/running/${encodeURIComponent(runId)}/inspect${q}`);
    },
  },
  {
    name: 'query_dom',
    description: 'Query the live page of a running macro for elements matching a selector. kind = "css"|"xpath"|"placeholder"|"role". Returns up to `limit` matches with tag/id/classes/text/box/visible/attrs so the agent can pick the right selector before patching the macro.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        selector: { type: 'string' },
        kind: { type: 'string', enum: ['css', 'xpath', 'placeholder', 'role'], default: 'css' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['runId', 'selector'],
      additionalProperties: false,
    },
    handler: async ({ runId, selector, kind, limit }) =>
      postJson(`/api/running/${encodeURIComponent(runId)}/query-dom`, { selector, kind, limit }),
  },
  {
    name: 'patch_step',
    description: 'Surgically update one step inside a macro by stepPath (e.g. "3" or "2.children.0"). The patch object is shallow-merged into the target step. Useful for adding fallbackSelectors, fixing a cssSelector, or tweaking timeouts without rewriting the whole macro.',
    inputSchema: {
      type: 'object',
      properties: {
        macroId: { type: 'string' },
        stepPath: { type: 'string', description: 'Dot-delimited path: "3" = step index 3; "2.children.0" = first child of step 2.' },
        patch: { type: 'object', additionalProperties: true },
      },
      required: ['macroId', 'stepPath', 'patch'],
      additionalProperties: false,
    },
    handler: async ({ macroId, stepPath, patch }) => {
      const url = `/api/macros/${encodeURIComponent(macroId)}/steps/${encodeURIComponent(stepPath)}`;
      const r = await fetch(BASE + url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`PATCH ${url} → HTTP ${r.status} ${t}`);
      }
      return r.json();
    },
  },
];

async function getJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
}

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`POST ${path} → HTTP ${r.status} ${text}`);
  }
  // Some endpoints return empty body on success.
  const text = await r.text();
  try { return text ? JSON.parse(text) : { ok: true }; }
  catch { return { ok: true, body: text }; }
}

const server = new Server(
  { name: 'macro-recorder-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Stdout is reserved for MCP framing; logs go to stderr.
console.error(`[macro-recorder-mcp] ready, base=${BASE}`);
