import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { generateUnifiedDiff } from '../src/server/editor/diff-engine.js';

describe('Diff Engine', () => {
  it('returns identical result when text is unchanged', () => {
    const text = 'line 1\nline 2\nline 3';
    const result = generateUnifiedDiff('test.txt', text, text);

    assert.equal(result.isIdentical, true);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
    assert.equal(result.unified, '');
    assert.equal(result.chunks.length, 0);
  });

  it('normalizes CRLF and LF so identical text with different line endings is identical', () => {
    const crlf = 'line 1\r\nline 2\r\nline 3';
    const lf = 'line 1\nline 2\nline 3';
    const result = generateUnifiedDiff('test.txt', crlf, lf);

    assert.equal(result.isIdentical, true);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
  });

  it('detects line additions correctly', () => {
    const original = 'alpha\ncharlie';
    const proposed = 'alpha\nbravo\ncharlie';
    const result = generateUnifiedDiff('letters.txt', original, proposed);

    assert.equal(result.isIdentical, false);
    assert.equal(result.additions, 1);
    assert.equal(result.deletions, 0);
    assert.match(result.unified, /\+bravo/);
    assert.match(result.unified, /--- a\/letters\.txt/);
    assert.match(result.unified, /\+\+\+ b\/letters\.txt/);
  });

  it('detects line deletions correctly', () => {
    const original = 'alpha\nbravo\ncharlie';
    const proposed = 'alpha\ncharlie';
    const result = generateUnifiedDiff('letters.txt', original, proposed);

    assert.equal(result.isIdentical, false);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 1);
    assert.match(result.unified, /-bravo/);
  });

  it('detects line modifications as deletion and addition', () => {
    const original = 'const timeout = 1000;';
    const proposed = 'const timeout = 5000;';
    const result = generateUnifiedDiff('config.js', original, proposed);

    assert.equal(result.isIdentical, false);
    assert.equal(result.additions, 1);
    assert.equal(result.deletions, 1);
    assert.match(result.unified, /-const timeout = 1000;/);
    assert.match(result.unified, /\+const timeout = 5000;/);
  });

  it('handles empty original text', () => {
    const original = '';
    const proposed = 'console.log("hello world");';
    const result = generateUnifiedDiff('new.js', original, proposed);

    assert.equal(result.isIdentical, false);
    assert.equal(result.additions, 1);
    assert.match(result.unified, /\+console\.log\("hello world"\);/);
  });

  it('handles empty proposed text (clearing file)', () => {
    const original = 'old content';
    const proposed = '';
    const result = generateUnifiedDiff('clear.txt', original, proposed);

    assert.equal(result.isIdentical, false);
    assert.equal(result.deletions, 1);
    assert.match(result.unified, /-old content/);
  });
});
