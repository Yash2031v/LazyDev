/**
 * LazyDev File Editing & Permission Gate Types
 */

import type { DiffResult } from './diff-engine.js';

export type ProposalStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'conflict';

export interface FileEditProposal {
  readonly id: string;
  readonly projectRoot: string;
  readonly relativePath: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly originalHash: string;
  readonly proposedHash: string;
  readonly approvalToken: string;
  status: ProposalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  approvedAt?: string;
  rejectionReason?: string;
  resolvedAt?: string;
  statusReason?: string;
  readonly diff: DiffResult;
  backupPath?: string;
}

export interface ProposalSummary {
  readonly id: string;
  readonly relativePath: string;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly statusReason?: string;
}

export interface ProposalCreateRequest {
  readonly relativePath: string;
  readonly newContent?: string;
  readonly proposedContent?: string;
  readonly ttlMs?: number;
}

export interface ProposalActionResponse {
  readonly message: string;
  readonly proposal: FileEditProposal;
}

export interface ProposalApplyResult {
  readonly success: boolean;
  readonly status: 'applied';
  readonly proposalId: string;
  readonly relativePath: string;
  readonly bytesWritten: number;
  readonly backupPath: string;
  readonly appliedAt: string;
}
