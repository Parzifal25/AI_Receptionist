import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageProvider } from "@/core/ports/storage-provider";
import { AppError } from "@/core/errors/app-error";

const BUCKET = "business-assets";

/** Asset storage backed by Supabase Storage. */
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase";

  constructor(private readonly db: SupabaseClient) {}

  async upload(path: string, data: Blob | ArrayBuffer, contentType: string): Promise<{ url: string }> {
    const { error } = await this.db.storage
      .from(BUCKET)
      .upload(path, data, { contentType, upsert: true });
    if (error) throw AppError.provider(`Upload failed: ${error.message}`);
    return { url: this.getPublicUrl(path) };
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.db.storage.from(BUCKET).remove([path]);
    if (error) throw AppError.provider(`Delete failed: ${error.message}`);
  }

  getPublicUrl(path: string): string {
    return this.db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }
}
