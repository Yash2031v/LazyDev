/**
 * LazyDev Project Service
 * Coordinates project root selection, cached scan results, file reading, and bounded text search.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProjectSummary,
  ScanLimits,
  ScanResult,
  SearchOptions,
  SearchResult,
  SearchMatch
} from './types.js';
import { validateProjectRoot, resolveSafeRelativePath, PathValidationError } from './path-validator.js';
import { IgnoreEngine } from './ignore-rules.js';
import { CodebaseScanner, DEFAULT_SCAN_LIMITS } from './scanner.js';
import { isBinaryFile } from './binary-detector.js';

export class ProjectAccessError extends Error {
  constructor(message: string) {
    super(`[LazyDev Access Error] ${message}`);
    this.name = 'ProjectAccessError';
  }
}

export interface ReadFileResult {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly modifiedTime: string;
}

export class ProjectService {
  private canonicalRoot: string | null = null;
  private ignoreEngine: IgnoreEngine | null = null;
  private cachedScan: ScanResult | null = null;
  private scanLimits: ScanLimits = { ...DEFAULT_SCAN_LIMITS };

  /**
   * Returns whether a project is currently configured and active.
   */
  hasActiveProject(): boolean {
    return this.canonicalRoot !== null;
  }

  /**
   * Returns current active canonical root path, or null if unset.
   */
  getProjectRoot(): string | null {
    return this.canonicalRoot;
  }

  /**
   * Sets and scans a new project root.
   */
  async setProjectRoot(candidatePath: string, customLimits?: Partial<ScanLimits>): Promise<ScanResult> {
    const canonical = await validateProjectRoot(candidatePath);

    this.scanLimits = {
      maxFiles: customLimits?.maxFiles ?? DEFAULT_SCAN_LIMITS.maxFiles,
      maxDepth: customLimits?.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth,
      maxFileSizeBytes: customLimits?.maxFileSizeBytes ?? DEFAULT_SCAN_LIMITS.maxFileSizeBytes
    };

    const ignoreEngine = await IgnoreEngine.loadForRoot(canonical);
    const scanner = new CodebaseScanner(canonical, ignoreEngine, this.scanLimits);
    const scanResult = await scanner.scan();

    this.canonicalRoot = canonical;
    this.ignoreEngine = ignoreEngine;
    this.cachedScan = scanResult;

    return scanResult;
  }

  /**
   * Re-scans current active project root.
   */
  async rescan(): Promise<ScanResult> {
    if (!this.canonicalRoot || !this.ignoreEngine) {
      throw new ProjectAccessError('No active project root set.');
    }

    const scanner = new CodebaseScanner(this.canonicalRoot, this.ignoreEngine, this.scanLimits);
    const scanResult = await scanner.scan();
    this.cachedScan = scanResult;
    return scanResult;
  }

  /**
   * Retrieves latest cached scan result, or runs scan if unset.
   */
  async getScanResult(): Promise<ScanResult> {
    if (!this.canonicalRoot) {
      throw new ProjectAccessError('No active project root set.');
    }
    if (!this.cachedScan) {
      return this.rescan();
    }
    return this.cachedScan;
  }

  /**
   * Returns a high-level summary of the active project structure and file types.
   */
  async getSummary(): Promise<ProjectSummary> {
    const scan = await this.getScanResult();
    const fileTypes: Record<string, number> = {};
    let totalSizeBytes = 0;
    const topDirSet = new Set<string>();

    for (const file of scan.files) {
      totalSizeBytes += file.sizeBytes;
      const ext = file.extension || '(no extension)';
      fileTypes[ext] = (fileTypes[ext] || 0) + 1;

      const slashIndex = file.relativePath.indexOf('/');
      if (slashIndex !== -1) {
        topDirSet.add(file.relativePath.slice(0, slashIndex));
      }
    }

    return {
      rootPath: scan.canonicalRootPath,
      totalFiles: scan.files.length,
      totalSizeBytes,
      fileTypes,
      topDirectories: Object.freeze(Array.from(topDirSet).sort()),
      skippedCount: scan.skippedFiles.length,
      warnings: scan.warnings
    };
  }

  /**
   * Reads the content of a permitted text file inside the project root.
   * Rejects secret files, binary files, oversized files, and traversal attempts.
   */
  async readFile(relativePath: string): Promise<ReadFileResult> {
    if (!this.canonicalRoot || !this.ignoreEngine) {
      throw new ProjectAccessError('No active project root set.');
    }

    const { canonicalPath, normalizedRelative } = await resolveSafeRelativePath(
      this.canonicalRoot,
      relativePath,
      true
    );

    // 1. Strictly forbid reading files matching secret patterns
    if (this.ignoreEngine.isSecret(normalizedRelative)) {
      throw new ProjectAccessError(`Access denied: "${normalizedRelative}" is protected as a secret credential.`);
    }

    // 2. Check general ignore engine rules
    const ignoreCheck = this.ignoreEngine.shouldIgnore(normalizedRelative, false);
    if (ignoreCheck.ignored) {
      throw new ProjectAccessError(`Access denied: "${normalizedRelative}" is an excluded path.`);
    }

    // 3. Size check
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) {
      throw new ProjectAccessError(`Path "${normalizedRelative}" is not a file.`);
    }

    if (stat.size > this.scanLimits.maxFileSizeBytes) {
      throw new ProjectAccessError(
        `File "${normalizedRelative}" (${stat.size} bytes) exceeds the maximum allowed size of ${this.scanLimits.maxFileSizeBytes} bytes.`
      );
    }

    // 4. Binary file check
    if (await isBinaryFile(canonicalPath)) {
      throw new ProjectAccessError(`File "${normalizedRelative}" is a binary file and cannot be read as text.`);
    }

    const content = await fs.readFile(canonicalPath, 'utf-8');

    return {
      relativePath: normalizedRelative,
      content,
      sizeBytes: stat.size,
      modifiedTime: stat.mtime.toISOString()
    };
  }

  /**
   * Searches for a text query across all permitted project text files.
   */
  async searchFiles(options: SearchOptions): Promise<SearchResult> {
    if (!this.canonicalRoot) {
      throw new ProjectAccessError('No active project root set.');
    }

    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new PathValidationError('Search query must be a non-empty string.');
    }

    if (options.query.length > 200) {
      throw new PathValidationError('Search query exceeds maximum length of 200 characters.');
    }

    const scan = await this.getScanResult();
    const caseSensitive = options.caseSensitive ?? false;
    const maxResults = Math.min(Math.max(options.maxResults ?? 100, 1), 500);
    const searchQuery = caseSensitive ? options.query : options.query.toLowerCase();

    const matches: SearchMatch[] = [];
    let limitReached = false;

    for (const file of scan.files) {
      if (matches.length >= maxResults) {
        limitReached = true;
        break;
      }

      const filePath = path.join(this.canonicalRoot, file.relativePath);

      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) {
          limitReached = true;
          break;
        }

        const line = lines[i] ?? '';
        const targetLine = caseSensitive ? line : line.toLowerCase();

        if (targetLine.includes(searchQuery)) {
          // Bounded line content length to avoid massive payloads
          const trimmed = line.length > 300 ? line.slice(0, 300) + '...' : line;
          matches.push({
            relativePath: file.relativePath,
            lineNumber: i + 1,
            lineContent: trimmed
          });
        }
      }
    }

    return {
      query: options.query,
      totalMatches: matches.length,
      matches: Object.freeze(matches),
      limitReached
    };
  }
}
