import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { OllamaClient } from '../src/server/ollama.js';

describe('Ollama Client', () => {
  test('returns connected status and model list when Ollama endpoint responds correctly', async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          models: [
            { name: 'qwen2.5-coder:7b', size: 4500000000 },
            { name: 'llama3.2:3b', size: 2000000000 }
          ]
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: mockFetch as any
    });

    const status = await client.checkStatus();
    assert.equal(status.connected, true);
    assert.equal(status.models.length, 2);
    assert.equal(status.models[0], 'qwen2.5-coder:7b');
    assert.equal(status.models[1], 'llama3.2:3b');
    assert.ok(status.details.includes('2 models available'));
    assert.ok(typeof status.latencyMs === 'number');
  });

  test('handles connection refused (Ollama offline) gracefully without throwing', async () => {
    const mockFetch = async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 1000,
      fetchFn: mockFetch as any
    });

    const status = await client.checkStatus();
    assert.equal(status.connected, false);
    assert.equal(status.models.length, 0);
    assert.ok(status.details.includes('not running or unreachable'));
    assert.equal(status.latencyMs, null);
  });

  test('handles connection timeouts gracefully without throwing', async () => {
    const mockFetch = async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 500,
      fetchFn: mockFetch as any
    });

    const status = await client.checkStatus();
    assert.equal(status.connected, false);
    assert.ok(status.details.includes('timed out after 500ms'));
  });

  test('handles malformed non-JSON responses gracefully', async () => {
    const mockFetch = async () => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 1000,
      fetchFn: mockFetch as any
    });

    const status = await client.checkStatus();
    assert.equal(status.connected, false);
    assert.ok(status.details.includes('Malformed response'));
  });

  test('handles HTTP error status codes gracefully', async () => {
    const mockFetch = async () => {
      return new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error'
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 1000,
      fetchFn: mockFetch as any
    });

    const status = await client.checkStatus();
    assert.equal(status.connected, false);
    assert.ok(status.details.includes('HTTP error 500'));
  });
});
