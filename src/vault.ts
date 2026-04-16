import { readFile as fsReadFile, writeFile as fsWriteFile, unlink, mkdir, readdir, stat } from 'fs/promises';
import { resolve, relative, dirname, join } from 'path';
import matter from 'gray-matter';
import type { VaultFileJSON } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH;
if (!VAULT_PATH) {
  process.stderr.write('claude-sync: VAULT_PATH environment variable is required\n');
  process.exit(1);
}

export function getVaultPath(): string {
  return VAULT_PATH!;
}

export function resolvePath(filename: string): string {
  const full = resolve(VAULT_PATH!, filename);
  const rel = relative(VAULT_PATH!, full);
  if (rel.startsWith('..') || resolve(VAULT_PATH!, rel) !== full) {
    throw new Error(`path traversal rejected: ${filename}`);
  }
  return full;
}

export async function readFile(filename: string): Promise<string> {
  const fullPath = resolvePath(filename);
  return fsReadFile(fullPath, 'utf-8');
}

export function parseVaultFile(content: string, filename: string): VaultFileJSON {
  const parsed = matter(content);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;

  let tags: string[] = [];
  if (Array.isArray(fm.tags)) {
    tags = fm.tags.map(String);
  } else if (typeof fm.tags === 'string') {
    tags = fm.tags.split(',').map((t: string) => t.trim());
  }

  // Extract inline #tags from body
  const inlineTags = [...parsed.content.matchAll(/#([a-zA-Z][\w/-]*)/g)].map(m => m[1]);
  tags = [...new Set([...tags, ...inlineTags])];

  return {
    content: parsed.content,
    frontmatter: fm,
    tags,
    path: filename,
  };
}

export async function readFileJSON(filename: string): Promise<VaultFileJSON> {
  const content = await readFile(filename);
  return parseVaultFile(content, filename);
}

export async function listFiles(directory?: string): Promise<string[]> {
  const base = directory ? resolvePath(directory) : VAULT_PATH!;
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const relPath = relative(VAULT_PATH!, fullPath);
        results.push(relPath);
      }
    }
  }

  try {
    await walk(base);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return results.sort();
}

// Change listeners for git sync and search index
type ChangeListener = (filename: string, action: 'write' | 'delete') => void;
const changeListeners: ChangeListener[] = [];

export function onFileChange(listener: ChangeListener): void {
  changeListeners.push(listener);
}

function notifyChange(filename: string, action: 'write' | 'delete'): void {
  for (const listener of changeListeners) {
    try {
      listener(filename, action);
    } catch {
      // listener errors should not break the write
    }
  }
}

export async function writeFile(filename: string, content: string): Promise<void> {
  const fullPath = resolvePath(filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await fsWriteFile(fullPath, content, 'utf-8');
  notifyChange(filename, 'write');
}

export async function appendFile(filename: string, content: string): Promise<void> {
  const fullPath = resolvePath(filename);
  let existing = '';
  try {
    existing = await fsReadFile(fullPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // File doesn't exist, will create
    await mkdir(dirname(fullPath), { recursive: true });
  }
  await fsWriteFile(fullPath, existing + content, 'utf-8');
  notifyChange(filename, 'write');
}

export async function deleteFile(filename: string): Promise<void> {
  const fullPath = resolvePath(filename);
  await unlink(fullPath);
  notifyChange(filename, 'delete');
}

export async function fileExists(filename: string): Promise<boolean> {
  try {
    const fullPath = resolvePath(filename);
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}
