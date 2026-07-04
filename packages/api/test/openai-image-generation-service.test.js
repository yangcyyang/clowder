import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { OpenAIImageGenerationService } = await import('../dist/infrastructure/image/OpenAIImageGenerationService.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('OpenAIImageGenerationService', () => {
  test('caps concurrent image API requests with CAT_CAFE_GPT_IMAGE_CONCURRENCY', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-image-service-'));
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const service = new OpenAIImageGenerationService({
        projectRoot: uploadDir,
        env: {
          CAT_CAFE_GPT_IMAGE_API_KEY: 'test-key',
          CAT_CAFE_GPT_IMAGE_CONCURRENCY: '2',
          UPLOAD_DIR: uploadDir,
        },
        fetchImpl,
      });

      const results = await Promise.all(
        [0, 1, 2, 3].map((index) =>
          service.generateAndPublish({
            prompt: `pixel cat ${index}`,
            publicationKey: `service-test-${index}`,
            toolName: 'test',
          }),
        ),
      );

      assert.equal(results.length, 4);
      assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);
      assert.ok(results.every((result) => result.richBlock.kind === 'media_gallery'));
      assert.ok(results.every((result) => result.images[0].url.startsWith('/uploads/')));
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  test('rejects oversized URL image downloads before buffering the body', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-image-service-url-'));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ data: [{ url: 'https://example.test/too-large.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('too-large', {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(11 * 1024 * 1024),
        },
      });
    };

    try {
      const service = new OpenAIImageGenerationService({
        projectRoot: uploadDir,
        env: {
          CAT_CAFE_GPT_IMAGE_API_KEY: 'test-key',
          UPLOAD_DIR: uploadDir,
        },
        fetchImpl,
      });

      await assert.rejects(
        service.generateAndPublish({
          prompt: 'url image',
          publicationKey: 'url-too-large',
          toolName: 'test',
        }),
        /File too large/,
      );
      assert.equal(calls, 2);
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
