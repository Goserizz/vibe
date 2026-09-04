/** Client-side mirror of server/src/vibot/images.ts limits for Vibot attachments. */

export const VIBOT_MAX_IMAGES = 4;
export const VIBOT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

export function vibotImageError(files: File[], already = 0): string | null {
  if (already + files.length > VIBOT_MAX_IMAGES) {
    return `At most ${VIBOT_MAX_IMAGES} images per message`;
  }
  for (const f of files) {
    const mime = (f.type || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return 'Only PNG, JPEG, WebP, or GIF images are allowed';
    }
    if (f.size > VIBOT_MAX_IMAGE_BYTES) {
      return `Each image must be ≤ ${VIBOT_MAX_IMAGE_BYTES / (1024 * 1024)}MB`;
    }
  }
  return null;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}
