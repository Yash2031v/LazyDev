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
import { isBinaryExtension } from './binary-detector.js';

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
   * Returns active ignore engine for the project, or null if unset.
   */
  getIgnoreEngine(): IgnoreEngine | null {
    return this.ignoreEngine;
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
    const canonical = this.canonicalRoot;
    const ignoreEngine = this.ignoreEngine;
    if (!canonical || !ignoreEngine) {
      throw new ProjectAccessError('No active project root set.');
    }

    const scanner = new CodebaseScanner(canonical, ignoreEngine, this.scanLimits);
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
   * Uses an atomic file handle to prevent time-of-check/time-of-use (TOCTOU) races.
   */
  async readFile(relativePath: string): Promise<ReadFileResult> {
    const canonicalRoot = this.canonicalRoot;
    const ignoreEngine = this.ignoreEngine;
    if (!canonicalRoot || !ignoreEngine) {
      throw new ProjectAccessError('No active project root set.');
    }

    const { canonicalPath, normalizedRelative } = await resolveSafeRelativePath(
      canonicalRoot,
      relativePath,
      true
    );

    // 1. Strictly forbid reading files matching secret patterns
    if (ignoreEngine.isSecret(normalizedRelative)) {
      throw new ProjectAccessError(`Access denied: "${normalizedRelative}" is protected as a secret credential.`);
    }

    // 2. Check general ignore engine rules
    const ignoreCheck = ignoreEngine.shouldIgnore(normalizedRelative, false);
    if (ignoreCheck.ignored) {
      throw new ProjectAccessError(`Access denied: "${normalizedRelative}" is an excluded path.`);
    }

    // Fast-path binary extension check
    if (isBinaryExtension(normalizedRelative)) {
      throw new ProjectAccessError(`File "${normalizedRelative}" is a binary file and cannot be read as text.`);
    }

    // 3. Open single file handle to prevent TOCTOU races between stat, binary probe, and reading
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(canonicalPath, 'r');
      const stat = await handle.stat();

      if (!stat.isFile()) {
        throw new ProjectAccessError(`Path "${normalizedRelative}" is not a file.`);
      }

      if (stat.size > this.scanLimits.maxFileSizeBytes) {
        throw new ProjectAccessError(
          `File "${normalizedRelative}" (${stat.size} bytes) exceeds the maximum allowed size of ${this.scanLimits.maxFileSizeBytes} bytes.`
        );
      }

      // 4. Header null-byte check on the open handle
      const probeSize = Math.min(512, stat.size);
      if (probeSize > 0) {
        const probeBuffer = Buffer.alloc(probeSize);
        const { bytesRead } = await handle.read(probeBuffer, 0, probeSize, 0);
        for (let i = 0; i < bytesRead; i++) {
          if (probeBuffer[i] === 0x00) {
            throw new ProjectAccessError(`File "${normalizedRelative}" is a binary file and cannot be read as text.`);
          }
        }
      }

      // 5. Read validated content from the same handle
      const content = await handle.readFile({ encoding: 'utf-8' });

      return {
        relativePath: normalizedRelative,
        content,
        sizeBytes: stat.size,
        modifiedTime: stat.mtime.toISOString()
      };
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  /**
   * Searches for a text query across all permitted project text files.
   */
  async searchFiles(options: SearchOptions): Promise<SearchResult> {
    const canonicalRoot = this.canonicalRoot;
    if (!canonicalRoot) {
      throw new ProjectAccessError('No active project root set.');
    }

    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new PathValidationError('Search query must be a non-empty string.');
    }

    if (options.query.length > 200) {
      throw new PathValidationError('Search query exceeds maximum length of 200 characters.');
    }

    if (options.maxResults !== undefined) {
      if (typeof options.maxResults !== 'number' || !Number.isInteger(options.maxResults) || options.maxResults <= 0) {
        throw new PathValidationError('maxResults must be a positive integer.');
      }
    }

    const scan = await this.getScanResult();
    const caseSensitive = options.caseSensitive === true;
    const maxResults = Math.min(Math.max(options.maxResults ?? 100, 1), 500);
    const searchQuery = caseSensitive ? options.query : options.query.toLowerCase();

    const matches: SearchMatch[] = [];
    let limitReached = false;

    for (const file of scan.files) {
      if (matches.length >= maxResults) {
        limitReached = true;
        break;
      }

      const filePath = path.join(canonicalRoot, file.relativePath);

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
