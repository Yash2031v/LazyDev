import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { EditorService, ProposalError, ProposalNotFoundError, ProposalConflictError } from '../src/server/editor/editor-service.js';
import { IgnoreEngine } from '../src/server/project/ignore-rules.js';

describe('Editor Service & Approval State Machine', () => {
  let tempDir: string;
  let canonicalRoot: string;
  let ignoreEngine: IgnoreEngine;
  let editorService: EditorService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-editor-test-'));
    canonicalRoot = await fs.realpath(tempDir);
    ignoreEngine = await IgnoreEngine.loadForRoot(canonicalRoot);
    editorService = new EditorService({ defaultTtlMs: 5000, maxFileSizeBytes: 1024 * 1024 });

    // Populate initial test files
    await fs.writeFile(path.join(canonicalRoot, 'index.ts'), 'export const greeting = "hello";\n', 'utf-8');
    await fs.writeFile(path.join(canonicalRoot, '.env'), 'SECRET_TOKEN=supersecret123\n', 'utf-8');
    await fs.writeFile(path.join(canonicalRoot, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('creating a proposal does NOT write or modify the file on disk', async () => {
    const originalDiskContent = await fs.readFile(path.join(canonicalRoot, 'index.ts'), 'utf-8');

    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "world";\n',
      reason: 'Change greeting to world'
    });

    assert.equal(proposal.status, 'awaiting_approval');
    assert.equal(proposal.relativePath, 'index.ts');
    assert.ok(proposal.id);
    assert.ok(proposal.approvalToken);
    assert.equal(proposal.diff.additions, 1);
    assert.equal(proposal.diff.deletions, 1);

    // Verify disk content is completely unchanged
    const currentDiskContent = await fs.readFile(path.join(canonicalRoot, 'index.ts'), 'utf-8');
    assert.equal(currentDiskContent, originalDiskContent);
  });

  it('rejects proposal creation for secret files (.env)', async () => {
    await assert.rejects(
      async () => {
        await editorService.createProposal(canonicalRoot, ignoreEngine, {
          relativePath: '.env',
          proposedContent: 'SECRET_TOKEN=hacked\n'
        });
      },
      (err: Error) => {
        assert.match(err.message, /secret/i);
        return true;
      }
    );
  });

  it('rejects proposal creation for binary files', async () => {
    await assert.rejects(
      async () => {
        await editorService.createProposal(canonicalRoot, ignoreEngine, {
          relativePath: 'data.bin',
          proposedContent: 'not binary anymore'
        });
      },
      (err: Error) => {
        assert.match(err.message, /binary/i);
        return true;
      }
    );
  });

  it('rejects proposal creation traversing outside project root', async () => {
    await assert.rejects(
      async () => {
        await editorService.createProposal(canonicalRoot, ignoreEngine, {
          relativePath: '../outside.txt',
          proposedContent: 'evil content'
        });
      },
      (err: Error) => {
        assert.match(err.message, /traversal/i);
        return true;
      }
    );
  });

  it('rejects proposal creation for oversized content', async () => {
    const smallEditor = new EditorService({ maxFileSizeBytes: 100 });
    const hugeContent = 'a'.repeat(200);

    await assert.rejects(
      async () => {
        await smallEditor.createProposal(canonicalRoot, ignoreEngine, {
          relativePath: 'index.ts',
          proposedContent: hugeContent
        });
      },
      (err: Error) => {
        assert.match(err.message, /exceeds limit/i);
        return true;
      }
    );
  });

  it('requires explicit approval before applying; cannot apply directly from awaiting_approval', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "lazydev";\n'
    });

    // Attempt to apply without prior approval
    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /must be in "approved" state/i);
        return true;
      }
    );

    // Verify disk content still untouched
    const diskContent = await fs.readFile(path.join(canonicalRoot, 'index.ts'), 'utf-8');
    assert.equal(diskContent, 'export const greeting = "hello";\n');
  });

  it('full lifecycle: create -> approve -> apply successfully updates file on disk with backup', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "lazydev";\n',
      reason: 'Updating greeting'
    });

    // Approve
    const approved = await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvedAt);

    // Apply
    const result = await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);
    assert.equal(result.success, true);
    assert.equal(result.status, 'applied');
    assert.ok(result.backupPath);

    // Verify updated content on disk
    const diskContent = await fs.readFile(path.join(canonicalRoot, 'index.ts'), 'utf-8');
    assert.equal(diskContent, 'export const greeting = "lazydev";\n');

    // Verify proposal status is applied
    const appliedProposal = await editorService.getProposal(proposal.id, canonicalRoot);
    assert.equal(appliedProposal.status, 'applied');
  });

  it('rejects apply with an invalid or incorrect approvalToken', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "authorized";\n'
    });

    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, 'invalid-token-12345', canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /invalid or unauthorized/i);
        return true;
      }
    );
  });

  it('rejects replayed apply attempts once proposal is already applied', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "first";\n'
    });

    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);
    await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    // Attempt second apply
    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /must be in "approved" state/i);
        return true;
      }
    );
  });

  it('rejects proposal when user explicitly rejects it', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "declined";\n'
    });

    const rejected = await editorService.rejectProposal(proposal.id, 'Change is unnecessary', canonicalRoot);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'Change is unnecessary');

    // Cannot approve a rejected proposal
    await assert.rejects(
      async () => {
        await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /only proposals awaiting approval can be approved/i);
        return true;
      }
    );

    // Cannot apply a rejected proposal
    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /must be in "approved" state/i);
        return true;
      }
    );
  });

  it('detects stale file modifications and transitions to conflict state', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "stale-test";\n'
    });

    // An external editor modifies index.ts on disk after preview was generated
    await fs.writeFile(path.join(canonicalRoot, 'index.ts'), 'export const greeting = "externally modified";\n', 'utf-8');

    // Attempting to approve now detects the stale change
    await assert.rejects(
      async () => {
        await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.ok(err instanceof ProposalConflictError);
        assert.match(err.message, /modified on disk/i);
        return true;
      }
    );

    const updatedProposal = await editorService.getProposal(proposal.id, canonicalRoot);
    assert.equal(updatedProposal.status, 'conflict');
  });

  it('detects stale file modifications at apply time if file was modified after approval', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "approved-then-conflict";\n'
    });

    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    // External modification happens between approval and apply
    await fs.writeFile(path.join(canonicalRoot, 'index.ts'), 'export const greeting = "changed-between-steps";\n', 'utf-8');

    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.ok(err instanceof ProposalConflictError);
        return true;
      }
    );

    const updatedProposal = await editorService.getProposal(proposal.id, canonicalRoot);
    assert.equal(updatedProposal.status, 'conflict');
  });

  it('expires proposals after TTL and prevents approval or application', async () => {
    // 50ms short TTL
    const shortEditor = new EditorService({ defaultTtlMs: 50 });

    const proposal = await shortEditor.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      proposedContent: 'export const greeting = "expired";\n'
    });

    // Wait 70ms for expiration
    await new Promise((resolve) => setTimeout(resolve, 70));

    // Approval must fail
    await assert.rejects(
      async () => {
        await shortEditor.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);
      },
      (err: Error) => {
        assert.match(err.message, /expired/i);
        return true;
      }
    );

    const expired = await shortEditor.getProposal(proposal.id, canonicalRoot);
    assert.equal(expired.status, 'expired');
  });

  it('rejects cross-project proposal confusion when active root differs', async () => {
    const otherTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-other-project-'));
    const otherRoot = await fs.realpath(otherTempDir);

    try {
      const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
        relativePath: 'index.ts',
        proposedContent: 'export const greeting = "cross-project";\n'
      });

      // Attempting to approve or apply under otherRoot must be rejected
      await assert.rejects(
        async () => {
          await editorService.approveProposal(proposal.id, proposal.approvalToken, otherRoot);
        },
        (err: Error) => {
          assert.match(err.message, /belongs to a different project root/i);
          return true;
        }
      );
    } finally {
      await fs.rm(otherTempDir, { recursive: true, force: true });
    }
  });

  it('blocks concurrent apply attempts on the same proposal', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      newContent: 'export const greeting = "concurrent";\n'
    });
    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    const results = await Promise.allSettled([
      editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot, ignoreEngine),
      editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot, ignoreEngine)
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /being applied|must be in "approved" state/i);
  });

  it('rejects apply if target file is converted into a symlink prior to application', async () => {
    await fs.writeFile(path.join(canonicalRoot, 'symtarget.txt'), 'legit\n', 'utf-8');
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'symtarget.txt',
      newContent: 'modified\n'
    });
    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    // Turn symtarget.txt into a symlink
    await fs.unlink(path.join(canonicalRoot, 'symtarget.txt'));
    try {
      await fs.symlink(path.join(canonicalRoot, 'index.ts'), path.join(canonicalRoot, 'symtarget.txt'));
      await assert.rejects(
        async () => {
          await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot, ignoreEngine);
        },
        (err: Error) => {
          assert.match(err.message, /symbolic link/i);
          return true;
        }
      );
    } catch (e: any) {
      if (e.code === 'EPERM') return; // Windows unprivileged symlink limitation
      throw e;
    }
  });

  it('rejects apply if target is classified as secret or ignored prior to application', async () => {
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'index.ts',
      newContent: 'modified\n'
    });
    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    // Mock ignoreEngine that now classifies index.ts as secret
    const strictEngine = {
      isSecret: (p: string) => p === 'index.ts',
      shouldIgnore: () => ({ ignored: false })
    } as any;

    await assert.rejects(
      async () => {
        await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot, strictEngine);
      },
      (err: Error) => {
        assert.match(err.message, /protected as a secret credential/i);
        return true;
      }
    );
  });

  it('creates backup and preserves originally empty (0-byte) files', async () => {
    await fs.writeFile(path.join(canonicalRoot, 'empty.txt'), '', 'utf-8');
    const proposal = await editorService.createProposal(canonicalRoot, ignoreEngine, {
      relativePath: 'empty.txt',
      newContent: 'new content\n'
    });
    await editorService.approveProposal(proposal.id, proposal.approvalToken, canonicalRoot);

    const result = await editorService.applyProposal(proposal.id, proposal.approvalToken, canonicalRoot, ignoreEngine);
    assert.equal(result.success, true);
    assert.ok(result.backupPath);
    const backupContent = await fs.readFile(result.backupPath, 'utf-8');
    assert.equal(backupContent, '');
  });
});
