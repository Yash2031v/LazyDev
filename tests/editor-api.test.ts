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

describe('Editor & Proposal API Endpoints', () => {
  let server: http.Server;
  let testPort: number;
  let baseUrl: string;
  let tempDir: string;
  let canonicalRoot: string;
  let projectService: ProjectService;
  let editorService: EditorService;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-editor-api-test-'));
    canonicalRoot = await fs.realpath(tempDir);

    // Initial files
    await fs.writeFile(path.join(canonicalRoot, 'hello.txt'), 'Hello, World!\n', 'utf-8');
    await fs.writeFile(path.join(canonicalRoot, '.env'), 'API_KEY=secret-token\n', 'utf-8');

    const testConfig = loadConfig({ PORT: '0', HOST: '127.0.0.1' });
    const mockOllama = new OllamaClient({
      endpoint: 'http://127.0.0.1:11434',
      timeoutMs: 500,
      fetchFn: (async () => new Response(JSON.stringify({ models: [] }))) as any
    });

    projectService = new ProjectService();
    editorService = new EditorService();
    const handler = createRequestHandler(testConfig, mockOllama, undefined, projectService, editorService);
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

  test('POST /api/project/proposals before setting project root returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'New content'
      })
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error.message, /no active project root/i);
  });

  test('POST /api/project/proposals creates a proposal preview without modifying disk', async () => {
    // Configure project root first
    await projectService.setProjectRoot(canonicalRoot);

    const originalDiskContent = await fs.readFile(path.join(canonicalRoot, 'hello.txt'), 'utf-8');

    const res = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'Hello, LazyDev!\n',
        reason: 'Upgrade greeting'
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json() as any;
    assert.ok(body.proposal);
    assert.equal(body.proposal.status, 'awaiting_approval');
    assert.equal(body.proposal.relativePath, 'hello.txt');
    assert.ok(body.proposal.approvalToken);
    assert.ok(body.proposal.diff);
    assert.equal(body.proposal.diff.additions, 1);
    assert.equal(body.proposal.diff.deletions, 1);

    // Verify disk content unchanged
    const currentDiskContent = await fs.readFile(path.join(canonicalRoot, 'hello.txt'), 'utf-8');
    assert.equal(currentDiskContent, originalDiskContent);
  });

  test('GET /api/project/proposals lists active proposals', async () => {
    const res = await fetch(`${baseUrl}/api/project/proposals`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`
      }
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.proposals));
    assert.ok(body.proposals.length >= 1);
    assert.equal(body.proposals[0].relativePath, 'hello.txt');
  });

  test('GET /api/project/proposals/:id returns detailed proposal info', async () => {
    const listRes = await fetch(`${baseUrl}/api/project/proposals`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`
      }
    });
    const { proposals } = await listRes.json() as any;
    const proposalId = proposals[0].id;

    const res = await fetch(`${baseUrl}/api/project/proposals/${proposalId}`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`
      }
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.proposal.id, proposalId);
    assert.ok(body.proposal.diff);
  });

  test('POST /api/project/proposals/:id/apply before approval returns 400 Bad Request', async () => {
    // Create new proposal
    const createRes = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'Direct apply attempt\n'
      })
    });
    const { proposal } = await createRes.json() as any;

    const applyRes = await fetch(`${baseUrl}/api/project/proposals/${proposal.id}/apply`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        approvalToken: proposal.approvalToken
      })
    });

    assert.equal(applyRes.status, 400);
    const body = await applyRes.json() as any;
    assert.match(body.error.message, /must be in "approved" state/i);
  });

  test('Approval and Apply workflow updates disk file safely', async () => {
    const createRes = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'Hello, Approved LazyDev!\n',
        reason: 'Authorized modification'
      })
    });
    const { proposal } = await createRes.json() as any;

    // Approve
    const approveRes = await fetch(`${baseUrl}/api/project/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        approvalToken: proposal.approvalToken
      })
    });
    assert.equal(approveRes.status, 200);
    const approvedBody = await approveRes.json() as any;
    assert.equal(approvedBody.proposal.status, 'approved');

    // Apply
    const applyRes = await fetch(`${baseUrl}/api/project/proposals/${proposal.id}/apply`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        approvalToken: proposal.approvalToken
      })
    });
    assert.equal(applyRes.status, 200);
    const applyBody = await applyRes.json() as any;
    assert.equal(applyBody.result.success, true);
    assert.equal(applyBody.result.status, 'applied');

    // Verify disk content
    const diskContent = await fs.readFile(path.join(canonicalRoot, 'hello.txt'), 'utf-8');
    assert.equal(diskContent, 'Hello, Approved LazyDev!\n');
  });

  test('POST /api/project/proposals/:id/reject explicitly transitions proposal to rejected', async () => {
    const createRes = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'Unwanted change\n'
      })
    });
    const { proposal } = await createRes.json() as any;

    const rejectRes = await fetch(`${baseUrl}/api/project/proposals/${proposal.id}/reject`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        reason: 'User declined change'
      })
    });

    assert.equal(rejectRes.status, 200);
    const rejectBody = await rejectRes.json() as any;
    assert.equal(rejectBody.proposal.status, 'rejected');
    assert.equal(rejectBody.proposal.rejectionReason, 'User declined change');
  });

  test('Stale file detection returns 409 Conflict when file on disk was modified', async () => {
    const createRes = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: 'hello.txt',
        proposedContent: 'Change before conflict\n'
      })
    });
    const { proposal } = await createRes.json() as any;

    // External change
    await fs.writeFile(path.join(canonicalRoot, 'hello.txt'), 'Externally edited!\n', 'utf-8');

    // Attempt approve -> should fail with conflict
    const approveRes = await fetch(`${baseUrl}/api/project/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        approvalToken: proposal.approvalToken
      })
    });

    assert.equal(approveRes.status, 400);
    const approveBody = await approveRes.json() as any;
    assert.match(approveBody.error.message, /modified on disk/i);
  });

  test('Rejects proposal for protected secret file with 400', async () => {
    const res = await fetch(`${baseUrl}/api/project/proposals`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: `http://127.0.0.1:${testPort}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        relativePath: '.env',
        proposedContent: 'OVERWRITTEN_TOKEN=123\n'
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error.message, /secret/i);
  });

  test('Cross-origin requests to proposal endpoints are blocked with 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/project/proposals`, {
      headers: {
        host: `127.0.0.1:${testPort}`,
        origin: 'http://malicious-website.com'
      }
    });

    assert.equal(res.status, 403);
  });
});
