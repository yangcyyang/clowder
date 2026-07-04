import { createHash, randomBytes } from 'node:crypto';
import type { RichMediaGalleryBlock } from '@cat-cafe/shared';
import { resolveForClient } from '../../config/account-resolver.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import {
  MAX_IMAGE_FILE_SIZE,
  type SupportedImageMime,
  sanitizeFilenameStem,
  saveImageBufferToUploadDir,
} from '../../utils/image-storage.js';
import { getDefaultUploadDir } from '../../utils/upload-paths.js';

export const IMAGE_SIZE_VALUES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageGenerationSize = (typeof IMAGE_SIZE_VALUES)[number];

export const IMAGE_QUALITY_VALUES = ['auto', 'low', 'medium', 'high'] as const;
export type ImageGenerationQuality = (typeof IMAGE_QUALITY_VALUES)[number];

export const IMAGE_OUTPUT_FORMAT_VALUES = ['png', 'jpeg', 'webp'] as const;
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMAT_VALUES)[number];

export interface ImageGenerationRequest {
  prompt: string;
  n?: number;
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageOutputFormat;
}

export interface GenerateAndPublishImageRequest extends ImageGenerationRequest {
  publicationKey: string;
  uploadDir?: string;
  title?: string;
  alt?: string;
  toolName: string;
}

export interface PublishedImageGeneration {
  url: `/uploads/${string}`;
  absPath: string;
  mimeType: SupportedImageMime;
  fileSize: number;
  revisedPrompt?: string;
}

export interface GenerateAndPublishImageResult {
  provider: 'openai';
  model: string;
  durationMs: number;
  images: PublishedImageGeneration[];
  richBlock: RichMediaGalleryBlock;
}

interface OpenAIImageGenerationServiceOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: {
    warn(obj: unknown, msg?: string): void;
  };
}

interface ResolvedImageConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
}

interface OpenAIImageResponseItem {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAIImageResponseBody {
  data?: OpenAIImageResponseItem[];
  error?: { message?: string };
}

interface OpenAIImageHttpResult {
  response: Response;
  body: OpenAIImageResponseBody;
}

class ImageGenerationError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ImageGenerationError';
    if (statusCode != null) this.statusCode = statusCode;
  }
}

class AdjustableLimiter {
  private max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private drain(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }
}

const sharedLimiter = new AdjustableLimiter(3);

function parseIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function outputFormatToMime(outputFormat: ImageOutputFormat): SupportedImageMime {
  if (outputFormat === 'jpeg') return 'image/jpeg';
  if (outputFormat === 'webp') return 'image/webp';
  return 'image/png';
}

function mimeToOutputFormat(mimeType: string): ImageOutputFormat {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpeg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number.parseFloat(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function buildPublicationStem(publicationKey: string, prompt: string, index: number): string {
  const hash = createHash('sha256').update(`${publicationKey}\n${prompt}\n${index}`).digest('hex').slice(0, 12);
  return sanitizeFilenameStem(`generated-image-${publicationKey}-${index + 1}-${hash}`);
}

function buildBlockId(publicationKey: string): string {
  const hash = createHash('sha256').update(publicationKey).digest('hex').slice(0, 12);
  return `generated-image-${hash}`;
}

export class OpenAIImageGenerationService {
  private readonly projectRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: OpenAIImageGenerationServiceOptions['logger'];

  constructor(options: OpenAIImageGenerationServiceOptions = {}) {
    this.projectRoot = options.projectRoot ?? resolveActiveProjectRoot();
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  async generateAndPublish(input: GenerateAndPublishImageRequest): Promise<GenerateAndPublishImageResult> {
    const startedAt = Date.now();
    const config = this.resolveConfig();
    sharedLimiter.setMax(config.concurrency);

    const outputFormat = input.outputFormat ?? 'png';
    const mimeType = outputFormatToMime(outputFormat);
    const images = await sharedLimiter.run(() => this.generateImages(config, { ...input, outputFormat }));
    const uploadDir = getDefaultUploadDir(input.uploadDir ?? this.env.UPLOAD_DIR);
    const published: PublishedImageGeneration[] = [];

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      if (!image) continue;
      const effectiveMime = image.mimeType ?? mimeType;
      const stored = await saveImageBufferToUploadDir({
        buffer: image.buffer,
        mimeType: effectiveMime,
        uploadDir,
        filenameStem: buildPublicationStem(input.publicationKey, input.prompt, index),
        onExists: 'reuse',
      });
      published.push({
        url: stored.urlPath,
        absPath: stored.absPath,
        mimeType: effectiveMime,
        fileSize: image.buffer.byteLength,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      });
    }

    if (published.length === 0) {
      throw new ImageGenerationError('OpenAI image response did not contain any image data');
    }

    const richBlock: RichMediaGalleryBlock = {
      id: buildBlockId(input.publicationKey),
      kind: 'media_gallery',
      v: 1,
      ...(input.title ? { title: input.title } : {}),
      items: published.map((image, index) => ({
        url: image.url,
        alt: input.alt ?? input.prompt,
        ...(image.revisedPrompt ? { caption: image.revisedPrompt } : index === 0 ? { caption: input.prompt } : {}),
      })),
      provenance: {
        provider: 'openai',
        model: config.model,
        toolName: input.toolName,
        prompt: input.prompt,
        publicationKey: input.publicationKey,
      },
    } as RichMediaGalleryBlock;

    return {
      provider: 'openai',
      model: config.model,
      durationMs: Date.now() - startedAt,
      images: published,
      richBlock,
    };
  }

  private resolveConfig(): ResolvedImageConfig {
    const account = resolveForClient(this.projectRoot, 'openai');
    const apiKey = this.env.CAT_CAFE_GPT_IMAGE_API_KEY?.trim() || account?.apiKey || this.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ImageGenerationError(
        'OpenAI image API key is not configured. Add an OpenAI account in Hub settings, or set CAT_CAFE_GPT_IMAGE_API_KEY / OPENAI_API_KEY.',
      );
    }
    return {
      apiKey,
      baseUrl: trimTrailingSlash(
        this.env.CAT_CAFE_GPT_IMAGE_BASE_URL?.trim() ||
          account?.baseUrl ||
          this.env.OPENAI_BASE_URL?.trim() ||
          this.env.OPENAI_API_BASE?.trim() ||
          'https://api.openai.com/v1',
      ),
      model: this.env.CAT_CAFE_GPT_IMAGE_MODEL?.trim() || 'gpt-image-2',
      concurrency: parseIntEnv(this.env.CAT_CAFE_GPT_IMAGE_CONCURRENCY, 3, 1, 10),
      timeoutMs: parseIntEnv(this.env.CAT_CAFE_GPT_IMAGE_TIMEOUT_MS, 120_000, 10_000, 600_000),
      maxRetries: parseIntEnv(this.env.CAT_CAFE_GPT_IMAGE_MAX_RETRIES, 2, 0, 5),
    };
  }

  private async generateImages(
    config: ResolvedImageConfig,
    input: Required<Pick<ImageGenerationRequest, 'outputFormat'>> & ImageGenerationRequest,
  ): Promise<Array<{ buffer: Buffer; mimeType?: SupportedImageMime; revisedPrompt?: string }>> {
    const requestBody = this.buildRequestBody(config, input);
    return this.generateImagesWithRetry(config, input.outputFormat, requestBody, 0);
  }

  private buildRequestBody(
    config: ResolvedImageConfig,
    input: Required<Pick<ImageGenerationRequest, 'outputFormat'>> & ImageGenerationRequest,
  ): Record<string, unknown> {
    return {
      model: config.model,
      prompt: input.prompt,
      n: input.n ?? 1,
      size: input.size ?? '1024x1024',
      quality: input.quality ?? 'auto',
      output_format: input.outputFormat,
    };
  }

  private async postImageGeneration(
    config: ResolvedImageConfig,
    requestBody: Record<string, unknown>,
  ): Promise<OpenAIImageHttpResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${config.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as OpenAIImageResponseBody) : {};
      return { response, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async generateImagesWithRetry(
    config: ResolvedImageConfig,
    outputFormat: ImageOutputFormat,
    requestBody: Record<string, unknown>,
    attempt: number,
  ): Promise<Array<{ buffer: Buffer; mimeType?: SupportedImageMime; revisedPrompt?: string }>> {
    try {
      const result = await this.postImageGeneration(config, requestBody);
      const decoded = await this.decodeSuccessfulImages(result, outputFormat, config.timeoutMs);
      if (decoded) return decoded;
      if (!this.shouldRetryResponse(result.response, attempt, config.maxRetries)) {
        throw this.buildHttpError(result);
      }
      await sleep(this.responseRetryDelayMs(result.response, attempt));
      return this.generateImagesWithRetry(config, outputFormat, requestBody, attempt + 1);
    } catch (err) {
      if (err instanceof ImageGenerationError) throw err;
      if (attempt >= config.maxRetries) throw this.buildNetworkError(err);
      const delay = this.retryDelayMs(attempt);
      this.logger?.warn({ err, attempt, delay }, '[OpenAIImageGenerationService] retrying image generation');
      await sleep(delay);
      return this.generateImagesWithRetry(config, outputFormat, requestBody, attempt + 1);
    }
  }

  private async decodeSuccessfulImages(
    result: OpenAIImageHttpResult,
    outputFormat: ImageOutputFormat,
    downloadTimeoutMs: number,
  ): Promise<Array<{ buffer: Buffer; mimeType?: SupportedImageMime; revisedPrompt?: string }> | null> {
    if (!result.response.ok) return null;
    const data = Array.isArray(result.body.data) ? result.body.data : [];
    return Promise.all(data.map((item) => this.decodeImageItem(item, outputFormat, downloadTimeoutMs)));
  }

  private shouldRetryResponse(response: Response, attempt: number, maxRetries: number): boolean {
    return this.shouldRetry(response.status) && attempt < maxRetries;
  }

  private responseRetryDelayMs(response: Response, attempt: number): number {
    return retryAfterMs(response.headers.get('retry-after')) ?? this.retryDelayMs(attempt);
  }

  private buildHttpError(result: OpenAIImageHttpResult): ImageGenerationError {
    return new ImageGenerationError(
      result.body.error?.message ?? `OpenAI image generation failed with HTTP ${result.response.status}`,
      result.response.status,
    );
  }

  private buildNetworkError(err: unknown): ImageGenerationError {
    const message = err instanceof Error ? err.message : String(err);
    return new ImageGenerationError(`OpenAI image generation failed: ${message}`);
  }

  private retryDelayMs(attempt: number): number {
    return 750 * 2 ** attempt;
  }

  private shouldRetry(statusCode: number): boolean {
    return statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
  }

  private async decodeImageItem(
    item: OpenAIImageResponseItem,
    requestedFormat: ImageOutputFormat,
    downloadTimeoutMs: number,
  ): Promise<{ buffer: Buffer; mimeType?: SupportedImageMime; revisedPrompt?: string }> {
    if (item.b64_json) {
      return {
        buffer: Buffer.from(item.b64_json, 'base64'),
        mimeType: outputFormatToMime(requestedFormat),
        ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
      };
    }
    if (item.url) {
      const { buffer, mimeType } = await this.downloadImageUrl(item.url, downloadTimeoutMs);
      return {
        buffer,
        mimeType,
        ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
      };
    }
    throw new ImageGenerationError('OpenAI image response item is missing b64_json/url');
  }

  private async downloadImageUrl(
    url: string,
    timeoutMs: number,
  ): Promise<{ buffer: Buffer; mimeType: SupportedImageMime }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new ImageGenerationError(
          `OpenAI image URL download failed with HTTP ${response.status}`,
          response.status,
        );
      }
      this.assertContentLengthWithinLimit(response);
      const buffer = await this.readResponseBufferWithinLimit(response);
      const outputFormat = mimeToOutputFormat(response.headers.get('content-type') ?? '');
      return { buffer, mimeType: outputFormatToMime(outputFormat) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertContentLengthWithinLimit(response: Response): void {
    const rawContentLength = response.headers.get('content-length');
    if (!rawContentLength) return;
    const contentLength = Number.parseInt(rawContentLength, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_FILE_SIZE) {
      throw new ImageGenerationError(`File too large: ${contentLength} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
    }
  }

  private async readResponseBufferWithinLimit(response: Response): Promise<Buffer> {
    if (!response.body) {
      const fallbackBuffer = Buffer.from(await response.arrayBuffer());
      if (fallbackBuffer.byteLength > MAX_IMAGE_FILE_SIZE) {
        throw new ImageGenerationError(
          `File too large: ${fallbackBuffer.byteLength} bytes (max ${MAX_IMAGE_FILE_SIZE})`,
        );
      }
      return fallbackBuffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_FILE_SIZE) {
        await reader.cancel().catch(() => {});
        throw new ImageGenerationError(`File too large: ${totalBytes} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
      }
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      totalBytes,
    );
  }
}

export function imagePublicationKey(parts: readonly string[]): string {
  const raw = parts.filter(Boolean).join('-') || randomBytes(6).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return sanitizeFilenameStem(`${raw}-${hash}`).slice(0, 120);
}
