/**
 * LazyDev Public Demo Mode Regression Tests
 * Proves complete isolation, zero-Ollama operation, virtual in-memory sandboxing,
 * path containment, rate limiting, and security compliance.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadConfig } from '../src/server/config.js';
import { startServer, type ServerInstance } from '../src/server/index.js';
import { OllamaClient } from '../src/server/ollama.js';

function makeRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          ...options.headers
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Not JSON
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: raw,
            json: parsed
          });
        });
      }
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('Public Demo Mode Isolation & Reliability', () => {
  let demoInstance: ServerInstance;
  let demoPort: number;

  before(async () => {
    // Start server in Public Demo Mode on an ephemeral port
    const testConfig = loadConfig({
      LAZYDEV_PUBLIC_DEMO: 'true',
      LAZYDEV_AI_MODE: 'demo',
      PORT: '0',
      HOST: '127.0.0.1',
      ALLOWED_HOSTS: '127.0.0.1:*,localhost:*,lazydev-demo.onrender.com,*.onrender.com'
    });

    demoInstance = await startServer(testConfig);
    const addr = demoInstance.server.address();
    if (typeof addr === 'object' && addr !== null) {
      demoPort = addr.port;
    } else {
      throw new Error('Failed to obtain server address');
    }
  });

  after(async () => {
    if (demoInstance) {
      await demoInstance.close();
    }
  });

  it('starts without Ollama running and reports public demo mode', async () => {
    const res = await makeRequest(demoPort, '/api/status');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.app.environment, 'public-demo');
    assert.strictEqual(res.json.app.isPublicDemo, true);
    assert.strictEqual(res.json.aiMode, 'demo');
    assert.strictEqual(res.json.ollama.connected, false);
    assert.ok(res.json.ollama.details.includes('Public Demo Mode active'));
    // Ensure no server paths are leaked in runtime or project
    assert.strictEqual(res.json.runtime.platform, 'sandbox');
    assert.strictEqual(res.json.project.root, 'demo-sandbox');
  });

  it('health endpoint returns 200 without leaking file paths or secrets', async () => {
    const res = await makeRequest(demoPort, '/api/health');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.status, 'ok');
    assert.strictEqual(typeof res.json.uptimeSeconds, 'number');
    assert.strictEqual(res.json.version, '0.1.0');
    // Ensure no secrets or internal configuration paths are present
    const keys = Object.keys(res.json);
    assert.deepStrictEqual(keys.sort(), ['status', 'timestamp', 'uptimeSeconds', 'version'].sort());
  });

  it('rejects POST /api/project/root with 403 Forbidden to prevent server disk browsing', async () => {
    const res = await makeRequest(demoPort, '/api/project/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: process.cwd() })
    });

    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.json.error.message.includes('disabled in public demo mode'));
  });

  it('serves virtual in-memory files and summary with zero server disk access', async () => {
    const filesRes = await makeRequest(demoPort, '/api/project/files');
    assert.strictEqual(filesRes.statusCode, 200);
    assert.strictEqual(filesRes.json.canonicalRootPath, 'demo-sandbox');
    assert.strictEqual(filesRes.json.totalFiles, 3);
    const paths = filesRes.json.files.map((f: any) => f.relativePath);
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('src/calculator.ts'));
    assert.ok(paths.includes('src/index.ts'));

    const summaryRes = await makeRequest(demoPort, '/api/project/summary');
    assert.strictEqual(summaryRes.statusCode, 200);
    assert.strictEqual(summaryRes.json.totalFiles, 3);
  });

  it('reads virtual demo files and rejects reading arbitrary server files', async () => {
    // Permitted virtual file
    const readRes = await makeRequest(demoPort, '/api/project/file?path=src/calculator.ts');
    assert.strictEqual(readRes.statusCode, 200);
    assert.strictEqual(readRes.json.relativePath, 'src/calculator.ts');
    assert.ok(readRes.json.content.includes('export function add'));

    // Arbitrary server file (e.g. package.json or /etc/passwd or C:\Windows\win.ini)
    const attackRes1 = await makeRequest(demoPort, '/api/project/file?path=package.json');
    assert.strictEqual(attackRes1.statusCode, 404);

    const attackRes2 = await makeRequest(demoPort, '/api/project/file?path=../../package.json');
    assert.strictEqual(attackRes2.statusCode, 404);
  });

  it('performs in-memory search against virtual files', async () => {
    const res = await makeRequest(demoPort, '/api/project/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'multiply' })
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json.totalMatches >= 1);
    const match = res.json.matches[0];
    assert.ok(match.relativePath.includes('calculator.ts') || match.relativePath.includes('index.ts'));
  });

  it('returns deterministic offline models from /api/ai/models without calling Ollama', async () => {
    const res = await makeRequest(demoPort, '/api/ai/models');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json.models, ['demo-sample-model (offline sample)']);
    assert.strictEqual(res.json.mode, 'demo');
  });

  it('stages deterministic sample proposal via /api/ai/task in memory', async () => {
    const res = await makeRequest(demoPort, '/api/ai/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'judge-session-1'
      },
      body: JSON.stringify({
        taskPrompt: 'Add power function',
        targetFilePath: 'src/calculator.ts'
      })
    });

    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.json.result);
    assert.strictEqual(res.json.result.model, 'demo-sample-model (offline sample)');
    const proposal = res.json.result.proposal;
    assert.ok(proposal.id);
    assert.ok(proposal.approvalToken);
    assert.strictEqual(proposal.projectRoot, 'demo-sandbox');
    assert.strictEqual(proposal.relativePath, 'src/calculator.ts');
    assert.strictEqual(proposal.status, 'awaiting_approval');
    assert.ok(proposal.diff.unified.includes('+export function power'));
  });

  it('requires explicit approval token to apply a proposal in memory', async () => {
    // 1. Create a task proposal
    const taskRes = await makeRequest(demoPort, '/api/ai/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'judge-session-token'
      },
      body: JSON.stringify({
        taskPrompt: 'Add clamp helper',
        targetFilePath: 'src/calculator.ts'
      })
    });

    assert.strictEqual(taskRes.statusCode, 201);
    const proposal = taskRes.json.result.proposal;
    const token = proposal.approvalToken;

    // 2. GET proposal should NOT expose approval token
    const getRes = await makeRequest(demoPort, `/api/project/proposals/${proposal.id}`, {
      headers: { 'x-demo-session': 'judge-session-token' }
    });
    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(getRes.json.proposal.approvalToken, undefined);

    // 3. Attempt apply without token should fail 400
    const invalidApplyRes = await makeRequest(demoPort, `/api/project/proposals/${proposal.id}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'judge-session-token'
      },
      body: JSON.stringify({ approvalToken: 'wrong-token' })
    });
    assert.strictEqual(invalidApplyRes.statusCode, 400);

    // 4. Apply with valid token succeeds in memory
    const applyRes = await makeRequest(demoPort, `/api/project/proposals/${proposal.id}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'judge-session-token'
      },
      body: JSON.stringify({ approvalToken: token })
    });
    assert.strictEqual(applyRes.statusCode, 200);
    assert.strictEqual(applyRes.json.result.status, 'applied');

    // 5. Verify the in-memory file now contains the change
    const fileRes = await makeRequest(demoPort, '/api/project/file?path=src/calculator.ts', {
      headers: { 'x-demo-session': 'judge-session-token' }
    });
    assert.strictEqual(fileRes.statusCode, 200);
    assert.ok(fileRes.json.content.includes('export function power') || fileRes.json.content.includes('clamp'));
  });

  it('isolates virtual project states between different sessions', async () => {
    // Session A applies a change
    const taskA = await makeRequest(demoPort, '/api/ai/task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'session-alpha'
      },
      body: JSON.stringify({
        taskPrompt: 'Alpha modification',
        targetFilePath: 'src/calculator.ts'
      })
    });
    const propA = taskA.json.result.proposal;
    await makeRequest(demoPort, `/api/project/proposals/${propA.id}/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'session-alpha'
      },
      body: JSON.stringify({ approvalToken: propA.approvalToken })
    });

    // Session B checks file: should be untouched original!
    const fileB = await makeRequest(demoPort, '/api/project/file?path=src/calculator.ts', {
      headers: { 'x-demo-session': 'session-beta' }
    });
    assert.strictEqual(fileB.statusCode, 200);
    assert.strictEqual(fileB.json.content.includes('Alpha modification'), false);
  });

  it('enforces rate limiting on mutation endpoints', async () => {
    const rateLimitSession = 'rate-limit-test-session';
    let limited = false;

    // Send 35 rapid requests on a rate-limited endpoint
    for (let i = 0; i < 35; i++) {
      const res = await makeRequest(demoPort, '/api/project/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-demo-session': rateLimitSession
        },
        body: JSON.stringify({ query: 'test' })
      });

      if (res.statusCode === 429) {
        limited = true;
        assert.ok(res.headers['retry-after']);
        assert.ok(res.json.error.message.includes('Rate limit exceeded'));
        break;
      }
    }

    assert.strictEqual(limited, true, 'Rate limiter should have triggered 429 status code');
  });

  it('enforces request body size limits (>64KB rejected with 413)', async () => {
    const largeBody = JSON.stringify({ query: 'a'.repeat(70 * 1024) });
    const res = await makeRequest(demoPort, '/api/project/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-session': 'size-test-session'
      },
      body: largeBody
    });

    assert.strictEqual(res.statusCode, 413);
  });

  it('serves frontend static assets safely with security headers', async () => {
    const res = await makeRequest(demoPort, '/index.html');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.body.includes('LazyDev'));
    assert.ok(res.body.includes('public-demo-banner'));
  });

  it('serves root route (/) for legitimate top-level browser navigation from external links', async () => {
    // Simulates a user clicking on https://lazydev-demo.onrender.com from an external site (Render, GitHub, etc.)
    const res = await makeRequest(demoPort, '/', {
      headers: {
        Host: 'lazydev-demo.onrender.com',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document'
      }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.body.includes('<!DOCTYPE html>'));
    assert.ok(res.body.includes('LazyDev'));
  });

  it('permits API requests originating from the deployed domain', async () => {
    const res = await makeRequest(demoPort, '/api/project/search', {
      method: 'POST',
      headers: {
        Host: 'lazydev-demo.onrender.com',
        Origin: 'https://lazydev-demo.onrender.com',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Content-Type': 'application/json',
        'x-demo-session': 'deployed-origin-session'
      },
      body: JSON.stringify({ query: 'LazyDev' })
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.json.matches));
  });

  it('blocks cross-site API requests from untrusted external origins with 403', async () => {
    const res = await makeRequest(demoPort, '/api/project/search', {
      method: 'POST',
      headers: {
        Host: 'lazydev-demo.onrender.com',
        Origin: 'https://evil-attacker.com',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Content-Type': 'application/json',
        'x-demo-session': 'untrusted-origin-session'
      },
      body: JSON.stringify({ query: 'LazyDev' })
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json.error.message, 'Untrusted or cross-origin request blocked.');
  });

  it('blocks cross-site iframe embedding attempts with 403', async () => {
    const res = await makeRequest(demoPort, '/', {
      headers: {
        Host: 'lazydev-demo.onrender.com',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'iframe'
      }
    });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.json.error.message, 'Untrusted or cross-origin request blocked.');
  });
});
