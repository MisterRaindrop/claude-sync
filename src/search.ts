import FlexSearch from 'flexsearch';
import { listFiles, readFile } from './vault.js';
import type { SearchFilter, SearchResult, SimpleSearchResult } from './types.js';

const { Index } = FlexSearch;

// Simple inverted index: flexsearch Index for content, plus a map for stored data
let index: InstanceType<typeof Index>;
const fileStore = new Map<string, { content: string; path: string }>();

export async function buildIndex(): Promise<void> {
  index = new Index({
    tokenize: 'forward',
    resolution: 9,
  });
  fileStore.clear();

  const files = await listFiles();
  let count = 0;

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = await readFile(file);
      index.add(file, content);
      fileStore.set(file, { content, path: file });
      count++;
    } catch {
      // skip files that can't be read
    }
  }

  process.stderr.write(`claude-sync: indexed ${count} files\n`);
}

export function updateIndex(filename: string, content: string): void {
  if (!index) return;
  if (fileStore.has(filename)) {
    index.update(filename, content);
  } else {
    index.add(filename, content);
  }
  fileStore.set(filename, { content, path: filename });
}

export function removeFromIndex(filename: string): void {
  if (!index) return;
  index.remove(filename);
  fileStore.delete(filename);
}

export async function searchSmart(
  query: string,
  filter?: SearchFilter
): Promise<SearchResult[]> {
  if (!index) {
    await buildIndex();
  }

  const limit = filter?.limit ?? 10;
  // flexsearch Index.search returns string[] (the ids)
  let ids = index.search(query, { limit: limit * 3 }) as string[];

  // Apply folder filters
  if (filter?.folders?.length) {
    ids = ids.filter(id =>
      filter.folders!.some(f => id.startsWith(f + '/') || id.startsWith(f))
    );
  }
  if (filter?.excludeFolders?.length) {
    ids = ids.filter(id =>
      !filter.excludeFolders!.some(f => id.startsWith(f + '/') || id.startsWith(f))
    );
  }

  ids = ids.slice(0, limit);

  const results: SearchResult[] = [];
  for (const id of ids) {
    const stored = fileStore.get(id);
    if (!stored) continue;

    // Find match positions for context
    const lowerContent = stored.content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matches: SearchResult['matches'] = [];

    // filename match
    if (id.toLowerCase().includes(lowerQuery)) {
      const start = id.toLowerCase().indexOf(lowerQuery);
      matches.push({
        match: { start, end: start + query.length, source: 'filename' },
        context: id,
      });
    }

    // content matches (first few)
    let pos = 0;
    let matchCount = 0;
    while ((pos = lowerContent.indexOf(lowerQuery, pos)) !== -1 && matchCount < 5) {
      const ctxStart = Math.max(0, pos - 60);
      const ctxEnd = Math.min(stored.content.length, pos + query.length + 60);
      matches.push({
        match: { start: pos, end: pos + query.length, source: 'content' },
        context: stored.content.substring(ctxStart, ctxEnd),
      });
      pos += query.length;
      matchCount++;
    }

    results.push({
      filename: id,
      score: -(results.length + 1) * 100, // negative so lower = closer match
      matches,
    });
  }

  return results;
}

export async function searchSimple(
  query: string,
  contextLength: number = 100
): Promise<SimpleSearchResult[]> {
  const allFiles = await listFiles();
  const results: SimpleSearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of allFiles) {
    if (!file.endsWith('.md')) continue;

    let content: string;
    // Use cached content if available
    const stored = fileStore.get(file);
    if (stored) {
      content = stored.content;
    } else {
      try {
        content = await readFile(file);
      } catch {
        continue;
      }
    }

    const lowerContent = content.toLowerCase();
    const matches: SimpleSearchResult['matches'] = [];

    // Check filename
    if (file.toLowerCase().includes(lowerQuery)) {
      const start = file.toLowerCase().indexOf(lowerQuery);
      matches.push({
        match: { start, end: start + query.length, source: 'filename' },
        context: file,
      });
    }

    // Check content
    let pos = 0;
    while ((pos = lowerContent.indexOf(lowerQuery, pos)) !== -1) {
      const ctxStart = Math.max(0, pos - contextLength);
      const ctxEnd = Math.min(content.length, pos + query.length + contextLength);
      matches.push({
        match: { start: pos, end: pos + query.length, source: 'content' },
        context: content.substring(ctxStart, ctxEnd),
      });
      pos += query.length;
    }

    if (matches.length > 0) {
      results.push({
        filename: file,
        score: -matches.length * 100,
        matches,
      });
    }
  }

  // Sort by number of matches (most matches first)
  results.sort((a, b) => a.score - b.score);

  return results;
}
