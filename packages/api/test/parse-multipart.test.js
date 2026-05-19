import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { parseMultipart } from '../dist/routes/parse-multipart.js';

test('parseMultipart drains file stream before waiting for remaining parts', async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-parse-multipart-'));
  let fileConsumed = false;
  let releaseIterator = false;

  const request = {
    parts: async function* () {
      yield { type: 'field', fieldname: 'content', value: 'hello with image' };

      yield {
        type: 'file',
        fieldname: 'images',
        filename: 'cat.png',
        mimetype: 'image/png',
        toBuffer: async () => {
          fileConsumed = true;
          return Buffer.from('fake-png');
        },
      };

      while (!fileConsumed && !releaseIterator) {
        await delay(5);
      }

      yield { type: 'field', fieldname: 'threadId', value: 'thread-test' };
    },
  };

  try {
    const parsed = await Promise.race([
      parseMultipart(request, uploadDir),
      (async () => {
        await delay(300);
        throw new Error('parseMultipart timed out waiting for file stream drain');
      })(),
    ]);

    assert.ok(!('error' in parsed), 'expected multipart parse success');
    assert.equal(parsed.threadId, 'thread-test');
    assert.equal(parsed.contentBlocks.length, 2);
    assert.equal(parsed.contentBlocks[0].type, 'text');
    assert.equal(parsed.contentBlocks[1].type, 'image');
  } finally {
    releaseIterator = true;
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test('parseMultipart saves generic attachment files as file content blocks', async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-parse-multipart-file-'));
  const request = {
    parts: async function* () {
      yield { type: 'field', fieldname: 'content', value: 'see attached' };
      yield {
        type: 'file',
        fieldname: 'attachments',
        filename: 'notes.txt',
        mimetype: 'text/plain',
        toBuffer: async () => Buffer.from('hello file'),
      };
    },
  };

  try {
    const parsed = await parseMultipart(request, uploadDir);
    assert.ok(!('error' in parsed), 'expected multipart parse success');
    assert.equal(parsed.contentBlocks.length, 2);
    assert.equal(parsed.contentBlocks[1].type, 'file');
    assert.equal(parsed.contentBlocks[1].filename, 'notes.txt');
    assert.equal(parsed.contentBlocks[1].mimeType, 'text/plain');
    assert.equal(parsed.contentBlocks[1].size, 10);
    assert.match(parsed.contentBlocks[1].url, /^\/uploads\//);
  } finally {
    await rm(uploadDir, { recursive: true, force: true });
  }
});
