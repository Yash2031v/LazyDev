/**
 * LazyDev Public Demo — In-Memory Virtual Project Sandbox
 * Provides isolated, disposable sample project state for hosted public demos.
 * Absolutely ZERO server filesystem access, arbitrary path reads, or disk writes.
 */

import * as crypto from 'node:crypto';
import { generateUnifiedDiff } from '../editor/diff-engine.js';
import type { FileEditProposal, ProposalSummary } from '../editor/types.js';

export interface VirtualFile {
  readonly relativePath: string;
  content: string;
  sizeBytes: number;
  readonly isText: boolean;
  readonly extension: string;
}

export interface DemoSessionState {
  readonly id: string;
  lastAccess: number;
  files: Map<string, VirtualFile>;
  proposals: Map<string, FileEditProposal>;
}

const INITIAL_DEMO_FILES: readonly { path: string; content: string }[] = Object.freeze([
  {
    path: 'README.md',
    content: `# LazyDev Demo Sandbox\n\nWelcome to the LazyDev Public Demo!\nThis workspace is an isolated, in-memory virtual sandbox running safely on Render.\nAll file browsing, searches, AI proposals, and diff reviews operate strictly in memory.\n`
  },
  {
    path: 'src/index.ts',
    content: `import { add, multiply } from './calculator.js';\n\nexport function runDemo(): void {\n  const sum = add(10, 20);\n  const product = multiply(5, 4);\n  console.log(\`LazyDev Demo: sum=\${sum}, product=\${product}\`);\n}\n`
  },
  {
    path: 'src/calculator.ts',
    content: `/**\n * Safe demo calculator module\n */\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n\nexport function divide(a: number, b: number): number {\n  if (b === 0) {\n    throw new Error('Division by zero');\n  }\n  return a / b;\n}\n`
  }
]);

export class DemoProjectManager {
  private readonly sessions = new Map<string, DemoSessionState>();
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(maxSessions = 200, sessionTtlMs = 30 * 60_000) {
    this.maxSessions = maxSessions;
    this.sessionTtlMs = sessionTtlMs;

    if (typeof setInterval !== 'undefined') {
      this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 60_000);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  public getOrCreateSession(sessionId?: string): DemoSessionState {
    const id = sessionId && sessionId.trim() ? sessionId.trim() : 'default-demo-session';
    const now = Date.now();

    let session = this.sessions.get(id);
    if (session) {
      session.lastAccess = now;
      return session;
    }

    // Enforce bounded sessions
    if (this.sessions.size >= this.maxSessions) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, s] of this.sessions.entries()) {
        if (s.lastAccess < oldestTime) {
          oldestTime = s.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.sessions.delete(oldestKey);
      }
    }

    const files = new Map<string, VirtualFile>();
    for (const f of INITIAL_DEMO_FILES) {
      const ext = f.path.substring(f.path.lastIndexOf('.'));
      files.set(f.path, {
        relativePath: f.path,
        content: f.content,
        sizeBytes: Buffer.byteLength(f.content, 'utf8'),
        isText: true,
        extension: ext
      });
    }

    session = {
      id,
      lastAccess: now,
      files,
      proposals: new Map()
    };
    this.sessions.set(id, session);
    return session;
  }

  public getFiles(sessionId?: string) {
    const session = this.getOrCreateSession(sessionId);
    const filesList = Array.from(session.files.values()).map((f) => ({
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      isText: f.isText,
      extension: f.extension
    }));

    const totalSizeBytes = filesList.reduce((acc, f) => acc + f.sizeBytes, 0);

    return {
      canonicalRootPath: 'demo-sandbox',
      scannedAt: new Date().toISOString(),
      totalFiles: filesList.length,
      totalDirectories: 1,
      totalSizeBytes,
      files: filesList,
      skippedCount: 0,
      tree: [
        {
          name: 'README.md',
          path: 'README.md',
          type: 'file',
          sizeBytes: session.files.get('README.md')?.sizeBytes ?? 0,
          extension: '.md'
        },
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [
            {
              name: 'index.ts',
              path: 'src/index.ts',
              type: 'file',
              sizeBytes: session.files.get('src/index.ts')?.sizeBytes ?? 0,
              extension: '.ts'
            },
            {
              name: 'calculator.ts',
              path: 'src/calculator.ts',
              type: 'file',
              sizeBytes: session.files.get('src/calculator.ts')?.sizeBytes ?? 0,
              extension: '.ts'
            }
          ]
        }
      ]
    };
  }

  public getSummary(sessionId?: string) {
    const session = this.getOrCreateSession(sessionId);
    const filesList = Array.from(session.files.values());
    const totalSizeBytes = filesList.reduce((acc, f) => acc + f.sizeBytes, 0);

    const fileTypes: Record<string, number> = {};
    for (const f of filesList) {
      fileTypes[f.extension] = (fileTypes[f.extension] || 0) + 1;
    }

    return {
      canonicalRootPath: 'demo-sandbox',
      totalFiles: filesList.length,
      totalDirectories: 1,
      totalSizeBytes,
      fileTypes,
      skippedCount: 0
    };
  }

  public readFile(sessionId: string | undefined, relativePath: string) {
    const session = this.getOrCreateSession(sessionId);
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const file = session.files.get(normalized);
    if (!file) {
      throw new Error(`File not found in demo sandbox: "${relativePath}"`);
    }

    return {
      relativePath: file.relativePath,
      content: file.content,
      sizeBytes: file.sizeBytes,
      isTruncated: false
    };
  }

  public searchFiles(sessionId: string | undefined, query: string, caseSensitive = false, maxResults = 50) {
    const session = this.getOrCreateSession(sessionId);
    const results: { relativePath: string; lineNumber: number; lineContent: string }[] = [];

    const searchQuery = caseSensitive ? query : query.toLowerCase();

    for (const file of session.files.values()) {
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const target = caseSensitive ? line : line.toLowerCase();
        if (target.includes(searchQuery)) {
          results.push({
            relativePath: file.relativePath,
            lineNumber: i + 1,
            lineContent: line.trimEnd()
          });
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) break;
    }

    return {
      query,
      caseSensitive,
      totalMatches: results.length,
      matches: results
    };
  }

  public listProposals(sessionId?: string): ProposalSummary[] {
    const session = this.getOrCreateSession(sessionId);
    return Array.from(session.proposals.values()).map((p) => ({
      id: p.id,
      relativePath: p.relativePath,
      status: p.status,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      additions: p.diff.additions,
      deletions: p.diff.deletions,
      statusReason: p.statusReason
    }));
  }

  public getProposal(sessionId: string | undefined, proposalId: string): FileEditProposal {
    const session = this.getOrCreateSession(sessionId);
    const proposal = session.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: "${proposalId}"`);
    }
    return proposal;
  }

  public createProposal(sessionId: string | undefined, relativePath: string, proposedContent: string): FileEditProposal {
    const session = this.getOrCreateSession(sessionId);
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const file = session.files.get(normalized);
    if (!file) {
      throw new Error(`Cannot propose edit: file "${relativePath}" does not exist in demo sandbox.`);
    }

    const originalContent = file.content;
    const diff = generateUnifiedDiff(normalized, originalContent, proposedContent);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const proposalId = `demo-prop-${crypto.randomBytes(6).toString('hex')}`;
    const approvalToken = `token-${crypto.randomBytes(16).toString('hex')}`;

    const originalHash = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');
    const proposedHash = crypto.createHash('sha256').update(proposedContent, 'utf8').digest('hex');

    const proposal: FileEditProposal = {
      id: proposalId,
      projectRoot: 'demo-sandbox',
      relativePath: normalized,
      originalContent,
      proposedContent,
      originalHash,
      proposedHash,
      approvalToken,
      status: 'awaiting_approval',
      createdAt: now.toISOString(),
      expiresAt,
      diff
    };

    session.proposals.set(proposalId, proposal);
    return proposal;
  }

  public approveProposal(sessionId: string | undefined, proposalId: string, approvalToken: string): FileEditProposal {
    const session = this.getOrCreateSession(sessionId);
    const proposal = session.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: "${proposalId}"`);
    }

    if (proposal.approvalToken !== approvalToken) {
      throw new Error('Invalid approval token for proposal.');
    }

    if (proposal.status !== 'awaiting_approval' && proposal.status !== 'draft') {
      throw new Error(`Cannot approve proposal in "${proposal.status}" status.`);
    }

    proposal.status = 'approved';
    proposal.approvedAt = new Date().toISOString();
    return proposal;
  }

  public rejectProposal(sessionId: string | undefined, proposalId: string, reason?: string): FileEditProposal {
    const session = this.getOrCreateSession(sessionId);
    const proposal = session.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: "${proposalId}"`);
    }

    proposal.status = 'rejected';
    proposal.rejectionReason = reason || 'Rejected by user in demo mode.';
    proposal.resolvedAt = new Date().toISOString();
    return proposal;
  }

  public applyProposal(sessionId: string | undefined, proposalId: string, approvalToken: string) {
    const session = this.getOrCreateSession(sessionId);
    const proposal = session.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: "${proposalId}"`);
    }

    if (proposal.approvalToken !== approvalToken) {
      throw new Error('Invalid approval token for proposal application.');
    }

    if (proposal.status !== 'approved' && proposal.status !== 'awaiting_approval') {
      throw new Error(`Cannot apply proposal in status "${proposal.status}". Proposal must be approved.`);
    }

    const file = session.files.get(proposal.relativePath);
    if (!file) {
      throw new Error(`Target file "${proposal.relativePath}" no longer exists in demo sandbox.`);
    }

    // Apply change in memory
    file.content = proposal.proposedContent;
    file.sizeBytes = Buffer.byteLength(proposal.proposedContent, 'utf8');

    proposal.status = 'applied';
    proposal.resolvedAt = new Date().toISOString();

    return {
      success: true,
      status: 'applied' as const,
      proposalId: proposal.id,
      relativePath: proposal.relativePath,
      bytesWritten: file.sizeBytes,
      backupPath: 'in-memory-backup',
      appliedAt: proposal.resolvedAt
    };
  }

  public executeSampleTask(sessionId: string | undefined, targetFile?: string, prompt?: string) {
    const session = this.getOrCreateSession(sessionId);
    const chosenFile = targetFile && session.files.has(targetFile.replace(/\\/g, '/').replace(/^\/+/, ''))
      ? targetFile.replace(/\\/g, '/').replace(/^\/+/, '')
      : 'src/calculator.ts';

    const file = session.files.get(chosenFile);
    if (!file) {
      throw new Error(`Target file not found in demo sandbox: "${chosenFile}"`);
    }

    const promptText = (prompt || 'Add power and clamp helper functions').trim();
    let proposedContent = file.content;

    if (chosenFile === 'src/calculator.ts') {
      if (!proposedContent.includes('export function power')) {
        proposedContent = `${proposedContent.trimEnd()}\n\n/**\n * Demo transformation: added based on task prompt: "${promptText}"\n */\nexport function power(base: number, exponent: number): number {\n  return Math.pow(base, exponent);\n}\n\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n`;
      } else {
        proposedContent = `${proposedContent.trimEnd()}\n// Note: Demo task verified: "${promptText}" at ${new Date().toLocaleTimeString()}\n`;
      }
    } else {
      proposedContent = `// [Demo Mode Enhancement: "${promptText}"]\n${proposedContent}`;
    }

    const proposal = this.createProposal(sessionId, chosenFile, proposedContent);

    return {
      taskId: `demo-task-${crypto.randomBytes(4).toString('hex')}`,
      model: 'demo-sample-model (offline sample)',
      proposal,
      metadata: {
        promptTokens: 42,
        responseTokens: 88,
        durationMs: 35
      }
    };
  }

  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastAccess > this.sessionTtlMs) {
        this.sessions.delete(key);
      }
    }
  }
}
