import { randomBytes } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureBlobStore } from "../src/azure-blobs.js";

const conn = process.env.TEST_BLOB_CONNECTION_STRING;
if (!conn) throw new Error("TEST_BLOB_CONNECTION_STRING is not set; run `npm run test:integration` with compose.test.yml up");

const container = `t-${randomBytes(8).toString("hex")}`;
let store: AzureBlobStore;

beforeAll(async () => {
  store = new AzureBlobStore(conn, container);
  await store.ensureContainer();
});

afterAll(async () => {
  await BlobServiceClient.fromConnectionString(conn).deleteContainer(container);
});

describe("AzureBlobStore", () => {
  it("put then get returns the same bytes", async () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    await store.put("vaults/v1/blobs/abc", data, "application/octet-stream");
    expect(await store.has("vaults/v1/blobs/abc")).toBe(true);
    const got = await store.get("vaults/v1/blobs/abc");
    expect(got && Array.from(got)).toEqual(Array.from(data));
  });

  it("a missing key is null and absent", async () => {
    expect(await store.get("vaults/v1/blobs/nope")).toBeNull();
    expect(await store.has("vaults/v1/blobs/nope")).toBe(false);
  });

  it("ensureContainer twice is harmless", async () => {
    await store.ensureContainer();
    await store.ensureContainer();
  });

  it("ping succeeds", async () => {
    await store.ping();
  });
});
