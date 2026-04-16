import {
  readFile, readFileJSON, listFiles, writeFile, appendFile, deleteFile, onFileChange,
} from './vault.js';
import { searchSmart, searchSimple, updateIndex, removeFromIndex } from './search.js';
import { scheduleSync, getSyncStatus } from './git-sync.js';
import { patchFile } from './patch.js';
import type { SearchFilter, ContentType, PatchOperation, TargetType } from './types.js';

// Wire up file change listeners
onFileChange((filename, action) => {
  if (action === 'write') {
    // Read file content for index update (async, fire-and-forget)
    readFile(filename).then(content => updateIndex(filename, content)).catch(() => {});
  } else {
    removeFromIndex(filename);
  }
  scheduleSync();
});

// ── Tool Definitions ──────────────────────────────────────────────

export const toolsList = [
  {
    name: 'get_server_info',
    description: 'Returns basic details about the claude-sync server and sync status.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_vault_file',
    description: 'Get the content of a file from your vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string' },
        format: { anyOf: [{ const: 'json' }, { const: 'markdown' }] },
      },
      required: ['filename'],
    },
  },
  {
    name: 'list_vault_files',
    description: 'List files in the root directory or a specified subdirectory of your vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        directory: { type: 'string' },
      },
    },
  },
  {
    name: 'search_vault_smart',
    description: 'Search for documents semantically matching a text string.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { description: 'A search phrase for semantic search', minLength: 1, type: 'string' },
        filter: {
          type: 'object',
          properties: {
            folders: { description: 'An array of folder names to include.', items: { type: 'string' }, type: 'array' },
            excludeFolders: { description: 'An array of folder names to exclude.', items: { type: 'string' }, type: 'array' },
            limit: { description: 'The maximum number of results to return', exclusiveMinimum: 0, type: 'number' },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_vault_simple',
    description: 'Search for documents matching a text query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        contextLength: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_vault_file',
    description: 'Create a new file in your vault or update an existing one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['content', 'filename'],
    },
  },
  {
    name: 'append_to_vault_file',
    description: 'Append content to a new or existing file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['content', 'filename'],
    },
  },
  {
    name: 'patch_vault_file',
    description: 'Insert or modify content in a file relative to a heading, block reference, or frontmatter field.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string' },
        content: { description: 'The actual content to insert, append, or use as replacement', type: 'string' },
        contentType: {
          anyOf: [
            { const: 'application/json', description: 'Format of the content' },
            { const: 'text/markdown', description: 'Format of the content' },
          ],
        },
        operation: {
          anyOf: [{ const: 'append' }, { const: 'prepend' }, { const: 'replace' }],
        },
        target: {
          description: "The identifier - heading path, block reference ID, or frontmatter field name",
          type: 'string',
        },
        targetDelimiter: {
          description: "The separator used in heading paths (default '::')",
          type: 'string',
        },
        targetType: {
          anyOf: [{ const: 'block' }, { const: 'frontmatter' }, { const: 'heading' }],
        },
        trimTargetWhitespace: {
          anyOf: [{ type: 'boolean' }],
          description: 'Whether to remove whitespace from target identifier before matching',
        },
      },
      required: ['content', 'filename', 'operation', 'target', 'targetType'],
    },
  },
  {
    name: 'delete_vault_file',
    description: 'Delete a file from your vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string' },
      },
      required: ['filename'],
    },
  },
];

// ── Tool Response Helper ──────────────────────────────────────────

type ToolResponse = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResponse {
  return { content: [{ type: 'text', text }], isError: true };
}

// ── Tool Handlers ─────────────────────────────────────────────────

async function handleGetServerInfo(): Promise<ToolResponse> {
  const status = getSyncStatus();
  return ok(JSON.stringify({
    status: 'ok',
    service: 'claude-sync',
    version: '1.0.0',
    authenticated: true,
    sync: status,
  }, null, 2));
}

async function handleGetVaultFile(args: Record<string, unknown>): Promise<ToolResponse> {
  const filename = args.filename as string;
  const format = args.format as string | undefined;

  if (format === 'json') {
    const result = await readFileJSON(filename);
    return ok(JSON.stringify(result, null, 2));
  }

  const content = await readFile(filename);
  return ok(content);
}

async function handleListVaultFiles(args: Record<string, unknown>): Promise<ToolResponse> {
  const directory = args.directory as string | undefined;
  const files = await listFiles(directory);
  return ok(JSON.stringify(files, null, 2));
}

async function handleSearchSmart(args: Record<string, unknown>): Promise<ToolResponse> {
  const query = args.query as string;
  const filter = args.filter as SearchFilter | undefined;
  const results = await searchSmart(query, filter);
  return ok(JSON.stringify(results, null, 2));
}

async function handleSearchSimple(args: Record<string, unknown>): Promise<ToolResponse> {
  const query = args.query as string;
  const contextLength = args.contextLength as number | undefined;
  const results = await searchSimple(query, contextLength);
  return ok(JSON.stringify(results, null, 2));
}

async function handleCreateVaultFile(args: Record<string, unknown>): Promise<ToolResponse> {
  const filename = args.filename as string;
  const content = args.content as string;
  await writeFile(filename, content);
  return ok(`Created: ${filename}`);
}

async function handleAppendToVaultFile(args: Record<string, unknown>): Promise<ToolResponse> {
  const filename = args.filename as string;
  const content = args.content as string;
  await appendFile(filename, content);
  return ok(`Appended to: ${filename}`);
}

async function handlePatchVaultFile(args: Record<string, unknown>): Promise<ToolResponse> {
  const filename = args.filename as string;
  const target = args.target as string;
  const targetType = args.targetType as TargetType;
  const operation = args.operation as PatchOperation;
  const content = args.content as string;
  const contentType = args.contentType as ContentType | undefined;
  const targetDelimiter = args.targetDelimiter as string | undefined;
  const trimTargetWhitespace = args.trimTargetWhitespace as boolean | undefined;

  const fileContent = await readFile(filename);
  const patched = patchFile(fileContent, targetType, target, operation, content, contentType, targetDelimiter, trimTargetWhitespace);
  await writeFile(filename, patched);
  return ok(`Patched: ${filename} (${targetType}:${target} ${operation})`);
}

async function handleDeleteVaultFile(args: Record<string, unknown>): Promise<ToolResponse> {
  const filename = args.filename as string;
  await deleteFile(filename);
  return ok(`Deleted: ${filename}`);
}

// ── Dispatch ──────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResponse> {
  try {
    switch (name) {
      case 'get_server_info': return await handleGetServerInfo();
      case 'get_vault_file': return await handleGetVaultFile(args);
      case 'list_vault_files': return await handleListVaultFiles(args);
      case 'search_vault_smart': return await handleSearchSmart(args);
      case 'search_vault_simple': return await handleSearchSimple(args);
      case 'create_vault_file': return await handleCreateVaultFile(args);
      case 'append_to_vault_file': return await handleAppendToVaultFile(args);
      case 'patch_vault_file': return await handlePatchVaultFile(args);
      case 'delete_vault_file': return await handleDeleteVaultFile(args);
      default: return err(`unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(`${name} failed: ${msg}`);
  }
}
