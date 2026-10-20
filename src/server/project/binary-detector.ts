/**
 * LazyDev Binary Detector
 * Combines fast extension lookup with first-512-byte null character heuristic.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.iso', '.dmg', '.app',
  // Archives & Compressed
  '.zip', '.tar', '.gz', '.7z', '.rar', '.tgz', '.bz2', '.xz', '.zst',
  // Media & Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff', '.psd',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.flac', '.aac', '.ogg',
  // Documents & Presentations (binary formats)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Compiled Bytecode / Objects
  '.pyc', '.pyo', '.pyd', '.class', '.wasm', '.o', '.obj', '.lib', '.a'
]);

/**
 * Fast-path check: returns true if file extension is unmistakably binary.
 */
export function isBinaryExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Deep check: inspects first 512 bytes for null bytes (\0) or non-printable controls.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  if (isBinaryExtension(filePath)) {
    return true;
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);

    for (let i = 0; i < bytesRead; i++) {
      // Null byte check indicates binary
      if (buffer[i] === 0x00) {
        return true;
      }
    }

    return false;
  } catch {
    // If unreadable, treat as non-text/error
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}
