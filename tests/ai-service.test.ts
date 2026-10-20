import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OllamaClient } from '../src/server/ollama.js';
import { ProjectService } from '../src/server/project/project-service.js';
import { EditorService } from '../src/server/editor/editor-service.js';
import { AiService, AiServiceError } from '../src/server/ai/ai-service.js';

describe('AiService', () => {
  let tmpDir: string;
  let projectService: ProjectService;
  let editorService: EditorService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-ai-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'math.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
      'utf8'
    );
    await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET_API_KEY=12345\n', 'utf8');

    projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);
    editorService = new EditorService();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup error
    }
  });

  test('successfully executes end-to-end task and stages permission-gated proposal without modifying disk', async () => {
    const mockModelOutput = JSON.stringify({
      file: 'src/math.ts',
      explanation: 'Added subtract function',
      content: 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n'
    });

    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          model: 'qwen2.5-coder:7b',
          message: { role: 'assistant', content: mockModelOutput },
          done: true,
          total_duration: 1000000000
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 5000,
      fetchFn: mockFetch as any
    });

    const aiService = new AiService(client, projectService, editorService);

    const result = await aiService.executeTask({
      model: 'qwen2.5-coder:7b',
      targetFilePath: 'src/math.ts',
      taskPrompt: 'Add sub function'
    });

    assert.ok(result.taskId);
    assert.equal(result.explanation, 'Added subtract function');
    assert.equal(result.proposal.status, 'awaiting_approval');
    assert.equal(result.proposal.relativePath, 'src/math.ts');
    assert.ok(result.proposal.diff.unified.includes('+export function sub'));

    // Critical safety check: Disk must NOT be modified yet!
    const diskContent = await fs.readFile(path.join(tmpDir, 'src', 'math.ts'), 'utf8');
    assert.ok(!diskContent.includes('export function sub'));
  });

  test('rejects execution when no active project root is set', async () => {
    const unconfiguredProject = new ProjectService();
    const client = new OllamaClient({ endpoint: 'http://127.0.0.1:11434', timeoutMs: 2000 });
    const aiService = new AiService(client, unconfiguredProject, editorService);

    await assert.rejects(
      async () => {
        await aiService.executeTask({
          model: 'qwen2.5-coder:7b',
          targetFilePath: 'src/math.ts',
          taskPrompt: 'Do work'
        });
      },
      (err: any) => {
        assert.ok(err instanceof AiServiceError);
        assert.ok(err.message.includes('No active project root set'));
        return true;
      }
    );
  });

  test('strictly denies targeting secret files (.env)', async () => {
    const client = new OllamaClient({ endpoint: 'http://127.0.0.1:11434', timeoutMs: 2000 });
    const aiService = new AiService(client, projectService, editorService);

    await assert.rejects(
      async () => {
        await aiService.executeTask({
          model: 'qwen2.5-coder:7b',
          targetFilePath: '.env',
          taskPrompt: 'Update secret'
        });
      },
      (err: any) => {
        assert.ok(err instanceof AiServiceError);
        assert.ok(err.message.includes('secret') || err.message.includes('Cannot target file'));
        return true;
      }
    );
  });

  test('supports isolated task cancellation during execution', async () => {
    const mockFetch = async (_url: any, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    const client = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 5000,
      fetchFn: mockFetch as any
    });

    const aiService = new AiService(client, projectService, editorService);

    const taskPromise = aiService.executeTask({
      taskId: 'my-cancellable-task',
      model: 'qwen2.5-coder:7b',
      targetFilePath: 'src/math.ts',
      taskPrompt: 'Long running task'
    });

    assert.equal(aiService.isTaskActive('my-cancellable-task'), true);

    // Cancel task
    const cancelled = aiService.cancelTask('my-cancellable-task');
    assert.equal(cancelled, true);

    await assert.rejects(
      taskPromise,
      (err: any) => {
        assert.ok(err.code === 'ABORTED' || err.message.includes('aborted'));
        return true;
      }
    );

    assert.equal(aiService.isTaskActive('my-cancellable-task'), false);
  });
});
