/**
 * Image attachment plumbing: MIME filtering, size limits, base64 encoding, and
 * Anthropic content-block assembly. Centralized here so both InputBar (drop /
 * paste) and tests poke at the same primitives.
 *
 * Limits match what Anthropic's Messages API accepts — see
 * https://docs.anthropic.com/en/docs/build-with-claude/vision: PNG / JPEG /
 * GIF / WebP, up to 5MB per image on the server. We cap the renderer at 10MB
 * per image to match the UX surface (chips, thumbnails) and give users a
 * reasonable window to paste hi-res screenshots; the SDK will reject anything
 * oversize with a clear error.
 */

import type { ImageAttachment, ImageMediaType } from '../types';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 10;

export const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
];

export function isSupportedImageType(t: string): t is ImageMediaType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(t);
}

export interface FileLike {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type AttachmentRejection =
  | { kind: 'unsupported-type'; file: FileLike; detail: string }
  | { kind: 'too-large'; file: FileLike; detail: string }
  | { kind: 'over-limit'; file: FileLike; detail: string };

export interface AttachmentIntakeResult {
  accepted: ImageAttachment[];
  rejected: AttachmentRejection[];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let attachmentSeq = 0;
function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `att-${Date.now().toString(36)}-${attachmentSeq.toString(36)}`;
}

// Browsers encode arbitrary bytes as base64 via FileReader → data URL. We
// strip the `data:<mime>;base64,` prefix so downstream consumers (Anthropic
// API, stream-json outbound) get raw base64 they can put in `source.data`.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Chunked to avoid `Maximum call stack size exceeded` on >~100KB buffers
  // when we'd otherwise spread `bytes` into String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  // `btoa` is available in renderer + jsdom-backed vitest. Safe here.
  return btoa(binary);
}

/**
 * Normalize a single dropped / pasted file into either an `ImageAttachment`
 * ready to render, or an `AttachmentRejection` explaining why we skipped it.
 *
 * Never throws — filesystem / decode errors surface as rejections.
 */
export async function intakeFile(file: FileLike): Promise<ImageAttachment | AttachmentRejection> {
  if (!isSupportedImageType(file.type)) {
    return {
      kind: 'unsupported-type',
      file,
      detail: file.type
        ? `"${file.name}" is ${file.type}; only PNG / JPEG / GIF / WebP are supported.`
        : `"${file.name}" has no detectable image type.`
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      kind: 'too-large',
      file,
      detail: `"${file.name}" is ${formatSize(file.size)}; limit is ${formatSize(MAX_IMAGE_BYTES)}.`
    };
  }
  try {
    const buf = await file.arrayBuffer();
    const data = arrayBufferToBase64(buf);
    return {
      id: nextAttachmentId(),
      name: file.name || 'pasted-image',
      mediaType: file.type,
      data,
      size: file.size
    };
  } catch (err) {
    return {
      kind: 'unsupported-type',
      file,
      detail: `Failed to read "${file.name}": ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Intake a batch, enforcing MAX_IMAGES_PER_MESSAGE across the existing count.
 * `existingCount` is how many attachments the user already has in the
 * composer. Anything over the cap returns an `over-limit` rejection.
 */
export async function intakeFiles(
  files: FileLike[],
  existingCount: number
): Promise<AttachmentIntakeResult> {
  const accepted: ImageAttachment[] = [];
  const rejected: AttachmentRejection[] = [];
  for (const file of files) {
    if (existingCount + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      rejected.push({
        kind: 'over-limit',
        file,
        detail: `Attachment cap is ${MAX_IMAGES_PER_MESSAGE} images per message.`
      });
      continue;
    }
    const result = await intakeFile(file);
    if ('kind' in result) rejected.push(result);
    else accepted.push(result);
  }
  return { accepted, rejected };
}

/** Render an attachment as a data URL suitable for an <img src="..."> tag. */
export function attachmentToDataUrl(a: Pick<ImageAttachment, 'mediaType' | 'data'>): string {
  return `data:${a.mediaType};base64,${a.data}`;
}

/**
 * Anthropic content block for an image attachment. Matches
 * https://docs.anthropic.com/en/api/messages#body-messages-content —
 * `{ type: 'image', source: { type: 'base64', media_type, data } }`.
 */
export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicUserContentBlock = AnthropicImageBlock | AnthropicTextBlock;

export function attachmentToImageBlock(a: ImageAttachment): AnthropicImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: a.mediaType, data: a.data }
  };
}

/**
 * Build the `content` array sent to claude.exe as a user message. Image
 * blocks precede the text block so Anthropic's vision model sees them as
 * context for the text prompt, matching their official examples. An
 * image-only turn (no text) is valid and returns a content array of just
 * image blocks.
 */
export function buildUserContentBlocks(
  text: string,
  images: ImageAttachment[]
): AnthropicUserContentBlock[] {
  const blocks: AnthropicUserContentBlock[] = [];
  for (const img of images) blocks.push(attachmentToImageBlock(img));
  const trimmed = text.trim();
  if (trimmed.length > 0) blocks.push({ type: 'text', text: trimmed });
  return blocks;
}
