import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { isBinaryExtension, isBinaryFile } from '../src/server/project/binary-detector.js';

describe('Binary Detector', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-binary-test-'));

    // Create a regular text file
    await fs.writeFile(path.join(tempDir, 'plain.txt'), 'This is plain text with no null bytes.');

    // Create a file with custom extension containing a null byte
    const binBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
    await fs.writeFile(path.join(tempDir, 'custom.dat'), binBuffer);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('isBinaryExtension recognizes standard binary extensions', () => {
    assert.equal(isBinaryExtension('app.exe'), true);
    assert.equal(isBinaryExtension('image.PNG'), true);
    assert.equal(isBinaryExtension('archive.zip'), true);
    assert.equal(isBinaryExtension('lib.dll'), true);
    assert.equal(isBinaryExtension('doc.pdf'), true);

    assert.equal(isBinaryExtension('app.ts'), false);
    assert.equal(isBinaryExtension('style.css'), false);
    assert.equal(isBinaryExtension('index.html'), false);
    assert.equal(isBinaryExtension('data.json'), false);
  });

  test('isBinaryFile detects null bytes in header', async () => {
    const isBin = await isBinaryFile(path.join(tempDir, 'custom.dat'));
    assert.equal(isBin, true);

    const isText = await isBinaryFile(path.join(tempDir, 'plain.txt'));
    assert.equal(isText, false);
  });
});
