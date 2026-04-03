/**
 * LLM-nexus MCP Server
 *
 * Exposes proxy observability and control as MCP tools so any MCP-compatible
 * AI agent (Claude Desktop, custom agents, etc.) can interact with this proxy.
 *
 * Transport: stdio  (standard MCP convention)
 * Talks to the dashboard HTTP API on localhost:3001 (or DASHBOARD_PORT).
 *
 * Usage:
 *   node backend/mcp/server.js
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "llm-nexus": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/LLM-nexus/backend/mcp/server.js"]
 *       }
 *     }
 *   }
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http = require('http');

const DASHBOARD_PORT = process.env.DASHBOARD_PORT ?? 3001;
const BASE_URL = `http://localhost:${DASHBOARD_PORT}`;

// ---------------------------------------------------------------------------
// HTTP helper — calls the dashboard REST API
// ---------------------------------------------------------------------------
function apiCall(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${path}`, { method }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${path}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'llm-nexus',
  version: '1.0.0',
});

// ── Tool: get_logs ──────────────────────────────────────────────────────────
server.registerTool(
  'get_logs',
  {
    description: 'Retrieve already-processed proxy logs. Optionally filter by type, keyword query, or limit count.',
    inputSchema: {
      type:  z.enum(['llm', 'cache_hit', 'simple_op']).optional()
                .describe('Filter by log type'),
      query: z.string().optional()
                .describe('Keyword to search across all log fields'),
      limit: z.number().int().min(1).max(200).default(50)
                .describe('Maximum number of entries to return (default 50)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ type, query, limit }) => {
    const params = new URLSearchParams();
    if (type)  params.set('type', type);
    if (query) params.set('query', query);
    params.set('limit', String(limit ?? 50));
    const logs = await apiCall(`/api/logs?${params}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
    };
  }
);

// ── Tool: get_stats ─────────────────────────────────────────────────────────
server.registerTool(
  'get_stats',
  {
    description: 'Get aggregate statistics over already-processed requests: total calls, tokens used, cache hits, and average latency.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const stats = await apiCall('/api/stats');
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    };
  }
);

// ── Tool: get_cache_info ────────────────────────────────────────────────────
server.registerTool(
  'get_cache_info',
  {
    description: 'Inspect the in-memory prompt cache built from already-processed requests: entry count, similarity threshold, and key previews.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const info = await apiCall('/api/cache');
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }
);

// ── Tool: search_logs ───────────────────────────────────────────────────────
server.registerTool(
  'search_logs',
  {
    description: 'Full-text search across already-processed proxy log entries.',
    inputSchema: {
      query: z.string().min(1).describe('Search term (case-insensitive)'),
      type:  z.enum(['llm', 'cache_hit', 'simple_op']).optional()
                .describe('Optionally restrict search to one log type'),
      limit: z.number().int().min(1).max(200).default(20)
                .describe('Maximum results to return'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, type, limit }) => {
    const params = new URLSearchParams({ query, limit: String(limit ?? 20) });
    if (type) params.set('type', type);
    const logs = await apiCall(`/api/logs?${params}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP uses stdio — don't write anything to stdout (it breaks the protocol).
  // Log only to stderr so the host can capture it if needed.
  process.stderr.write('LLM-nexus MCP server started (stdio)\n');
}

main().catch(err => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
