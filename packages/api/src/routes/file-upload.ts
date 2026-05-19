/**
 * Generic file upload utilities for chat attachments.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { FileContent } from '@cat-cafe/shared';
import { sanitizeFilenameStem } from '../utils/image-storage.js';

const MAX_FILES = 5;
export const MAX_GENERIC_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export interface UploadFile {
  filename?: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

export class FileUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileUploadError';
  }
}

export interface SavedFile {
  absPath: string;
  urlPath: `/uploads/${string}`;
  content: FileContent;
}

function safeExt(filename: string | undefined): string {
  const ext = extname(filename ?? '').toLowerCase();
  if (!ext || ext.length > 16) return '';
  return /^[a-z0-9.]+$/.test(ext) ? ext : '';
}

function displayName(filename: string | undefined): string {
  const trimmed = filename?.trim();
  return trimmed || 'attachment';
}

export async function saveUploadedFiles(files: UploadFile[], uploadDir: string): Promise<SavedFile[]> {
  if (files.length > MAX_FILES) {
    throw new FileUploadError(`Too many files (max ${MAX_FILES})`);
  }

  await mkdir(uploadDir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const file of files) {
    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_GENERIC_FILE_SIZE) {
      throw new FileUploadError(`File too large: ${buffer.byteLength} bytes (max ${MAX_GENERIC_FILE_SIZE})`);
    }

    const originalName = displayName(file.filename);
    const ext = safeExt(originalName);
    const stem = ext ? originalName.slice(0, -ext.length) : originalName;
    const storageName = `${sanitizeFilenameStem(`${Date.now()}-${randomUUID().slice(0, 8)}-${stem}`)}${ext}`;
    const absPath = resolve(join(uploadDir, storageName));
    const urlPath = `/uploads/${storageName}` as const;
    await writeFile(absPath, buffer, { flag: 'wx' });
    saved.push({
      absPath,
      urlPath,
      content: {
        type: 'file',
        filename: originalName,
        url: urlPath,
        mimeType: file.mimetype || 'application/octet-stream',
        size: buffer.byteLength,
      },
    });
  }
  return saved;
}
