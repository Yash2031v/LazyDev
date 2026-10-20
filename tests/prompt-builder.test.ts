import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { PromptBuilder } from '../src/server/ai/prompt-builder.js';

describe('PromptBuilder', () => {
  test('builds bounded system and user prompt with existing file content', () => {
    const messages = PromptBuilder.buildEditPrompt({
      targetFilePath: 'src/calc.ts',
      fileContent: 'export function add(a: number, b: number) { return a + b; }',
      taskPrompt: 'Add multiply function'
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('LazyDev'));
    assert.ok(messages[0].content.includes('"content"'));

    assert.equal(messages[1].role, 'user');
    assert.ok(messages[1].content.includes('Target File: src/calc.ts'));
    assert.ok(messages[1].content.includes('Add multiply function'));
    assert.ok(messages[1].content.includes('export function add'));
  });

  test('handles empty or new files gracefully', () => {
    const messages = PromptBuilder.buildEditPrompt({
      targetFilePath: 'src/new-file.ts',
      taskPrompt: 'Create a greeting function'
    });

    assert.equal(messages.length, 2);
    assert.ok(messages[1].content.includes('(Note: This is a new or empty file.)'));
    assert.ok(messages[1].content.includes('Create a greeting function'));
  });

  test('truncates file content exceeding file context budget', () => {
    const largeContent = 'const x = 1;\n'.repeat(1000); // ~13KB
    const messages = PromptBuilder.buildEditPrompt({
      targetFilePath: 'src/large.ts',
      fileContent: largeContent,
      taskPrompt: 'Refactor',
      maxFileBytes: 500 // budget 500 bytes
    });

    assert.ok(messages[1].content.includes('[... file truncated to fit local context budget ...]'));
    assert.ok(Buffer.byteLength(messages[1].content, 'utf8') < 2000);
  });
});
