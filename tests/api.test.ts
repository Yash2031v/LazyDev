import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/server/config.js';
import { OllamaClient } from '../src/server/ollama.js';
import { createRequestHandler } from '../src/server/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, '../src/client');

describe('API & Static File Routing', () => {
  let server: http.Server;
  let testPort: number;
  let baseUrl: string;

  before(async () => {
    // Port 0 lets OS assign an available ephemeral port
    const testConfig = loadConfig({ PORT: '0', HOST: '127.0.0.1' });

    // Mock Ollama client so tests do not require real Ollama service
    const mockOllama = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 500,
      fetchFn: (async () => {
        return new Response(JSON.stringify({ models: [{ name: 'test-model:latest' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }) as any
    });

    const handler = createRequestHandler(testConfig, mockOllama, CLIENT_DIR);
    server = http.createServer(handler);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          testPort = address.port;
          baseUrl = `http://127.0.0.1:${testPort}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test('GET /api/health returns 200 with structured JSON and security headers', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');

    const data = (await res.json()) as { status: string; version: string; timestamp: string; uptimeSeconds: number };
    assert.equal(data.status, 'ok');
    assert.equal(data.version, '0.1.0');
    assert.ok(typeof data.timestamp === 'string');
    assert.ok(typeof data.uptimeSeconds === 'number');
  });

  test('POST /api/health returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 405);
    const data = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(data.error.code, 405);
  });

  test('GET /api/status returns application details and Ollama status', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      app: { name: string; version: string };
      ollama: { connected: boolean; models: string[] };
    };
    assert.equal(data.app.name, 'LazyDev');
    assert.equal(data.app.version, '0.1.0');
    assert.equal(data.ollama.connected, true);
    assert.equal(data.ollama.models[0], 'test-model:latest');
  });

  test('rejects unexpected Host header with 400 Bad Request', async () => {
    const resData = await new Promise<{ status: number; body: { error: { code: number; message: string } } }>(
      (resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${testPort}/api/health`,
          {
            method: 'GET',
            headers: {
              Host: 'malicious-domain.com'
            }
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              try {
                resolve({
                  status: res.statusCode ?? 0,
                  body: JSON.parse(body)
                });
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('error', reject);
        req.end();
      }
    );

    assert.equal(resData.status, 400);
    assert.equal(resData.body.error.code, 400);
    assert.ok(resData.body.error.message.includes('Invalid or untrusted Host header'));
  });

  test('serves static index.html at root /', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('LazyDev'));
    assert.ok(html.includes('Local-First AI Developer Assistant'));
  });

  test('serves style.css and app.js with appropriate MIME types', async () => {
    const cssRes = await fetch(`${baseUrl}/style.css`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.headers.get('content-type')?.includes('text/css'));

    const jsRes = await fetch(`${baseUrl}/app.js`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.headers.get('content-type')?.includes('javascript'));
  });

  test('blocks directory traversal attempts', async () => {
    const res = await fetch(`${baseUrl}/../../package.json`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    // Should return 403 Forbidden or 404 Not Found, never 200
    assert.ok(res.status === 403 || res.status === 404);
  });
});
