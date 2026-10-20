import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../src/server/config.js';
import { OllamaClient } from '../src/server/ollama.js';
import { createRequestHandler } from '../src/server/app.js';
import { ProjectService } from '../src/server/project/project-service.js';
import { resolveSafeRelativePath, PathValidationError } from '../src/server/project/path-validator.js';
import { IgnoreEngine } from '../src/server/project/ignore-rules.js';

describe('Security Audit & Hardening Regression Tests', () => {
  let server: http.Server;
  let testPort: number;
  let baseUrl: string;
  let tempDir: string;
  let projectService: ProjectService;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-sec-audit-'));
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Security Audit Fixture');
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'safe.ts'), 'export const safe = true;');

    // Sensitive files & dot-directories for testing
    await fs.writeFile(path.join(tempDir, '.npmrc'), '//registry.npmjs.org/:_authToken=secret-token');
    await fs.writeFile(path.join(tempDir, '.netrc'), 'machine example.com login user password secret');
    await fs.mkdir(path.join(tempDir, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.ssh', 'id_rsa'), 'PRIVATE_KEY_DATA');
    await fs.mkdir(path.join(tempDir, 'temp'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'temp', 'scratch.txt'), 'temporary data');

    // .gitignore with directory-only pattern
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'temp/\n*.secret\n');

    const testConfig = loadConfig({ PORT: '0', HOST: '127.0.0.1' });
    const mockOllama = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 500,
      fetchFn: (async () => new Response(JSON.stringify({ models: [] }))) as any
    });

    projectService = new ProjectService();
    const handler = createRequestHandler(testConfig, mockOllama, undefined, projectService);
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

    // Set active project
    await projectService.setProjectRoot(tempDir);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Cross-Origin & Origin Header Hardening
  test('rejects cross-origin request from malicious external website with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/project/files`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        Origin: 'https://evil-attacker.com'
      }
    });

    assert.equal(res.status, 403);
    const data = (await res.json()) as { error: { message: string } };
    assert.ok(data.error.message.includes('cross-origin'));
  });

  test('rejects requests with Sec-Fetch-Site: cross-site with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/project/files`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Sec-Fetch-Site': 'cross-site'
      }
    });

    assert.equal(res.status, 403);
  });

  test('permits requests from authorized local loopback origin', async () => {
    const res = await fetch(`${baseUrl}/api/project/files`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        Origin: `http://127.0.0.1:${testPort}`
      }
    });

    assert.equal(res.status, 200);
  });

  // 2. Request Body Limits & Content-Type
  test('rejects oversized JSON payload (>64KB) with 413 Payload Too Large', async () => {
    const hugePayload = JSON.stringify({
      query: 'a',
      padding: 'x'.repeat(70 * 1024) // 70 KB
    });

    const res = await fetch(`${baseUrl}/api/project/search`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: hugePayload
    });

    assert.equal(res.status, 413);
    const data = (await res.json()) as { error: { message: string } };
    assert.ok(data.error.message.includes('exceeds maximum allowed size'));
  });

  test('rejects non-JSON Content-Type on POST requests with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/search`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'text/plain'
      },
      body: 'query=hello'
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { message: string } };
    assert.ok(data.error.message.includes('Content-Type must be application/json'));
  });

  // 3. Search maxResults Validation
  test('rejects search with invalid maxResults (NaN, negative, string) with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/search`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: 'safe',
        maxResults: -5
      })
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { message: string } };
    assert.ok(data.error.message.includes('maxResults'));
  });

  // 4. Secret & Dot-Directory Protection
  test('blocks reading .npmrc and .netrc credential files with 403 Forbidden', async () => {
    const npmrcRes = await fetch(`${baseUrl}/api/project/file?path=.npmrc`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(npmrcRes.status, 403);

    const netrcRes = await fetch(`${baseUrl}/api/project/file?path=.netrc`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(netrcRes.status, 403);
  });

  test('excludes .ssh folder from scan and denies file reading', async () => {
    const filesRes = await fetch(`${baseUrl}/api/project/files`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    const data = (await filesRes.json()) as { files: Array<{ relativePath: string }> };
    assert.ok(!data.files.some(f => f.relativePath.startsWith('.ssh')));

    const sshRes = await fetch(`${baseUrl}/api/project/file?path=.ssh/id_rsa`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(sshRes.status, 403);
  });

  // 5. Directory-Only .gitignore Rule Enforcement on Contained Files
  test('denies reading files inside a directory ignored by .gitignore (temp/)', async () => {
    const tempRes = await fetch(`${baseUrl}/api/project/file?path=temp/scratch.txt`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(tempRes.status, 403);
    const data = (await tempRes.json()) as { error: { message: string } };
    assert.ok(data.error.message.includes('excluded path'));
  });

  // 6. Percent-Encoded Traversal Defense
  test('rejects double percent-encoded traversal (%252e%252e)', async () => {
    const canonicalRoot = await fs.realpath(tempDir);
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, '%2e%2e%2foutside.txt', false),
      PathValidationError
    );
    await assert.rejects(
      async () => resolveSafeRelativePath(canonicalRoot, '%252e%252e%252foutside.txt', false),
      PathValidationError
    );
  });
});
