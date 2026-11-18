import { ContainerClient } from "@azure/storage-blob";
import type { BlobStore } from "./stores.js";

export class AzureBlobStore implements BlobStore {
  private readonly container: ContainerClient;

  constructor(connectionString: string, container: string) {
    this.container = new ContainerClient(connectionString, container);
  }

  async ensureContainer(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async ping(): Promise<void> {
    await this.container.getProperties();
  }

  async has(key: string): Promise<boolean> {
    return this.container.getBlockBlobClient(key).exists();
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.container
      .getBlockBlobClient(key)
      .uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { statusCode?: number }).statusCode === 404;
}
