import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, ConfigError } from '../src/server/config.js';
import { OllamaClient } from '../src/server/ollama.js';
import { ProjectService } from '../src/server/project/project-service.js';
import { EditorService } from '../src/server/editor/editor-service.js';
import { AiService } from '../src/server/ai/ai-service.js';
import { startServer, ServerInstance } from '../src/server/index.js';

describe('LazyDev Demo Mode (Ollama-Free)', () => {
  let tmpDir: string;
  let testFileRel: string;
  let testFileAbs: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-demo-test-'));
    testFileRel = 'app.js';
    testFileAbs = path.join(tmpDir, testFileRel);
    fs.writeFileSync(testFileAbs, 'console.log("hello world");\n', 'utf8');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadConfig validates LAZYDEV_AI_MODE correctly', () => {
    // Default mode is ollama
    const defaultCfg = loadConfig({});
    assert.equal(defaultCfg.aiMode, 'ollama');

    // Explicit demo mode
    const demoCfg = loadConfig({ LAZYDEV_AI_MODE: 'demo' });
    assert.equal(demoCfg.aiMode, 'demo');

    // Case-insensitive demo mode
    const demoUpperCfg = loadConfig({ LAZYDEV_AI_MODE: 'DEMO' });
    assert.equal(demoUpperCfg.aiMode, 'demo');

    // Rejects invalid AI mode
    assert.throws(
      () => loadConfig({ LAZYDEV_AI_MODE: 'cloud-openai' }),
      ConfigError
    );
  });

  test('AiService in demo mode returns demo models without contacting Ollama', async () => {
    // Point Ollama client at a non-existent port
    const offlineOllamaClient = new OllamaClient({
      endpoint: 'http://127.0.0.1:19999',
      timeoutMs: 500
    });
    const projectService = new ProjectService();
    const editorService = new EditorService(projectService);

    const demoAiService = new AiService(
      offlineOllamaClient,
      projectService,
      editorService,
      undefined,
      'demo'
    );

    assert.equal(demoAiService.mode, 'demo');

    // Must return immediately with clearly labeled demo model and NOT throw offline error
    const models = await demoAiService.getAvailableModels();
    assert.equal(models.length, 1);
    assert.ok(models[0].includes('demo'));
    assert.ok(models[0].includes('offline sample'));
  });

  test('AiService generates deterministic sample proposal with approval protections and no Ollama calls', async () => {
    const offlineOllamaClient = new OllamaClient({
      endpoint: 'http://127.0.0.1:19999',
      timeoutMs: 500
    });
    const projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);

    const editorService = new EditorService(projectService);
    const demoAiService = new AiService(
      offlineOllamaClient,
      projectService,
      editorService,
      undefined,
      'demo'
    );

    const result = await demoAiService.executeTask({
      taskPrompt: 'Add error handling logging',
      targetFilePath: testFileRel,
      model: 'demo-sample-model (offline sample)'
    });

    assert.ok(result.taskId);
    assert.ok(result.proposal);
    assert.equal(result.proposal.status, 'awaiting_approval');
    assert.ok(result.explanation.includes('[DEMO MODE SAMPLE]'));
    assert.ok(result.explanation.includes('No AI model was contacted'));

    // Verify diff includes sample comment banner
    assert.ok(result.proposal.diff.unified.includes('[DEMO MODE SAMPLE]'));
    assert.ok(result.proposal.diff.unified.includes('Add error handling logging'));

    // Crucial safety check: file on disk MUST NOT be modified by proposal creation
    const diskBefore = fs.readFileSync(testFileAbs, 'utf8');
    assert.equal(diskBefore, 'console.log("hello world");\n');

    // Rejecting the sample proposal leaves disk untouched
    const rejected = await editorService.rejectProposal(
      result.proposal.id,
      'User declined sample',
      tmpDir
    );
    assert.equal(rejected.status, 'rejected');
    const diskAfterReject = fs.readFileSync(testFileAbs, 'utf8');
    assert.equal(diskAfterReject, 'console.log("hello world");\n');
  });

  test('Explicit approve and apply workflow succeeds for demo proposal', async () => {
    const offlineOllamaClient = new OllamaClient({
      endpoint: 'http://127.0.0.1:19999',
      timeoutMs: 500
    });
    const projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);

    const editorService = new EditorService(projectService);
    const demoAiService = new AiService(
      offlineOllamaClient,
      projectService,
      editorService,
      undefined,
      'demo'
    );

    const result = await demoAiService.executeTask({
      taskPrompt: 'Add safety comment',
      targetFilePath: testFileRel,
      model: 'demo-sample-model (offline sample)'
    });

    // Applying without approval is blocked
    await assert.rejects(
      async () => {
        await editorService.applyProposal(
          result.proposal.id,
          'invalid-token',
          tmpDir
        );
      },
      /must be in "approved" state|Token does not match/i
    );

    // Approve proposal with valid single-use token
    const approved = await editorService.approveProposal(
      result.proposal.id,
      result.proposal.approvalToken,
      tmpDir
    );
    assert.equal(approved.status, 'approved');

    // Apply change to disk
    const applyResult = await editorService.applyProposal(
      result.proposal.id,
      result.proposal.approvalToken,
      tmpDir
    );
    assert.equal(applyResult.success, true);

    // File on disk is now safely updated
    const diskAfterApply = fs.readFileSync(testFileAbs, 'utf8');
    assert.ok(diskAfterApply.includes('[DEMO MODE SAMPLE]'));
    assert.ok(diskAfterApply.includes('console.log("hello world");'));

    // Backup was created
    assert.ok(applyResult.backupPath);
    assert.ok(fs.existsSync(applyResult.backupPath));
  });

  test('Demo mode strictly enforces secret file boundaries', async () => {
    const offlineOllamaClient = new OllamaClient({
      endpoint: 'http://127.0.0.1:19999',
      timeoutMs: 500
    });
    const projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);

    const editorService = new EditorService(projectService);
    const demoAiService = new AiService(
      offlineOllamaClient,
      projectService,
      editorService,
      undefined,
      'demo'
    );

    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET_TOKEN=123\n');

    await assert.rejects(
      async () => {
        await demoAiService.executeTask({
          taskPrompt: 'Modify secret file',
          targetFilePath: '.env',
          model: 'demo-sample-model (offline sample)'
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes('protected as a secret credential') || err.message.includes('Cannot target file'));
        return true;
      }
    );
  });

  test('Full HTTP Server lifecycle in Demo Mode when Ollama is offline', async () => {
    // Start server with port 0 and Ollama on dead port 19999
    const demoConfig = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      OLLAMA_HOST: 'http://127.0.0.1:19999',
      OLLAMA_TIMEOUT_MS: '500',
      LAZYDEV_AI_MODE: 'demo'
    });

    const projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);
    const editorService = new EditorService(projectService);

    const serverInstance = await startServer(
      demoConfig,
      undefined,
      projectService,
      editorService
    );

    const addr = serverInstance.server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      // 1. GET /api/status - returns fast without polling Ollama
      const statusRes = await fetch(`${origin}/api/status`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.aiMode, 'demo');
      assert.equal(statusData.ollama.connected, false);
      assert.equal(statusData.ollama.details, 'Demo Mode — no AI model connected.');

      // 2. GET /api/ai/models - returns demo models immediately
      const modelsRes = await fetch(`${origin}/api/ai/models`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(modelsRes.status, 200);
      const modelsData = await modelsRes.json();
      assert.equal(modelsData.mode, 'demo');
      assert.ok(modelsData.models.length > 0);
      assert.ok(modelsData.models[0].includes('demo'));

      // 3. POST /api/ai/task - generates demo proposal via HTTP
      const taskRes = await fetch(`${origin}/api/ai/task`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          taskPrompt: 'Add documentation header',
          targetFilePath: testFileRel,
          model: 'demo-sample-model (offline sample)'
        })
      });
      assert.equal(taskRes.status, 201);
      const taskData = await taskRes.json();
      const proposalId = taskData.result?.proposal?.id;
      assert.ok(proposalId);
      assert.ok(taskData.result?.explanation?.includes('[DEMO MODE SAMPLE]'));

      // 4. GET /api/project/proposals/:id - verifies non-empty diff and metadata
      const propDetailRes = await fetch(`${origin}/api/project/proposals/${proposalId}`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(propDetailRes.status, 200);
      const propDetail = await propDetailRes.json();
      assert.ok(propDetail.proposal);
      assert.equal(propDetail.proposal.relativePath, testFileRel);
      assert.equal(propDetail.proposal.status, 'awaiting_approval');
      assert.ok(propDetail.proposal.diff);
      assert.ok(propDetail.proposal.diff.unified.length > 0);
      assert.ok(propDetail.proposal.diff.unified.includes('[DEMO MODE SAMPLE]'));
      assert.ok(propDetail.proposal.diff.additions > 0);

      // 5. GET /api/project/proposals/:nonexistent - safely returns 404
      const notFoundRes = await fetch(`${origin}/api/project/proposals/nonexistent-id-12345`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(notFoundRes.status, 404);

      // 6. GET /app.js - client asset is served correctly and syntactically valid
      const appJsRes = await fetch(`${origin}/app.js`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(appJsRes.status, 200);
      const appJsText = await appJsRes.text();
      assert.ok(appJsText.includes('loadAiModels'));
      assert.ok(appJsText.includes('Demo Mode — no AI model connected'));
    } finally {
      await serverInstance.close();
    }
  });

  test('Default Ollama mode does NOT activate demo mode when Ollama is offline', async () => {
    const offlineConfig = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      OLLAMA_HOST: 'http://127.0.0.1:19999',
      OLLAMA_TIMEOUT_MS: '200',
      LAZYDEV_AI_MODE: 'ollama'
    });

    const projectService = new ProjectService();
    await projectService.setProjectRoot(tmpDir);
    const editorService = new EditorService(projectService);

    const serverInstance = await startServer(
      offlineConfig,
      undefined,
      projectService,
      editorService
    );

    const addr = serverInstance.server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      // GET /api/status shows Ollama offline, NOT demo mode
      const statusRes = await fetch(`${origin}/api/status`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.aiMode, 'ollama');
      assert.equal(statusData.ollama.connected, false);

      // GET /api/ai/models returns empty list, NOT demo models
      const modelsRes = await fetch(`${origin}/api/ai/models`, {
        headers: { Host: `127.0.0.1:${port}` }
      });
      assert.equal(modelsRes.status, 200);
      const modelsData = await modelsRes.json();
      assert.equal(modelsData.mode, 'ollama');
      assert.equal(modelsData.models.length, 0);

      // POST /api/ai/task fails with 503 Service Unavailable, NEVER falling back to demo
      const taskRes = await fetch(`${origin}/api/ai/task`, {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          taskPrompt: 'Add documentation header',
          targetFilePath: testFileRel,
          model: 'qwen2.5-coder:7b'
        })
      });
      assert.equal(taskRes.status, 503);
    } finally {
      await serverInstance.close();
    }
  });
});
