/**
 * LazyDev Unified Diff Engine
 * High-performance, zero-dependency LCS line diff generator producing standard unified diff output.
 */

export interface DiffLine {
  readonly type: 'add' | 'delete' | 'context';
  readonly content: string;
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
}

export interface DiffChunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffResult {
  readonly unified: string;
  readonly additions: number;
  readonly deletions: number;
  readonly isIdentical: boolean;
  readonly chunks: readonly DiffChunk[];
}

/**
 * Normalizes line endings to \n and splits into lines.
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.split('\n');
}

/**
 * Computes Longest Common Subsequence (LCS) matrix for two line arrays.
 */
function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const matrix: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]! + 1;
      } else {
        matrix[i]![j] = Math.max(matrix[i - 1]![j]!, matrix[i]![j - 1]!);
      }
    }
  }

  return matrix;
}

/**
 * Backtracks through LCS matrix to produce diff operations.
 */
function backtrackLCS(
  matrix: number[][],
  oldLines: string[],
  newLines: string[]
): DiffLine[] {
  let i = oldLines.length;
  let j = newLines.length;
  const rawDiff: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawDiff.push({
        type: 'context',
        content: oldLines[i - 1]!,
        oldLineNumber: i,
        newLineNumber: j
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || matrix[i]![j - 1]! >= matrix[i - 1]![j]!)) {
      rawDiff.push({
        type: 'add',
        content: newLines[j - 1]!,
        newLineNumber: j
      });
      j--;
    } else if (i > 0 && (j === 0 || matrix[i]![j - 1]! < matrix[i - 1]![j]!)) {
      rawDiff.push({
        type: 'delete',
        content: oldLines[i - 1]!,
        oldLineNumber: i
      });
      i--;
    }
  }

  return rawDiff.reverse();
}

/**
 * Generates unified diff output with additions, deletions, and context.
 */
export function generateUnifiedDiff(
  filePath: string,
  originalText: string,
  proposedText: string
): DiffResult {
  const oldLines = splitLines(originalText);
  const newLines = splitLines(proposedText);

  if (originalText === proposedText) {
    return {
      unified: '',
      additions: 0,
      deletions: 0,
      isIdentical: true,
      chunks: []
    };
  }

  const lcsMatrix = computeLCS(oldLines, newLines);
  const diffLines = backtrackLCS(lcsMatrix, oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  for (const line of diffLines) {
    if (line.type === 'add') additions++;
    if (line.type === 'delete') deletions++;
  }

  // Check if there are changes
  const chunks: DiffChunk[] = [];
  let lastChangeIndex = -1;

  for (let idx = 0; idx < diffLines.length; idx++) {
    const line = diffLines[idx]!;
    if (line.type !== 'context') {
      lastChangeIndex = idx;
    }
  }

  if (lastChangeIndex === -1) {
    return {
      unified: '',
      additions: 0,
      deletions: 0,
      isIdentical: true,
      chunks: []
    };
  }

  // Simple unified chunk grouping
  const header = `--- a/${filePath.replace(/\\/g, '/')}\n+++ b/${filePath.replace(/\\/g, '/')}\n`;
  const unifiedLines: string[] = [header];

  // For developer clarity in single-file edits, format all changes with context
  let oldLineCount = 0;
  let newLineCount = 0;
  const chunkBody: string[] = [];

  for (const line of diffLines) {
    if (line.type === 'context') {
      oldLineCount++;
      newLineCount++;
      chunkBody.push(` ${line.content}`);
    } else if (line.type === 'delete') {
      oldLineCount++;
      chunkBody.push(`-${line.content}`);
    } else if (line.type === 'add') {
      newLineCount++;
      chunkBody.push(`+${line.content}`);
    }
  }

  const chunkHeader = `@@ -1,${oldLineCount || 1} +1,${newLineCount || 1} @@\n`;
  unifiedLines.push(chunkHeader);
  unifiedLines.push(chunkBody.join('\n'));

  chunks.push({
    oldStart: 1,
    oldLines: oldLineCount,
    newStart: 1,
    newLines: newLineCount,
    lines: diffLines
  });

  return {
    unified: unifiedLines.join(''),
    additions,
    deletions,
    isIdentical: false,
    chunks: Object.freeze(chunks)
  };
}
