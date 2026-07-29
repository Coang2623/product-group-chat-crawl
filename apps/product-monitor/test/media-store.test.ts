import { createHash } from "node:crypto";
import { access, link, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

const nativeFileSystem: MediaFileSystem = { mkdir, lstat, realpath, open, link, unlink, rm };

describe("MediaStore", () => {
    const directories: string[] = [];
    const databases: ReturnType<typeof createTestDatabase>[] = [];

    const createHarness = async (overrides: {
        maximumBytes?: number;
        mediaDirectory?: string;
        fileSystem?: MediaFileSystem;
        onError?: (error: unknown) => void;
    } = {}) => {
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
            onError: overrides.onError,
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
    ])("marks %s as failed, leaves its database retry state, and leaves no file", async (_label, response) => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        harness.setResponse(response);

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        expect(harness.repo.listPendingExcelJobs()).toEqual([]);
        await expect(readdir(harness.product.mediaDirectory)).resolves.toEqual([]);
    });

    it("accepts any case-insensitive image/ content type, including TIFF", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        harness.setResponse(imageResponse(JPEG_BYTES, "IMAGE/TIFF; charset=binary"));

        await expect(harness.store.download(harness.product, media)).resolves.toMatchObject({ downloadStatus: "downloaded" });
    });

    it("rejects an oversized stream before publishing a final file", async () => {
        const harness = await createHarness({ maximumBytes: 4 });
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(harness.product.mediaDirectory, "001.jpg"))).rejects.toThrow();
        await expect(access(resolve(harness.product.mediaDirectory, "001.jpg.part"))).rejects.toThrow();
    });

    it("rejects an oversized content-length before opening a part file", async () => {
        const harness = await createHarness({ maximumBytes: 4 });
        const media = attach(harness, pendingMedia(harness.product));
        harness.setResponse(new Response(JPEG_BYTES, {
            headers: { "content-type": "image/jpeg", "content-length": String(JPEG_BYTES.byteLength) },
        }));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(readdir(harness.product.mediaDirectory)).resolves.toEqual([]);
    });

    it("uses the injected filesystem adapter for the atomic part-to-final write", async () => {
        const calls: string[] = [];
        const fileSystem: MediaFileSystem = {
            ...nativeFileSystem,
            mkdir: async (path, options) => {
                calls.push("mkdir");
                return mkdir(path, options);
            },
            open: async (path, flags) => {
                calls.push("open");
                return open(path, flags);
            },
        };
        const harness = await createHarness({ fileSystem });
        const media = attach(harness, pendingMedia(harness.product));

        await harness.store.download(harness.product, media);

        expect(calls).toContain("mkdir");
        expect(calls).toContain("open");
    });

    it("keeps writing a chunk until an injected adapter reports every byte written", async () => {
        const partialFileSystem: MediaFileSystem = {
            ...nativeFileSystem,
            mkdir,
            open: async (path, flags) => {
                const file = await open(path, flags);
                return {
                    write: async (bytes) => {
                        const result = await file.write(bytes.subarray(0, 1));
                        return { bytesWritten: result.bytesWritten };
                    },
                    close: () => file.close(),
                };
            },
        };
        const harness = await createHarness({ fileSystem: partialFileSystem });
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        await expect(readFile(stored.localPath!)).resolves.toEqual(JPEG_BYTES);
    });

    it("keeps the stream failure as the operational error when close cleanup also fails", async () => {
        const errors: unknown[] = [];
        const fileSystem: MediaFileSystem = {
            ...nativeFileSystem,
            open: async (path, flags) => {
                const file = await open(path, flags);
                return {
                    write: (bytes) => file.write(bytes),
                    close: async () => {
                        await file.close();
                        throw new Error("close cleanup failure");
                    },
                };
            },
        };
        const harness = await createHarness({ maximumBytes: 4, fileSystem, onError: (error) => errors.push(error) });
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        expect(errors).toContainEqual(expect.objectContaining({ message: "Image exceeds maximum size" }));
        expect(errors).toContainEqual(expect.objectContaining({ message: "close cleanup failure" }));
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

    it("preserves an existing final file when exclusive publication loses", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        await mkdir(harness.product.mediaDirectory, { recursive: true });
        const finalPath = resolve(harness.product.mediaDirectory, "001.jpg");
        await writeFile(finalPath, "existing final");

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(readFile(finalPath, "utf8")).resolves.toBe("existing final");
        expect((await readdir(harness.product.mediaDirectory)).some((name) => name.endsWith(".part"))).toBe(false);
    });

    it("keeps one final image when simultaneous attempts use unique owned parts", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));

        await Promise.all([
            harness.store.download(harness.product, media),
            harness.store.download(harness.product, media),
        ]);

        expect(await readFile(resolve(harness.product.mediaDirectory, "001.jpg"))).toEqual(JPEG_BYTES);
        expect((await readdir(harness.product.mediaDirectory)).some((name) => name.endsWith(".part"))).toBe(false);
    });

    it("turns a concurrent downloaded-checksum constraint loss into a duplicate and removes only its final", async () => {
        const harness = await createHarness();
        const first = attach(harness, pendingMedia(harness.product, { id: "media-i1", sourceMessageId: "i1", sequence: 1 }));
        const second = attach(harness, pendingMedia(harness.product, { id: "media-i2", sourceMessageId: "i2", sequence: 2 }));

        await Promise.all([
            harness.store.download(harness.product, first),
            harness.store.download(harness.product, second),
        ]);

        expect(harness.repo.listMedia(harness.product.id).map((media) => media.downloadStatus)).toEqual(["downloaded", "duplicate"]);
        expect(await readdir(harness.product.mediaDirectory)).toEqual(["001.jpg"]);
    });

    it("rejects a product directory outside mediaRoot without trusting source identifiers", async () => {
        const harness = await createHarness({ mediaDirectory: resolve(tmpdir(), "escaped-product-media") });
        const media = attach(harness, pendingMedia(harness.product, { sourceMessageId: "../../bad.jpg" }));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(tmpdir(), "escaped-product-media", "001.jpg"))).rejects.toThrow();
    });

    it("uses canonical database rows and does not mutate a media row for a forged caller product", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        const forgedProduct = { ...harness.product, id: "forged-product" };

        const result = await harness.store.download(forgedProduct, media);

        expect(result.downloadStatus).toBe("pending");
        expect(harness.repo.listMedia(harness.product.id)).toMatchObject([{ downloadStatus: "pending" }]);
        expect(harness.repo.listPendingExcelJobs()).toEqual([]);
    });

    it("compensates a product-state transaction failure by removing its own final file and marking media failed", async () => {
        const harness = await createHarness();
        const media = attach(harness, pendingMedia(harness.product));
        harness.repo.enqueueExcelSync = () => {
            throw new Error("injected Excel failure");
        };

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(harness.product.mediaDirectory, "001.jpg"))).rejects.toThrow();
    });

    it("rejects a symlinked component that would escape the owned media root", async () => {
        const harness = await createHarness();
        const outside = await mkdtemp(join(tmpdir(), "product-monitor-outside-"));
        directories.push(outside);
        await mkdir(harness.mediaRoot, { recursive: true });
        try {
            await symlink(outside, resolve(harness.mediaRoot, "2026-07"), "junction");
        } catch {
            return;
        }
        const media = attach(harness, pendingMedia(harness.product));

        const stored = await harness.store.download(harness.product, media);

        expect(stored.downloadStatus).toBe("failed");
        await expect(access(resolve(outside, "product-1", "001.jpg"))).rejects.toThrow();
    });
});
