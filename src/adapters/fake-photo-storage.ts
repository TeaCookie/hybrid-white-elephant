import type { PhotoStorage } from "@/ports/photo-storage";

/** In-memory PhotoStorage for tests. */
export class FakePhotoStorage implements PhotoStorage {
  private objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
