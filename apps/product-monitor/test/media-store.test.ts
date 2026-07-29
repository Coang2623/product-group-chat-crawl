import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { MediaStore, type MediaFileSystem } from "../src/server/media/media-store.js";
import type { ProductMedia, ProductRecord } from "../src/shared/domain.js";
import { createTestDatabase, fixtureProduct } from "./helpers.js";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const imageResponse = (bytes: Uint8Array, contentType = "image/jpeg", status = 200): Response =>
    new Response(bytes, { status, headers: { "content-type": contentType } });

describe("MediaStore", () => {
    const directories: string[] = [];
    const databases: ReturnType<typeof createTestDatabase>[] = [];

    const createHarness = async (overrides: { maximumBytes?: number; mediaDirectory?: string; fileSystem?: MediaFileSystem } = {}) => {
        const directory = await mkdtemp(join(tmpdir(), "product-monitor-media-"));
        directories.push(directory);
        const mediaRoot = resolve(directory, "media");
        const database = createTestDatabase();
        databases.push(database);
        const repo = new SqliteProductRepository(database);
        const product = repo.createProduct(fixtureProduct({
            mediaDirectory: overrides.mediaDirectory ?? resolve(mediaRoot, "2026-07", "product-1"),
        }));
        let response: Response = imageResponse(JPEG_BYTES);
        const store = new MediaStore(repo, {
            mediaRoot,
            maximumBytes: overrides.maximumBytes,
            fetch: async () => response.clone(),
            fileSystem: overrides.fileSystem,
        });

        return {
            directory,
            mediaRoot,
            product,
            repo,
            setResponse: (next: Response) => { response = next; },
            store,
        };
    };

    const pendingMedia = (product: ProductRecord, overrides: Partial<ProductMedia> = {}): ProductMedia => ({
        id: `media-${overrides.sourceMessageId ?? "i1"}`,
        productId: product.id,
        sourceMessageId: "i1",
        sourceUrl: "https://example.test/image.jpg",
        sequence: 1,
        downloadStatus: "pending",
        createdAt: 1,
        ...overrides,
    });

    const attach = (harness: Awaited<ReturnType<typeof createHarness>>, media: ProductMedia): ProductMedia =>
        harness.repo.addMedia(media);

    afterEach(async () => {
        databases.splice(0).forEach((database) => database.close());
        await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    it("stores ordered images and chooses the first as cover", async () => {
        const harness = await createHarness();
        const first = attach(harness, pendingMedia(harness.product, { sequence: 1 }));
        const second = attach(harness, pendingMedia(harness.product, { id: "media-i2", sourceMessageId: "i2", sequence: 2 }));

        await harness.store.download(harness.product, first);
        await harness.store.download(harness.product, second);

        expect(harness.repo.getProduct(harness.product.id)?.coverImagePath).toMatch(/001\.jpg$/);
        expect(harness.repo.listMedia(harness.product.id)).toHaveLength(2);
        await expect(readFile(resolve(harness.product.mediaDirectory, "001.jpg"))).resolves.toEqual(JPEG_BYTES);
    });

    it("does not duplicate identical checksums", async () => {
        const harness = await createHarness();
        const first = attach(harness, pendingMedia(harness.product, { sourceMessageId: "i1" }));
        const second = attach(harness, pendingMedia(harness.product, { id: "media-i2", sourceMessageId: "i2", sequence: 2 }));

        await harness.store.download(harness.product, first);
        await harness.store.download(harness.product, second);

        expect(harness.repo.listMedia(harness.product.id).filter((media) => media.downloadStatus === "downloaded")).toHaveLength(1);
        expect(harness.repo.listMedia(harness.product.id)[1]).toMatchObject({ downloadStatus: "duplicate" });
        expect(await readdir(harness.product.mediaDirectory)).toEqual(["001.jpg"]);
    });

    it("streams to a .part file and atomically publishes a SHA-256 checked image", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        expect(stored).toMatchObject({
            downloadStatus: "downloaded",
            checksum: createHash("sha256").update(JPEG_BYTES).digest("hex"),
            localPath: resolve(harness.product.mediaDirectory, "001.jpg"),
        });
        await expect(access(`${stored.localPath}.part`)).rejects.toThrow();
        await expect(readFile(stored.localPath!)).resolves.toEqual(JPEG_BYTES);
    });

    it.each([
        ["HTTP failure", imageResponse(JPEG_BYTES, "image/jpeg", 503)],
        ["non-image MIME", imageResponse(JPEG_BYTES, "text/plain")],
        ["MIME outside the allowlist", imageResponse(JPEG_BYTES, "image/svg+xml")],
    ])("marks %s as failed, queues a retry, and leaves no file", async (_label, response) => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        harness.setResponse(response);

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        expect(harness.repo.listPendingExcelJobs().map((job) => job.productId)).toEqual([harness.product.id]);
        await expect(readdir(harness.product.mediaDirectory)).rejects.toThrow();
    });

    it("rejects an oversized stream before publishing a final file", async () => {
        const harness = await createHarness({ maximumBytes: 4 });
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(harness.product.mediaDirectory, "001.jpg"))).rejects.toThrow();
        await expect(access(resolve(harness.product.mediaDirectory, "001.jpg.part"))).rejects.toThrow();
    });

    it("uses the injected filesystem adapter for the atomic part-to-final write", async () => {
        const calls: string[] = [];
        const fileSystem: MediaFileSystem = {
            access,
            mkdir: async (path, options) => {
                calls.push("mkdir");
                return mkdir(path, options);
            },
            open: async (path, flags) => {
                calls.push("open");
                return open(path, flags);
            },
            rename: async (oldPath, newPath) => {
                calls.push("rename");
                await rename(oldPath, newPath);
            },
            rm,
        };
        const harness = await createHarness({ fileSystem });
        const media = attach(harness, pendingMedia(harness.product));

        await harness.store.download(harness.product, media);

        expect(calls).toEqual(["mkdir", "open", "rename"]);
    });

    it("retries failed media with its persisted source URL without duplicating the final file", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        harness.setResponse(imageResponse(JPEG_BYTES, "text/plain"));
        await harness.store.download(harness.product, media);
        harness.setResponse(imageResponse(JPEG_BYTES));

        await harness.store.retryPending();

        expect(harness.repo.listMedia(harness.product.id)).toMatchObject([{ downloadStatus: "downloaded" }]);
        expect(await readdir(harness.product.mediaDirectory)).toEqual(["001.jpg"]);
    });

    it("rejects a product directory outside mediaRoot without trusting source identifiers", async () => {
        const harness = await createHarness({ mediaDirectory: resolve(tmpdir(), "escaped-product-media") });
        const media = attach(harness, pendingMedia(harness.product, { sourceMessageId: "../../bad.jpg" }));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(tmpdir(), "escaped-product-media", "001.jpg"))).rejects.toThrow();
    });
});
