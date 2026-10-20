import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProjectService, ProjectAccessError } from '../src/server/project/project-service.js';
import { PathValidationError } from '../src/server/project/path-validator.js';

describe('Project Service', () => {
  let tempDir: string;
  let service: ProjectService;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-service-test-'));

    await fs.writeFile(path.join(tempDir, 'README.md'), '# LazyDev Service\nFast and local.');
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src', 'app.ts'),
      'export function main() {\n  const message = "Hello LazyDev";\n  console.log(message);\n}\n'
    );
    await fs.writeFile(path.join(tempDir, '.env'), 'DATABASE_PASSWORD=supersecret');
    await fs.writeFile(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));

    service = new ProjectService();
    await service.setProjectRoot(tempDir);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('reports hasActiveProject and returns canonical root', () => {
    assert.equal(service.hasActiveProject(), true);
    assert.ok(typeof service.getProjectRoot() === 'string');
  });

  test('getSummary produces breakdown of file counts, sizes, and extensions', async () => {
    const summary = await service.getSummary();
    assert.ok(summary.totalFiles >= 2);
    assert.ok(summary.totalSizeBytes > 0);
    assert.ok(summary.fileTypes['.md'] >= 1);
    assert.ok(summary.fileTypes['.ts'] >= 1);
    assert.ok(summary.topDirectories.includes('src'));
    assert.ok(summary.skippedCount >= 2); // .env and image.png
  });

  test('readFile retrieves permitted text file contents', async () => {
    const file = await service.readFile('src/app.ts');
    assert.equal(file.relativePath, 'src/app.ts');
    assert.ok(file.content.includes('Hello LazyDev'));
    assert.ok(file.sizeBytes > 0);
  });

  test('readFile strictly denies reading secret files (.env)', async () => {
    await assert.rejects(
      async () => service.readFile('.env'),
      /protected as a secret credential/
    );
  });

  test('readFile strictly denies reading binary files', async () => {
    await assert.rejects(
      async () => service.readFile('image.png'),
      /is an excluded path|is a binary file/
    );
  });

  test('readFile strictly denies directory traversal', async () => {
    await assert.rejects(
      async () => service.readFile('../outside.txt'),
      PathValidationError
    );
  });

  test('searchFiles finds matches with relative path, line number, and content', async () => {
    const result = await service.searchFiles({ query: 'LazyDev' });
    assert.equal(result.query, 'LazyDev');
    assert.ok(result.totalMatches >= 2); // In README.md and src/app.ts

    const appMatch = result.matches.find(m => m.relativePath === 'src/app.ts');
    assert.ok(appMatch, 'Expected match in src/app.ts');
    assert.equal(appMatch.lineNumber, 2);
    assert.ok(appMatch.lineContent.includes('Hello LazyDev'));
  });

  test('searchFiles respects caseSensitive option', async () => {
    const caseInsensitive = await service.searchFiles({ query: 'lazydev', caseSensitive: false });
    assert.ok(caseInsensitive.totalMatches >= 2);

    const caseSensitive = await service.searchFiles({ query: 'lazydev', caseSensitive: true });
    assert.equal(caseSensitive.totalMatches, 0); // All occurrences are "LazyDev"
  });

  test('searchFiles validates query string', async () => {
    await assert.rejects(
      async () => service.searchFiles({ query: '' }),
      PathValidationError
    );
    await assert.rejects(
      async () => service.searchFiles({ query: 'a'.repeat(250) }),
      /exceeds maximum length/
    );
  });
});
