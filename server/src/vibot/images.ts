/** Vibot image-attachment limits (data URLs on vibot_send). */

export const VIBOT_MAX_IMAGES = 4;
export const VIBOT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;
const HTTPS_URL_RE = /^https:\/\/\S+$/i;

/** Approximate decoded byte size of a data-URL or reject non-data URLs as 0. */
export function dataUrlByteLength(url: string): number {
  if (!url.startsWith('data:')) return 0;
  const b64 = url.slice(url.indexOf(',') + 1);
  // Base64: 4 chars → 3 bytes; ignore padding nuance for a safe upper bound.
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Validate optional image attachments. Returns an error message, or null when OK.
 * Accepts data:image/(png|jpeg|jpg|webp|gif);base64,… or https:// URLs.
 */
export function validateVibotImages(images: string[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  if (images.length > VIBOT_MAX_IMAGES) {
    return `At most ${VIBOT_MAX_IMAGES} images per message`;
  }
  for (const url of images) {
    if (typeof url !== 'string' || !url) return 'Invalid image attachment';
    if (DATA_URL_RE.test(url)) {
      if (dataUrlByteLength(url) > VIBOT_MAX_IMAGE_BYTES) {
        return `Each image must be ≤ ${VIBOT_MAX_IMAGE_BYTES / (1024 * 1024)}MB`;
      }
      continue;
    }
    if (HTTPS_URL_RE.test(url)) continue;
    return 'Images must be PNG/JPEG/WebP/GIF data URLs or https URLs';
  }
  return null;
}
