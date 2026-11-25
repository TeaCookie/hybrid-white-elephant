/** Private object storage for gift photos. The real adapter (R2 or Vercel Blob) arrives with gift registration. */
export interface PhotoStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
