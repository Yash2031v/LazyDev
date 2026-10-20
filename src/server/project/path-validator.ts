/**
 * LazyDev Path Validator & Filesystem Security
 * Enforces strict boundary checks, canonicalization, and anti-traversal defenses.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export class PathValidationError extends Error {
  constructor(message: string) {
    super(`[LazyDev Path Security] ${message}`);
    this.name = 'PathValidationError';
  }
}

export class SymlinkEscapeError extends PathValidationError {
  constructor(message: string) {
    super(`Symlink escape detected: ${message}`);
    this.name = 'SymlinkEscapeError';
  }
}

/**
 * Validates and canonicalizes a candidate project root.
 * Rejects drive roots, home directories, system folders, or nonexistent paths.
 */
export async function validateProjectRoot(candidatePath: string): Promise<string> {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new PathValidationError('Project root path must be a non-empty string.');
  }

  // Reject null bytes and alternate data streams
  if (candidatePath.includes('\0') || candidatePath.includes(':') && candidatePath.indexOf(':') !== 1) {
    // Note: in Windows C: is index 1, which is valid drive letter, but multiple colons or ADS is not
    const colonCount = (candidatePath.match(/:/g) || []).length;
    if (colonCount > 1 || (colonCount === 1 && candidatePath.indexOf(':') !== 1)) {
      throw new PathValidationError('Invalid path syntax or alternate data stream detected.');
    }
  }

  const resolved = path.resolve(candidatePath.trim());

  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PathValidationError(`Cannot access directory "${resolved}": ${msg}`);
  }

  if (!stats.isDirectory()) {
    throw new PathValidationError(`Specified path "${resolved}" is not a directory.`);
  }

  // Canonicalize via realpath to resolve any symlinks and Windows short paths
  let canonical: string;
  try {
    canonical = await fs.realpath(resolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PathValidationError(`Failed to resolve real path for "${resolved}": ${msg}`);
  }

  // 1. Guard against drive roots (e.g. C:\ or D:\ or /)
  const parsed = path.parse(canonical);
  if (canonical === parsed.root || canonical.replace(/[\\/]+$/, '') === parsed.root.replace(/[\\/]+$/, '')) {
    throw new PathValidationError('Refusing to set drive root as project directory for safety.');
  }

  // 2. Guard against user home directory root (e.g. C:\Users\Username or /home/username)
  let homeDir: string | null = null;
  try {
    homeDir = await fs.realpath(os.homedir());
  } catch {
    // Nonfatal if homedir cannot be resolved
  }

  if (homeDir && canonical.toLowerCase() === homeDir.toLowerCase()) {
    throw new PathValidationError('Refusing to set user home directory root as project directory for safety.');
  }

  // 3. Guard against Windows / Unix system directories
  const normalizedCanonical = canonical.toLowerCase().replace(/\\/g, '/');
  const forbiddenPrefixes = [
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)',
    '/bin',
    '/usr',
    '/etc',
    '/var',
    '/sys',
    '/proc'
  ];

  for (const prefix of forbiddenPrefixes) {
    if (normalizedCanonical === prefix || normalizedCanonical.startsWith(prefix + '/')) {
      throw new PathValidationError(`Refusing to open system directory "${canonical}".`);
    }
  }

  return canonical;
}

/**
 * Safely resolves and canonicalizes a relative path within an authorized project root.
 * Guarantees that the target resides inside the project root and is not a symlink escaping it.
 */
export async function resolveSafeRelativePath(
  canonicalRoot: string,
  relativePath: string,
  checkExistence: boolean = true
): Promise<{ fullPath: string; canonicalPath: string; normalizedRelative: string }> {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new PathValidationError('Relative path must be a non-empty string.');
  }

  // Defend against single and nested percent-encoding traversal
  let cleanRelative = relativePath;
  let decodeRounds = 0;
  while (cleanRelative.includes('%') && decodeRounds < 3) {
    try {
      const decoded = decodeURIComponent(cleanRelative);
      if (decoded === cleanRelative) break;
      cleanRelative = decoded;
      decodeRounds++;
    } catch {
      throw new PathValidationError('Malformed percent-encoded path.');
    }
  }

  // Reject null bytes
  if (cleanRelative.includes('\0')) {
    throw new PathValidationError('Null bytes are forbidden in paths.');
  }

  // Reject absolute paths first
  if (path.isAbsolute(cleanRelative)) {
    throw new PathValidationError('Absolute paths are forbidden. Specify a relative path from the project root.');
  }

  // Reject Windows alternate data streams (e.g. "file.txt:stream")
  if (cleanRelative.includes(':')) {
    throw new PathValidationError('Colons are forbidden in relative paths.');
  }

  // Normalize path and reject directory traversal
  const normalized = path.normalize(cleanRelative).replace(/^[\\/]+/, '');
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || normalized.includes(path.sep + '..' + path.sep)) {
    throw new PathValidationError(`Directory traversal outside project root is forbidden: "${relativePath}".`);
  }

  const fullPath = path.resolve(canonicalRoot, normalized);

  // Logical boundary check
  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (fullPath !== canonicalRoot && !fullPath.startsWith(rootWithSep)) {
    throw new PathValidationError(`Path escapes project root: "${relativePath}".`);
  }

  let canonicalPath = fullPath;
  if (checkExistence) {
    try {
      canonicalPath = await fs.realpath(fullPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PathValidationError(`File or directory does not exist or cannot be accessed: ${msg}`);
    }

    // Physical symlink escape check: the real on-disk path must be inside canonicalRoot
    if (canonicalPath !== canonicalRoot && !canonicalPath.toLowerCase().startsWith(canonicalRoot.toLowerCase() + path.sep)) {
      throw new SymlinkEscapeError(`File target "${canonicalPath}" resolves outside of project root.`);
    }
  }

  const normalizedRelative = path.relative(canonicalRoot, canonicalPath).replace(/\\/g, '/');

  return {
    fullPath,
    canonicalPath,
    normalizedRelative
  };
}
