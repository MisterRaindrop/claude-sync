export interface SearchFilter {
  folders?: string[];
  excludeFolders?: string[];
  limit?: number;
}

export interface VaultFileJSON {
  content: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  path: string;
}

export interface SyncStatus {
  lastSync: string | null;
  head: string | null;
  dirty: boolean;
  syncing: boolean;
}

export type TargetType = 'frontmatter' | 'heading' | 'block';
export type PatchOperation = 'append' | 'prepend' | 'replace';
export type ContentType = 'text/markdown' | 'application/json';

export interface SearchResult {
  filename: string;
  score: number;
  matches: Array<{ match: { start: number; end: number; source: string }; context: string }>;
}

export interface SimpleSearchResult {
  filename: string;
  score: number;
  matches: Array<{ match: { start: number; end: number; source: string }; context: string }>;
}
