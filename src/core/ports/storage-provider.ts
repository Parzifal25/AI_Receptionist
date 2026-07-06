/**
 * Port for binary asset storage (logos, avatars, uploaded knowledge files).
 * Implemented with Supabase Storage today; S3/GCS/R2 later.
 */
export interface StorageProvider {
  readonly name: string;
  upload(path: string, data: Blob | ArrayBuffer, contentType: string): Promise<{ url: string }>;
  remove(path: string): Promise<void>;
  getPublicUrl(path: string): string;
}
