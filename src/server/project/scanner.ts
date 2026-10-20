/**
 * LazyDev Recursive Codebase Scanner
 * Bounded, error-resilient filesystem walker enforcing ignore rules, size caps, and safety limits.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectFileInfo, SkippedFileInfo, ScanLimits, ScanResult } from './types.js';
import { IgnoreEngine } from './ignore-rules.js';
import { isBinaryExtension, isBinaryFile } from './binary-detector.js';

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 2000,
  maxDepth: 15,
  maxFileSizeBytes: 512 * 1024 // 512 KB
};

export class CodebaseScanner {
  private readonly canonicalRoot: string;
  private readonly ignoreEngine: IgnoreEngine;
  private readonly limits: ScanLimits;

  constructor(canonicalRoot: string, ignoreEngine: IgnoreEngine, customLimits?: Partial<ScanLimits>) {
    this.canonicalRoot = canonicalRoot;
    this.ignoreEngine = ignoreEngine;
    this.limits = {
      maxFiles: customLimits?.maxFiles ?? DEFAULT_SCAN_LIMITS.maxFiles,
      maxDepth: customLimits?.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth,
      maxFileSizeBytes: customLimits?.maxFileSizeBytes ?? DEFAULT_SCAN_LIMITS.maxFileSizeBytes
    };
  }

  /**
   * Performs bounded scan of the canonical project root.
   */
  async scan(): Promise<ScanResult> {
    const files: ProjectFileInfo[] = [];
    const skippedFiles: SkippedFileInfo[] = [];
    const warnings: string[] = [];
    const visitedRealPaths = new Set<string>();

    visitedRealPaths.add(this.canonicalRoot.toLowerCase());

    let limitReached = false;

    // Queue-based BFS traversal to keep depth tracking predictable
    interface QueueItem {
      dirPath: string;
      currentDepth: number;
    }

    const queue: QueueItem[] = [{ dirPath: this.canonicalRoot, currentDepth: 0 }];

    while (queue.length > 0) {
      if (files.length >= this.limits.maxFiles) {
        limitReached = true;
        warnings.push(`File scan limit reached (${this.limits.maxFiles} files). Scan truncated.`);
        break;
      }

      const item = queue.shift();
      if (!item) break;

      const { dirPath, currentDepth } = item;

      if (currentDepth > this.limits.maxDepth) {
        warnings.push(`Max directory depth (${this.limits.maxDepth}) reached at "${path.relative(this.canonicalRoot, dirPath)}". Subdirectories skipped.`);
        continue;
      }

      let entries: Dirent[];
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Could not read directory "${path.relative(this.canonicalRoot, dirPath) || '.'}": ${msg}`);
        continue;
      }

      for (const entry of entries) {
        if (files.length >= this.limits.maxFiles) {
          limitReached = true;
          warnings.push(`File scan limit reached (${this.limits.maxFiles} files). Scan truncated.`);
          break;
        }

        const entryFullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(this.canonicalRoot, entryFullPath).replace(/\\/g, '/');

        // Check symlinks
        if (entry.isSymbolicLink()) {
          try {
            const real = await fs.realpath(entryFullPath);
            // Verify symlink target stays inside project root
            if (!real.toLowerCase().startsWith(this.canonicalRoot.toLowerCase() + path.sep)) {
              skippedFiles.push({
                relativePath: relPath,
                reason: 'symlink_escape',
                details: 'Target resolves outside project root.'
              });
              continue;
            }

            const stat = await fs.stat(entryFullPath);
            if (stat.isDirectory()) {
              if (visitedRealPaths.has(real.toLowerCase())) {
                // Prevent cycle
                continue;
              }
              visitedRealPaths.add(real.toLowerCase());

              const ignoreCheck = this.ignoreEngine.shouldIgnore(relPath, true);
              if (ignoreCheck.ignored) {
                continue;
              }

              queue.push({ dirPath: entryFullPath, currentDepth: currentDepth + 1 });
            } else if (stat.isFile()) {
              await this.processFile(entryFullPath, relPath, stat, files, skippedFiles);
            }
          } catch (err: unknown) {
            skippedFiles.push({
              relativePath: relPath,
              reason: 'error',
              details: err instanceof Error ? err.message : String(err)
            });
          }
          continue;
        }

        if (entry.isDirectory()) {
          const ignoreCheck = this.ignoreEngine.shouldIgnore(relPath, true);
          if (ignoreCheck.ignored) {
            continue;
          }

          queue.push({ dirPath: entryFullPath, currentDepth: currentDepth + 1 });
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(entryFullPath);
            await this.processFile(entryFullPath, relPath, stat, files, skippedFiles);
          } catch (err: unknown) {
            skippedFiles.push({
              relativePath: relPath,
              reason: 'error',
              details: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }
    }

    return {
      rootPath: this.canonicalRoot,
      canonicalRootPath: this.canonicalRoot,
      scannedAt: new Date().toISOString(),
      totalFilesScanned: files.length,
      files: Object.freeze(files),
      skippedFiles: Object.freeze(skippedFiles),
      warnings: Object.freeze(warnings),
      limitReached
    };
  }

  private async processFile(
    fullPath: string,
    relPath: string,
    stat: { size: number; mtime: Date },
    files: ProjectFileInfo[],
    skippedFiles: SkippedFileInfo[]
  ): Promise<void> {
    const filename = path.basename(relPath);

    // 1. Ignore engine check (default folders and secret patterns)
    const ignoreCheck = this.ignoreEngine.shouldIgnore(relPath, false);
    if (ignoreCheck.ignored) {
      skippedFiles.push({
        relativePath: relPath,
        reason: ignoreCheck.reason ?? 'ignored'
      });
      return;
    }

    // 2. Oversized check
    if (stat.size > this.limits.maxFileSizeBytes) {
      skippedFiles.push({
        relativePath: relPath,
        reason: 'oversized',
        details: `Size ${stat.size} bytes exceeds limit of ${this.limits.maxFileSizeBytes} bytes.`
      });
      return;
    }

    // 3. Binary extension fast-path check
    if (isBinaryExtension(filename)) {
      skippedFiles.push({
        relativePath: relPath,
        reason: 'binary',
        details: 'Excluded based on binary file extension.'
      });
      return;
    }

    // 4. Null-byte content inspection check
    const isBinary = await isBinaryFile(fullPath);
    if (isBinary) {
      skippedFiles.push({
        relativePath: relPath,
        reason: 'binary',
        details: 'Null characters detected in file header.'
      });
      return;
    }

    // Permitted readable text file
    files.push({
      relativePath: relPath,
      name: filename,
      extension: path.extname(filename).toLowerCase(),
      sizeBytes: stat.size,
      modifiedTime: stat.mtime.toISOString(),
      isText: true
    });
  }
}
