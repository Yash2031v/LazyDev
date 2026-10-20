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

describe('Project API Endpoints', () => {
  let server: http.Server;
  let testPort: number;
  let baseUrl: string;
  let tempDir: string;
  let projectService: ProjectService;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-api-test-'));
    await fs.writeFile(path.join(tempDir, 'README.md'), '# API Test Fixture');
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'main.ts'), 'export const magic = 42;');
    await fs.writeFile(path.join(tempDir, '.env'), 'TOKEN=xyz');

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
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('GET /api/project/root before setting root reports null', async () => {
    const res = await fetch(`${baseUrl}/api/project/root`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { root: string | null; hasActiveProject: boolean };
    assert.equal(data.root, null);
    assert.equal(data.hasActiveProject, false);
  });

  test('POST /api/project/root sets and scans valid project directory', async () => {
    const res = await fetch(`${baseUrl}/api/project/root`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: tempDir })
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { message: string; root: string; scan: { files: any[] } };
    assert.ok(data.message.includes('successfully'));
    assert.ok(typeof data.root === 'string');
    assert.ok(data.scan.files.length >= 2);
  });

  test('POST /api/project/root rejects nonexistent path with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/root`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: path.join(tempDir, 'nonexistent') })
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(data.error.code, 400);
  });

  test('GET /api/project/files returns indexed files list and skipped files', async () => {
    const res = await fetch(`${baseUrl}/api/project/files`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { files: Array<{ relativePath: string }>; skippedFiles: Array<{ relativePath: string }> };
    assert.ok(data.files.some(f => f.relativePath === 'src/main.ts'));
    assert.ok(data.skippedFiles.some(s => s.relativePath === '.env'));
  });

  test('GET /api/project/summary returns file types and counts', async () => {
    const res = await fetch(`${baseUrl}/api/project/summary`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { totalFiles: number; fileTypes: Record<string, number> };
    assert.ok(data.totalFiles >= 2);
    assert.ok(data.fileTypes['.ts'] >= 1);
  });

  test('GET /api/project/file returns permitted file content', async () => {
    const res = await fetch(`${baseUrl}/api/project/file?path=src/main.ts`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { relativePath: string; content: string };
    assert.equal(data.relativePath, 'src/main.ts');
    assert.ok(data.content.includes('magic = 42'));
  });

  test('GET /api/project/file rejects secret files with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/project/file?path=.env`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 403);
    const data = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(data.error.code, 403);
    assert.ok(data.error.message.includes('Access denied'));
  });

  test('GET /api/project/file rejects path traversal with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/file?path=../outside.txt`, {
      headers: { host: `127.0.0.1:${testPort}` }
    });

    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(data.error.code, 400);
  });

  test('POST /api/project/search returns matching lines and relative paths', async () => {
    const res = await fetch(`${baseUrl}/api/project/search`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: 'magic' })
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { query: string; totalMatches: number; matches: Array<{ relativePath: string; lineNumber: number }> };
    assert.equal(data.query, 'magic');
    assert.equal(data.totalMatches, 1);
    assert.equal(data.matches[0]?.relativePath, 'src/main.ts');
  });

  test('POST /api/project/search rejects missing or empty query with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/search`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: '' })
    });

    assert.equal(res.status, 400);
  });
});
