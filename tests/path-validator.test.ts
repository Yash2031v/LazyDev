import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateProjectRoot,
  resolveSafeRelativePath,
  PathValidationError,
  SymlinkEscapeError
} from '../src/server/project/path-validator.js';

describe('Path Validator & Security Boundary', () => {
  let tempDir: string;
  let outsideDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-path-test-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-outside-'));

    await fs.writeFile(path.join(tempDir, 'valid.txt'), 'hello world');
    await fs.mkdir(path.join(tempDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'sub', 'nested.txt'), 'nested content');
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside content');

    // Create a symlink pointing outside project root if supported on OS
    try {
      await fs.symlink(outsideDir, path.join(tempDir, 'escape-link'), 'dir');
    } catch {
      // Symlink creation might require privileges on older Windows versions; test will handle gracefully
    }
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  test('validateProjectRoot accepts a real accessible directory', async () => {
    const canonical = await validateProjectRoot(tempDir);
    assert.ok(typeof canonical === 'string');
    assert.equal(canonical.toLowerCase(), (await fs.realpath(tempDir)).toLowerCase());
  });

  test('validateProjectRoot rejects nonexistent directories', async () => {
    const nonexistent = path.join(tempDir, 'does-not-exist-xyz');
    await assert.rejects(
      async () => validateProjectRoot(nonexistent),
      PathValidationError
    );
  });

  test('validateProjectRoot rejects files instead of directories', async () => {
    const filePath = path.join(tempDir, 'valid.txt');
    await assert.rejects(
      async () => validateProjectRoot(filePath),
      /is not a directory/
    );
  });

  test('validateProjectRoot rejects drive roots for safety', async () => {
    const driveRoot = process.platform === 'win32' ? 'C:\\' : '/';
    await assert.rejects(
      async () => validateProjectRoot(driveRoot),
      /Refusing to set drive root/
    );
  });

  test('validateProjectRoot rejects user home directory root for safety', async () => {
    const home = os.homedir();
    await assert.rejects(
      async () => validateProjectRoot(home),
      /Refusing to set user home directory root/
    );
  });

  test('resolveSafeRelativePath resolves safe relative paths', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    const result = await resolveSafeRelativePath(canonicalRoot, 'sub/nested.txt', true);
    assert.equal(result.normalizedRelative, 'sub/nested.txt');
    assert.ok(result.canonicalPath.endsWith(path.join('sub', 'nested.txt')));
  });

  test('resolveSafeRelativePath rejects directory traversal (..)', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, '../outside.txt', false),
      /Directory traversal outside project root is forbidden/
    );
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, 'sub/../../outside.txt', false),
      /Directory traversal outside project root is forbidden/
    );
  });

  test('resolveSafeRelativePath rejects absolute paths', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    const absPath = process.platform === 'win32' ? 'C:\\windows\\system32' : '/etc/passwd';
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, absPath, false),
      /Absolute paths are forbidden/
    );
  });

  test('resolveSafeRelativePath rejects null bytes and alternate data streams', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, 'file\0.txt', false),
      /Null bytes are forbidden/
    );
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, 'file.txt:stream', false),
      /Colons are forbidden/
    );
  });

  test('resolveSafeRelativePath detects symlink escape', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    const symlinkPath = path.join(tempDir, 'escape-link');

    // Check if symlink was successfully created in before() hook
    try {
      await fs.lstat(symlinkPath);
    } catch {
      // Symlink not supported in current environment; skip gracefully
      return;
    }

    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, 'escape-link/secret.txt', true),
      SymlinkEscapeError
    );
  });
});
