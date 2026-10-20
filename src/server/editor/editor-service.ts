/**
 * LazyDev File Editor & Explicit Approval State Machine
 * Manages proposal lifecycle, diff generation, approval token verification, atomic writes, and backups.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  FileEditProposal,
  ProposalApplyResult,
  ProposalCreateRequest,
  ProposalSummary
} from './types.js';
import { generateUnifiedDiff } from './diff-engine.js';
import { resolveSafeRelativePath, PathValidationError } from '../project/path-validator.js';
import { IgnoreEngine } from '../project/ignore-rules.js';
import { isBinaryExtension } from '../project/binary-detector.js';

export class ProposalError extends Error {
  constructor(message: string) {
    super(`[LazyDev Proposal Error] ${message}`);
    this.name = 'ProposalError';
  }
}

export class ProposalNotFoundError extends ProposalError {
  constructor(id: string) {
    super(`Proposal "${id}" not found.`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalConflictError extends ProposalError {
  constructor(message: string) {
    super(`Conflict detected: ${message}`);
    this.name = 'ProposalConflictError';
  }
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function safeTokenCompare(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const bufA = Buffer.from(provided, 'utf-8');
  const bufB = Buffer.from(expected, 'utf-8');
  if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface EditorServiceOptions {
  readonly maxFileSizeBytes?: number;
  readonly defaultTtlMs?: number;
}

export class EditorService {
  private readonly proposals = new Map<string, FileEditProposal>();
  private readonly activeApplying = new Set<string>();
  private readonly maxFileSizeBytes: number;
  private readonly defaultTtlMs: number;

  constructor(options?: EditorServiceOptions) {
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? 512 * 1024;
    this.defaultTtlMs = options?.defaultTtlMs ?? 15 * 60 * 1000;
  }

  /**
   * Creates a new file edit proposal.
   * Guarantees zero disk modifications during proposal creation.
   */
  async createProposal(
    canonicalProjectRoot: string,
    ignoreEngine: IgnoreEngine,
    request: ProposalCreateRequest
  ): Promise<FileEditProposal> {
    if (!request.relativePath || typeof request.relativePath !== 'string') {
      throw new PathValidationError('Missing or invalid "relativePath".');
    }

    const newContent = request.newContent ?? request.proposedContent;
    if (typeof newContent !== 'string') {
      throw new PathValidationError('Missing or invalid "newContent" string.');
    }

    const proposedBuffer = Buffer.from(newContent, 'utf-8');
    if (proposedBuffer.length > this.maxFileSizeBytes) {
      throw new ProposalError(`Proposed content (${proposedBuffer.length} bytes) exceeds limit of ${this.maxFileSizeBytes} bytes.`);
    }

    // Validate path boundary
    const { fullPath, normalizedRelative } = await resolveSafeRelativePath(
      canonicalProjectRoot,
      request.relativePath,
      false // do not require existing file, can propose new file
    );

    // Guard against secrets and ignored files
    if (ignoreEngine.isSecret(normalizedRelative)) {
      throw new ProposalError(`Access denied: "${normalizedRelative}" is protected as a secret credential.`);
    }

    const ignoreCheck = ignoreEngine.shouldIgnore(normalizedRelative, false);
    if (ignoreCheck.ignored) {
      throw new ProposalError(`Access denied: "${normalizedRelative}" is an excluded path.`);
    }

    if (isBinaryExtension(normalizedRelative)) {
      throw new ProposalError(`File "${normalizedRelative}" has a binary extension and cannot be edited as text.`);
    }

    // Read existing file if present
    let originalContent = '';
    let fileExists = false;
    let fileHandle: fs.FileHandle | null = null;

    try {
      fileHandle = await fs.open(fullPath, 'r');
      const stat = await fileHandle.stat();
      if (!stat.isFile()) {
        throw new ProposalError(`Path "${normalizedRelative}" is not a regular file.`);
      }

      if (stat.size > this.maxFileSizeBytes) {
        throw new ProposalError(`Existing file "${normalizedRelative}" exceeds maximum allowed size of ${this.maxFileSizeBytes} bytes.`);
      }

      // Check header for null bytes
      const probeSize = Math.min(512, stat.size);
      if (probeSize > 0) {
        const probeBuffer = Buffer.alloc(probeSize);
        const { bytesRead } = await fileHandle.read(probeBuffer, 0, probeSize, 0);
        for (let i = 0; i < bytesRead; i++) {
          if (probeBuffer[i] === 0x00) {
            throw new ProposalError(`Existing file "${normalizedRelative}" is binary and cannot be edited.`);
          }
        }
      }

      originalContent = await fileHandle.readFile({ encoding: 'utf-8' });
      fileExists = true;
    } catch (err: unknown) {
      if (err instanceof ProposalError) throw err;
      // File does not exist yet (creating a new file); originalContent remains ''
      fileExists = false;
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }

    const originalHash = fileExists ? sha256(originalContent) : '';
    const proposedHash = sha256(newContent);

    if (fileExists && originalHash === proposedHash) {
      throw new ProposalError('Proposed changes are identical to the current file content.');
    }

    const diff = generateUnifiedDiff(normalizedRelative, originalContent, newContent);

    const id = crypto.randomUUID();
    const approvalToken = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const proposal: FileEditProposal = {
      id,
      projectRoot: canonicalProjectRoot,
      relativePath: normalizedRelative,
      originalContent,
      proposedContent: newContent,
      originalHash,
      proposedHash,
      approvalToken,
      status: 'awaiting_approval',
      createdAt: now.toISOString(),
      expiresAt,
      diff
    };

    this.proposals.set(id, proposal);
    return proposal;
  }

  /**
   * Retrieves proposal by ID and checks for expiration or on-disk conflict.
   */
  async getProposal(id: string, currentProjectRoot?: string): Promise<FileEditProposal> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new ProposalNotFoundError(id);
    }

    if (currentProjectRoot && proposal.projectRoot.toLowerCase() !== currentProjectRoot.toLowerCase()) {
      throw new ProposalError(`Proposal "${id}" belongs to a different project root.`);
    }

    // Check expiration if awaiting approval
    if (proposal.status === 'awaiting_approval' && Date.now() > new Date(proposal.expiresAt).getTime()) {
      proposal.status = 'expired';
      proposal.statusReason = 'Proposal expired before user approval.';
      proposal.resolvedAt = new Date().toISOString();
      return proposal;
    }

    // Check on-disk conflict if awaiting approval
    if (proposal.status === 'awaiting_approval' && proposal.originalHash) {
      try {
        const fullPath = path.resolve(proposal.projectRoot, proposal.relativePath);
        const currentContent = await fs.readFile(fullPath, 'utf-8');
        const currentHash = sha256(currentContent);

        if (currentHash !== proposal.originalHash) {
          proposal.status = 'conflict';
          proposal.statusReason = 'File has been modified on disk since diff preview was generated.';
          proposal.resolvedAt = new Date().toISOString();
        }
      } catch {
        proposal.status = 'conflict';
        proposal.statusReason = 'Underlying file was removed or is unreadable.';
        proposal.resolvedAt = new Date().toISOString();
      }
    }

    return proposal;
  }

  /**
   * Lists active proposals.
   */
  listProposals(currentProjectRoot?: string): ProposalSummary[] {
    const results: ProposalSummary[] = [];

    for (const p of this.proposals.values()) {
      if (currentProjectRoot && p.projectRoot.toLowerCase() !== currentProjectRoot.toLowerCase()) {
        continue;
      }
      results.push({
        id: p.id,
        relativePath: p.relativePath,
        status: p.status,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        additions: p.diff.additions,
        deletions: p.diff.deletions,
        statusReason: p.statusReason
      });
    }

    return results;
  }

  /**
   * Explicitly approves a proposal using its cryptographic single-use token.
   */
  async approveProposal(
    id: string,
    approvalToken: string,
    currentProjectRoot: string
  ): Promise<FileEditProposal> {
    if (this.activeApplying.has(id)) {
      throw new ProposalError(`Proposal "${id}" is currently being applied.`);
    }

    const proposal = await this.getProposal(id, currentProjectRoot);

    if (proposal.status === 'conflict') {
      throw new ProposalConflictError(proposal.statusReason || 'File has been modified on disk.');
    }
    if (proposal.status === 'expired') {
      throw new ProposalError('Proposal has expired.');
    }
    if (proposal.status !== 'awaiting_approval') {
      throw new ProposalError(`Only proposals awaiting approval can be approved (current state: "${proposal.status}").`);
    }

    if (!safeTokenCompare(approvalToken, proposal.approvalToken)) {
      throw new ProposalError('Invalid or unauthorized approval token.');
    }

    proposal.status = 'approved';
    proposal.approvedAt = new Date().toISOString();
    proposal.resolvedAt = proposal.approvedAt;
    return proposal;
  }

  /**
   * Explicitly rejects a proposal.
   */
  async rejectProposal(
    id: string,
    reason: string | undefined,
    currentProjectRoot: string
  ): Promise<FileEditProposal> {
    if (this.activeApplying.has(id)) {
      throw new ProposalError(`Cannot reject proposal "${id}" while it is being applied.`);
    }

    const proposal = await this.getProposal(id, currentProjectRoot);

    if (proposal.status === 'applied') {
      throw new ProposalError('Cannot reject a proposal that has already been applied.');
    }

    proposal.status = 'rejected';
    proposal.rejectionReason = reason;
    proposal.statusReason = reason || 'Rejected by user.';
    proposal.resolvedAt = new Date().toISOString();
    return proposal;
  }

  /**
   * Applies an approved proposal to disk using atomic replacement and backup creation.
   * Enforces revalidation of boundary, ignore rules, symlinks, file type, size, and file hash.
   */
  async applyProposal(
    id: string,
    approvalToken: string,
    currentProjectRoot: string,
    ignoreEngine?: IgnoreEngine
  ): Promise<ProposalApplyResult> {
    if (this.activeApplying.has(id)) {
      throw new ProposalError(`Proposal "${id}" is already currently being applied.`);
    }

    this.activeApplying.add(id);

    try {
      const proposal = await this.getProposal(id, currentProjectRoot);

      if (proposal.status === 'conflict') {
        throw new ProposalConflictError(proposal.statusReason || 'File has been modified on disk.');
      }
      if (proposal.status === 'expired') {
        throw new ProposalError('Proposal has expired.');
      }
      if (proposal.status !== 'approved') {
        throw new ProposalError(`Proposal must be in "approved" state to be applied (current state: "${proposal.status}").`);
      }

      if (!safeTokenCompare(approvalToken, proposal.approvalToken)) {
        throw new ProposalError('Invalid or unauthorized approval token.');
      }

      // 1. Re-validate safe path within active project root
      const { fullPath: targetPath, normalizedRelative } = await resolveSafeRelativePath(
        currentProjectRoot,
        proposal.relativePath,
        false
      );
      const targetDir = path.dirname(targetPath);

      // 2. Re-validate ignore engine and secret protections
      if (ignoreEngine) {
        if (ignoreEngine.isSecret(normalizedRelative)) {
          throw new ProposalError(`Access denied: "${normalizedRelative}" is protected as a secret credential.`);
        }
        const ignoreCheck = ignoreEngine.shouldIgnore(normalizedRelative, false);
        if (ignoreCheck.ignored) {
          throw new ProposalError(`Access denied: "${normalizedRelative}" is an excluded path.`);
        }
      }

      // 3. Re-validate binary file restriction
      if (isBinaryExtension(normalizedRelative)) {
        throw new ProposalError(`File "${normalizedRelative}" has a binary extension and cannot be edited as text.`);
      }

      // 4. Re-validate content size limit
      const proposedBuffer = Buffer.from(proposal.proposedContent, 'utf-8');
      if (proposedBuffer.length > this.maxFileSizeBytes) {
        throw new ProposalError(`Proposed content (${proposedBuffer.length} bytes) exceeds limit of ${this.maxFileSizeBytes} bytes.`);
      }

      // 5. Re-validate symlink safety on target file
      try {
        const lstat = await fs.lstat(targetPath);
        if (lstat.isSymbolicLink()) {
          throw new ProposalError(`Target "${normalizedRelative}" is a symbolic link. Modifying symlinks is forbidden.`);
        }
        if (!lstat.isFile()) {
          throw new ProposalError(`Target "${normalizedRelative}" exists and is not a regular file.`);
        }
      } catch (err: unknown) {
        if (err instanceof ProposalError) throw err;
        // ENOENT is acceptable for new file creation
      }

      // 6. Re-verify that target on disk has not changed since approval
      if (proposal.originalHash) {
        let currentContent: string;
        try {
          currentContent = await fs.readFile(targetPath, 'utf-8');
        } catch {
          proposal.status = 'conflict';
          proposal.statusReason = 'Target file is no longer readable on disk.';
          throw new ProposalConflictError(proposal.statusReason);
        }

        if (sha256(currentContent) !== proposal.originalHash) {
          proposal.status = 'conflict';
          proposal.statusReason = 'Target file was modified on disk prior to application.';
          throw new ProposalConflictError(proposal.statusReason);
        }
      }

      // 7. Ensure target directory exists
      await fs.mkdir(targetDir, { recursive: true });

      // 8. Create backup if file previously existed
      const backupPath = path.join(targetDir, `.lazydev-backup-${id}.bak`);
      if (proposal.originalHash) {
        await fs.writeFile(backupPath, proposal.originalContent, { encoding: 'utf-8', mode: 0o600 });
        proposal.backupPath = backupPath;
      }

      // 9. Write proposed content to atomic temporary file in same folder
      const tmpPath = path.join(targetDir, `.lazydev-tmp-${id}.tmp`);
      let tmpHandle: fs.FileHandle | null = null;

      try {
        tmpHandle = await fs.open(tmpPath, 'w', 0o600);
        await tmpHandle.writeFile(proposal.proposedContent, 'utf-8');
        await tmpHandle.sync(); // Force write to physical storage
        await tmpHandle.close();
        tmpHandle = null;

        // 10. Atomic rename replacement
        await fs.rename(tmpPath, targetPath);
      } catch (err: unknown) {
        // Clean up tmp file
        if (tmpHandle) {
          await tmpHandle.close().catch(() => {});
        }
        await fs.unlink(tmpPath).catch(() => {});

        // Rollback from backup if target was modified
        if (proposal.originalHash && (await fs.stat(backupPath).catch(() => null))) {
          await fs.copyFile(backupPath, targetPath).catch(() => {});
        } else if (!proposal.originalHash) {
          await fs.unlink(targetPath).catch(() => {});
        }

        const msg = err instanceof Error ? err.message : String(err);
        throw new ProposalError(`Failed to apply changes atomically: ${msg}`);
      }

      // Mark applied and single-use token invalidated
      proposal.status = 'applied';
      proposal.resolvedAt = new Date().toISOString();

      const writtenBytes = Buffer.byteLength(proposal.proposedContent, 'utf-8');

      return {
        success: true,
        status: 'applied',
        proposalId: proposal.id,
        relativePath: proposal.relativePath,
        bytesWritten: writtenBytes,
        backupPath: backupPath || '',
        appliedAt: proposal.resolvedAt
      };
    } finally {
      this.activeApplying.delete(id);
    }
  }
}
