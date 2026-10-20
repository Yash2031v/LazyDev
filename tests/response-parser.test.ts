import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { ResponseParser, AiParserError } from '../src/server/ai/response-parser.js';

describe('ResponseParser', () => {
  test('parses raw JSON output from model', () => {
    const raw = JSON.stringify({
      file: 'src/app.ts',
      explanation: 'Added health check',
      content: 'console.log("ok");'
    });

    const parsed = ResponseParser.parseEditResponse(raw);
    assert.equal(parsed.file, 'src/app.ts');
    assert.equal(parsed.explanation, 'Added health check');
    assert.equal(parsed.content, 'console.log("ok");');
  });

  test('parses markdown-fenced ```json ``` model output', () => {
    const raw = `
Here is your proposed update:
\`\`\`json
{
  "file": "src/utils.ts",
  "explanation": "Fixed formatting",
  "content": "export const PI = 3.14159;"
}
\`\`\`
Hope this helps!
    `;

    const parsed = ResponseParser.parseEditResponse(raw);
    assert.equal(parsed.file, 'src/utils.ts');
    assert.equal(parsed.explanation, 'Fixed formatting');
    assert.equal(parsed.content, 'export const PI = 3.14159;');
  });

  test('falls back to target file path if model omitted file property', () => {
    const raw = JSON.stringify({
      explanation: 'Added greeting',
      content: 'export function hello() {}'
    });

    const parsed = ResponseParser.parseEditResponse(raw, 'src/hello.ts');
    assert.equal(parsed.file, 'src/hello.ts');
    assert.equal(parsed.content, 'export function hello() {}');
  });

  test('handles trailing commas in model JSON', () => {
    const raw = `
{
  "file": "src/index.ts",
  "explanation": "Updated entry point",
  "content": "start();",
}
    `;

    const parsed = ResponseParser.parseEditResponse(raw);
    assert.equal(parsed.file, 'src/index.ts');
    assert.equal(parsed.content, 'start();');
  });

  test('rejects empty or whitespace response with AiParserError', () => {
    assert.throws(
      () => ResponseParser.parseEditResponse('   '),
      AiParserError
    );
  });

  test('rejects non-JSON response with AiParserError', () => {
    assert.throws(
      () => ResponseParser.parseEditResponse('Sorry, I cannot help with that code request.'),
      AiParserError
    );
  });

  test('rejects response missing mandatory "content" field with AiParserError', () => {
    assert.throws(
      () => ResponseParser.parseEditResponse(JSON.stringify({ file: 'a.ts', explanation: 'Only text' })),
      AiParserError
    );
  });
});
