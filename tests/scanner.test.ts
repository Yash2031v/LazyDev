import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodebaseScanner } from '../src/server/project/scanner.js';
import { IgnoreEngine } from '../src/server/project/ignore-rules.js';

describe('Codebase Scanner', () => {
  let tempDir: string;
  let canonicalRoot: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-scanner-test-'));
    canonicalRoot = await fs.realpath(tempDir);

    // 1. Regular text files
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Test Project');
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello");');
    await fs.writeFile(path.join(tempDir, 'src', 'utils.ts'), 'export const a = 1;');

    // 2. Default excluded folder
    await fs.mkdir(path.join(tempDir, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'node_modules', 'dep', 'package.json'), '{}');

    // 3. Secret file
    await fs.writeFile(path.join(tempDir, '.env'), 'SECRET_KEY=12345');
    await fs.writeFile(path.join(tempDir, 'id_rsa'), 'PRIVATE_KEY');

    // 4. Binary file
    await fs.writeFile(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // 5. Oversized file (e.g. 2 KB with a 1 KB limit in tests)
    const bigBuffer = Buffer.alloc(2048, 'a');
    await fs.writeFile(path.join(tempDir, 'big.txt'), bigBuffer);

    // 6. Deep nested directory
    let deepPath = tempDir;
    for (let i = 1; i <= 6; i++) {
      deepPath = path.join(deepPath, `level${i}`);
      await fs.mkdir(deepPath, { recursive: true });
      await fs.writeFile(path.join(deepPath, `file${i}.txt`), `level ${i}`);
    }
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('scans project files while excluding node_modules, secrets, and binaries', async () => {
    const ignoreEngine = await IgnoreEngine.loadForRoot(canonicalRoot);
    const scanner = new CodebaseScanner(canonicalRoot, ignoreEngine, {
      maxFiles: 100,
      maxDepth: 10,
      maxFileSizeBytes: 1024 * 1024 // 1 MB
    });

    const result = await scanner.scan();

    const filePaths = result.files.map(f => f.relativePath);
    assert.ok(filePaths.includes('README.md'));
    assert.ok(filePaths.includes('src/index.ts'));
    assert.ok(filePaths.includes('src/utils.ts'));

    // Verify node_modules is completely absent from files
    assert.ok(!filePaths.some(p => p.startsWith('node_modules')));

    // Verify secret files are in skippedFiles, never in files
    assert.ok(!filePaths.includes('.env'));
    assert.ok(!filePaths.includes('id_rsa'));

    const envSkipped = result.skippedFiles.find(s => s.relativePath === '.env');
    assert.ok(envSkipped, 'Expected .env to be in skippedFiles');
    assert.equal(envSkipped.reason, 'secret');

    // Verify binary is skipped
    assert.ok(!filePaths.includes('image.png'));
    const binSkipped = result.skippedFiles.find(s => s.relativePath === 'image.png');
    assert.ok(binSkipped);
    assert.equal(binSkipped.reason, 'binary');
  });

  test('skips oversized files according to configured maxFileSizeBytes', async () => {
    const ignoreEngine = await IgnoreEngine.loadForRoot(canonicalRoot);
    const scanner = new CodebaseScanner(canonicalRoot, ignoreEngine, {
      maxFiles: 100,
      maxDepth: 10,
      maxFileSizeBytes: 1024 // 1 KB limit (big.txt is 2048 bytes)
    });

    const result = await scanner.scan();
    const filePaths = result.files.map(f => f.relativePath);

    assert.ok(!filePaths.includes('big.txt'));
    const bigSkipped = result.skippedFiles.find(s => s.relativePath === 'big.txt');
    assert.ok(bigSkipped);
    assert.equal(bigSkipped.reason, 'oversized');
  });

  test('respects maxFiles limit and marks limitReached: true', async () => {
    const ignoreEngine = await IgnoreEngine.loadForRoot(canonicalRoot);
    const scanner = new CodebaseScanner(canonicalRoot, ignoreEngine, {
      maxFiles: 2, // low limit
      maxDepth: 10,
      maxFileSizeBytes: 1024 * 1024
    });

    const result = await scanner.scan();
    assert.equal(result.files.length, 2);
    assert.equal(result.limitReached, true);
    assert.ok(result.warnings.some(w => w.includes('File scan limit reached')));
  });

  test('respects maxDepth limit and skips deeper subdirectories', async () => {
    const ignoreEngine = await IgnoreEngine.loadForRoot(canonicalRoot);
    const scanner = new CodebaseScanner(canonicalRoot, ignoreEngine, {
      maxFiles: 100,
      maxDepth: 2, // only 2 levels
      maxFileSizeBytes: 1024 * 1024
    });

    const result = await scanner.scan();
    const filePaths = result.files.map(f => f.relativePath);

    // level 5 and 6 should not be reached
    assert.ok(!filePaths.some(p => p.includes('level5') || p.includes('level6')));
    assert.ok(result.warnings.some(w => w.includes('Max directory depth')));
  });
});
