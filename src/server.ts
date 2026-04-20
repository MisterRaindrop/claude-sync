#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolsList, handleToolCall } from './tools.js';
import { buildIndex } from './search.js';
import { startSync, flushSync } from './git-sync.js';

const server = new Server(
  { name: 'claude-sync', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsList,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  return handleToolCall(req.params.name, req.params.arguments ?? {});
});

async function main(): Promise<void> {
  process.stderr.write('claude-sync: starting...\n');

  await startSync();
  process.stderr.write('claude-sync: git sync initialized\n');

  await buildIndex();
  process.stderr.write('claude-sync: search index built\n');

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('claude-sync: server ready\n');
}

// Graceful shutdown: flush pending git sync before exit.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write('claude-sync: shutting down, flushing pending sync...\n');
  try {
    await flushSync();
  } catch (err) {
    process.stderr.write(`claude-sync: flush failed: ${err}\n`);
  }
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

main().catch(err => {
  process.stderr.write(`claude-sync: fatal: ${err}\n`);
  process.exit(1);
});
