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
import { EditorService } from '../src/server/editor/editor-service.js';
import { AiService } from '../src/server/ai/ai-service.js';

describe('AI Assistant API Endpoints', () => {
  let server: http.Server;
  let baseUrl: string;
  let tempDir: string;
  let projectService: ProjectService;
  let editorService: EditorService;
  let aiService: AiService;
  let mockOllama: OllamaClient;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-ai-api-test-'));
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'src', 'greet.ts'),
      'export function greet() { return "hi"; }\n',
      'utf-8'
    );

    const testConfig = loadConfig({ PORT: '0', HOST: '127.0.0.1' });

    mockOllama = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 2000,
      fetchFn: (async (url: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:3b' }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.endsWith('/api/chat')) {
          const modelOutput = JSON.stringify({
            file: 'src/greet.ts',
            explanation: 'Enhanced greeting with name parameter',
            content: 'export function greet(name: string) { return `hi ${name}`; }\n'
          });
          return new Response(
            JSON.stringify({
              model: 'qwen2.5-coder:7b',
              message: { role: 'assistant', content: modelOutput },
              done: true
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      }) as any
    });

    projectService = new ProjectService();
    await projectService.setProjectRoot(tempDir);
    editorService = new EditorService();
    aiService = new AiService(mockOllama, projectService, editorService);

    const handler = createRequestHandler(testConfig, mockOllama, undefined, projectService, editorService, aiService);
    server = http.createServer(handler);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
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

  test('GET /api/ai/models returns available models from Ollama', async () => {
    const res = await fetch(`${baseUrl}/api/ai/models`, {
      headers: { 'Accept': 'application/json' }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.models));
    assert.ok(data.models.includes('qwen2.5-coder:7b'));
    assert.ok(data.models.includes('llama3.2:3b'));
  });

  test('POST /api/ai/task stages an edit proposal via EditorService', async () => {
    const res = await fetch(`${baseUrl}/api/ai/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen2.5-coder:7b',
        targetFilePath: 'src/greet.ts',
        taskPrompt: 'Add name parameter to greet function'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.result.explanation, 'Enhanced greeting with name parameter');
    assert.equal(data.result.proposal.status, 'awaiting_approval');
    assert.equal(data.result.proposal.relativePath, 'src/greet.ts');
    assert.ok(data.result.proposal.diff.unified.includes('+export function greet(name: string)'));

    // File on disk must remain unwritten
    const disk = await fs.readFile(path.join(tempDir, 'src', 'greet.ts'), 'utf-8');
    assert.ok(!disk.includes('name: string'));
  });

  test('POST /api/ai/task rejects missing parameters with 400', async () => {
    const res = await fetch(`${baseUrl}/api/ai/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: '',
        targetFilePath: 'src/greet.ts',
        taskPrompt: ''
      })
    });

    assert.equal(res.status, 400);
  });

  test('POST /api/ai/cancel cancels active task', async () => {
    const res = await fetch(`${baseUrl}/api/ai/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ taskId: 'non-existent-task' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cancelled, false);
  });
});
