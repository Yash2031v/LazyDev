/**
 * LazyDev Ignore Rules & Secret Filter
 * Excludes version control, dependencies, build caches, and sensitive secret credentials.
 * Includes a lightweight, dependency-free parser for standard .gitignore patterns.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Directories that are always skipped during traversal
export const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  // Version control
  '.git', '.svn', '.hg',
  // Dependencies & package managers
  'node_modules', 'vendor', 'bower_components', '.venv', 'venv', 'env',
  // Build outputs & caches
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  'target', 'bin', 'obj', '__pycache__', '.pytest_cache',
  // IDEs and local tooling
  '.vscode', '.idea', '.vs'
]);

// Secret file names and patterns that must never be read or indexed
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  // Environment variables
  /^\.env(\..+)?$/i,
  /\.env$/i,

  // Private keys and certificates
  /\.(pem|key|pkcs12|pfx|crt|der|cer)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,

  // Tokens, credentials, and keystores
  /^(credentials|token|tokens|secrets)(\.json|\.yml|\.yaml|\.txt)?$/i,
  /^service[-_]account.*\.json$/i,
  /\.(secret|kdbx|htpasswd)$/i,
  /aws_access_key/i
];

export interface GitIgnoreRule {
  readonly pattern: string;
  readonly isNegated: boolean;
  readonly isDirectoryOnly: boolean;
  readonly regex: RegExp;
}

/**
 * Converts a simple gitignore glob pattern to a RegExp.
 * Supported subset:
 * - Comments (#) and blank lines
 * - Trailing slash for directory-only
 * - Negation prefix (!)
 * - Wildcards: * and **
 * - Extension matching: *.ext
 * - Anchored paths: /foo vs foo
 */
export function globToRegex(pattern: string): RegExp {
  let cleanPattern = pattern.trim();
  const isAnchored = cleanPattern.startsWith('/');
  if (isAnchored) {
    cleanPattern = cleanPattern.slice(1);
  }

  // Escape special regex characters except * and ?
  let escaped = cleanPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLE_STAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLE_STAR§/g, '.*')
    .replace(/\?/g, '[^/]');

  if (isAnchored) {
    return new RegExp(`^${escaped}(/|$)`, 'i');
  }

  // Match at start or after a slash
  return new RegExp(`(^|/)${escaped}(/|$)`, 'i');
}

export class IgnoreEngine {
  private readonly gitIgnoreRules: GitIgnoreRule[] = [];

  constructor(rules: GitIgnoreRule[] = []) {
    this.gitIgnoreRules = rules;
  }

  /**
   * Loads and parses .gitignore rules from the specified project root directory.
   */
  static async loadForRoot(projectRoot: string): Promise<IgnoreEngine> {
    const gitIgnorePath = path.join(projectRoot, '.gitignore');
    const rules: GitIgnoreRule[] = [];

    try {
      const content = await fs.readFile(gitIgnorePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        // Skip comments and blank lines
        if (!line || line.startsWith('#')) {
          continue;
        }

        let pattern = line;
        const isNegated = pattern.startsWith('!');
        if (isNegated) {
          pattern = pattern.slice(1).trim();
        }

        const isDirectoryOnly = pattern.endsWith('/');
        if (isDirectoryOnly) {
          pattern = pattern.slice(0, -1);
        }

        try {
          const regex = globToRegex(pattern);
          rules.push({
            pattern,
            isNegated,
            isDirectoryOnly,
            regex
          });
        } catch {
          // Ignore invalid regex
        }
      }
    } catch {
      // .gitignore does not exist or unreadable; proceed with defaults
    }

    return new IgnoreEngine(rules);
  }

  /**
   * Evaluates whether a directory name is excluded by default.
   */
  isDefaultExcludedDirectory(dirName: string): boolean {
    return DEFAULT_EXCLUDED_DIRECTORIES.has(dirName.toLowerCase());
  }

  /**
   * Checks if a filename or path matches known secret patterns.
   */
  isSecret(relativePath: string): boolean {
    const basename = path.basename(relativePath);
    return SECRET_FILE_PATTERNS.some(regex => regex.test(basename));
  }

  /**
   * Tests a path against default exclusions, secrets, and loaded gitignore rules.
   */
  shouldIgnore(relativePath: string, isDirectory: boolean): { ignored: boolean; reason?: 'secret' | 'ignored' } {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalized.split('/');
    const basename = segments[segments.length - 1] ?? '';

    // 1. Secret check always takes priority
    if (this.isSecret(basename)) {
      return { ignored: true, reason: 'secret' };
    }

    // 2. Default excluded folder names check in any path segment
    for (let i = 0; i < (isDirectory ? segments.length : segments.length - 1); i++) {
      const segment = segments[i];
      if (segment && this.isDefaultExcludedDirectory(segment)) {
        return { ignored: true, reason: 'ignored' };
      }
    }

    if (isDirectory && this.isDefaultExcludedDirectory(basename)) {
      return { ignored: true, reason: 'ignored' };
    }

    // 3. User .gitignore evaluation
    let ignoredByGit = false;

    for (const rule of this.gitIgnoreRules) {
      if (rule.isDirectoryOnly && !isDirectory) {
        continue;
      }

      if (rule.regex.test(normalized)) {
        ignoredByGit = !rule.isNegated;
      }
    }

    if (ignoredByGit) {
      return { ignored: true, reason: 'ignored' };
    }

    return { ignored: false };
  }
}
