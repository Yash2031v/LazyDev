/**
 * LazyDev Project Indexer & Read-Only Tools Types
 */

export interface ProjectFileInfo {
  readonly relativePath: string;
  readonly name: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly modifiedTime: string;
  readonly isText: boolean;
}

export interface SkippedFileInfo {
  readonly relativePath: string;
  readonly reason: 'secret' | 'binary' | 'oversized' | 'ignored' | 'symlink_escape' | 'error';
  readonly details?: string;
}

export interface ScanLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxFileSizeBytes: number;
}

export interface ScanResult {
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly scannedAt: string;
  readonly totalFilesScanned: number;
  readonly files: readonly ProjectFileInfo[];
  readonly skippedFiles: readonly SkippedFileInfo[];
  readonly warnings: readonly string[];
  readonly limitReached: boolean;
}

export interface ProjectSummary {
  readonly rootPath: string;
  readonly totalFiles: number;
  readonly totalSizeBytes: number;
  readonly fileTypes: Record<string, number>;
  readonly topDirectories: readonly string[];
  readonly skippedCount: number;
  readonly warnings: readonly string[];
}

export interface SearchMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
}

export interface SearchOptions {
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
}

export interface SearchResult {
  readonly query: string;
  readonly totalMatches: number;
  readonly matches: readonly SearchMatch[];
  readonly limitReached: boolean;
}
