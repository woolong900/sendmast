import { api } from '@/lib/api';

/**
 * Wired into `<EmailEditorProvider onUploadImage>`. Easy Email gives us a
 * Blob (from <input type=file> in its image-attribute panel) and expects
 * a Promise<string> URL it can drop into the <img src>.
 *
 * The endpoint stores into the public bucket so recipients can load the
 * image without auth — see UploadController on the API side.
 */
export async function uploadEditorImage(blob: Blob): Promise<string> {
  const fd = new FormData();
  // The third arg is just a hint for the server's `originalname`; not used,
  // but keeps multer happy when the Blob has no embedded filename.
  fd.append('file', blob, (blob as File).name ?? 'image');
  const res = await api.post<{ url: string }>('/api/uploads/image', fd);
  return res.data.url;
}
