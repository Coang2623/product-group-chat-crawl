import { createHash } from "node:crypto";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProductMedia, ProductRecord } from "../../shared/domain.js";
import type { ProductRepository } from "../db/product-repository.js";

const DEFAULT_MAXIMUM_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
]);

type DownloadResponse = {
    ok: boolean;
    status: number;
    headers: Pick<Headers, "get">;
    body: ReadableStream<Uint8Array> | null;
};

type WritableFile = {
    write(data: Uint8Array): Promise<unknown>;
    close(): Promise<void>;
};

export type MediaFileSystem = {
    access(path: string): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    open(path: string, flags: "wx"): Promise<WritableFile>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(path: string, options: { force: true }): Promise<void>;
};

export type MediaStoreOptions = {
    mediaRoot: string;
    fetch: (url: string) => Promise<DownloadResponse>;
    fileSystem?: MediaFileSystem;
    maximumBytes?: number;
};

const nodeFileSystem: MediaFileSystem = { access, mkdir, open, rename, rm };

/** Downloads product images into a contained directory and commits their metadata atomically. */
export class MediaStore {
    private readonly fileSystem: MediaFileSystem;
    private readonly maximumBytes: number;

    public constructor(
        private readonly repository: ProductRepository,
        private readonly options: MediaStoreOptions,
    ) {
        this.fileSystem = options.fileSystem ?? nodeFileSystem;
        this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
        if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes <= 0) {
            throw new Error("maximumBytes must be a positive safe integer");
        }
    }

    async download(product: ProductRecord, media: ProductMedia): Promise<ProductMedia> {
        if (media.productId !== product.id) return this.fail(product, media);
        if (media.downloadStatus === "downloaded" || media.downloadStatus === "duplicate") return media;

        let tempPath: string | undefined;
        let finalPath: string | undefined;
        let published = false;

        try {
            if (!media.sourceUrl) throw new Error("Media has no source URL");
            ({ tempPath, finalPath } = this.pathsFor(product, media));
            const response = await this.options.fetch(media.sourceUrl);
            if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
            this.assertAllowedMimeType(response.headers.get("content-type"));
            this.assertContentLength(response.headers.get("content-length"));

            await this.fileSystem.mkdir(product.mediaDirectory, { recursive: true });
            if (await this.exists(finalPath)) throw new Error("Refusing to overwrite an existing media file");

            const checksum = await this.writeStreamToPart(response.body, tempPath);
            if (this.hasDownloadedChecksum(product.id, media.id, checksum)) {
                await this.removeIfPresent(tempPath);
                return this.repository.runInTransaction(() => this.repository.updateMedia(media.id, {
                    checksum,
                    downloadStatus: "duplicate",
                }));
            }

            await this.fileSystem.rename(tempPath, finalPath);
            published = true;
            return this.repository.runInTransaction(() => {
                const downloaded = this.repository.updateMedia(media.id, {
                    localPath: finalPath,
                    checksum,
                    downloadStatus: "downloaded",
                });
                this.repository.updateProductMediaSummary(product.id);
                this.repository.enqueueExcelSync(product.id);
                return downloaded;
            });
        } catch {
            if (published && finalPath) await this.removeIfPresent(finalPath);
            if (tempPath) await this.removeIfPresent(tempPath);
            return this.fail(product, media);
        }
    }

    async retryPending(): Promise<void> {
        for (const product of this.repository.listProducts()) {
            for (const media of this.repository.listMedia(product.id)) {
                if (media.downloadStatus === "pending" || media.downloadStatus === "failed") {
                    await this.download(product, media);
                }
            }
        }
    }

    private async writeStreamToPart(body: ReadableStream<Uint8Array> | null, tempPath: string): Promise<string> {
        if (!body) throw new Error("Image response has no body");
        const file = await this.fileSystem.open(tempPath, "wx");
        const reader = body.getReader();
        const checksum = createHash("sha256");
        let bytesWritten = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytesWritten += value.byteLength;
                if (bytesWritten > this.maximumBytes) throw new Error("Image exceeds maximum size");
                checksum.update(value);
                await file.write(value);
            }
            return checksum.digest("hex");
        } finally {
            reader.releaseLock();
            await file.close();
        }
    }

    private pathsFor(product: ProductRecord, media: ProductMedia): { tempPath: string; finalPath: string } {
        if (!Number.isSafeInteger(media.sequence) || media.sequence < 1) {
            throw new Error("Media sequence must be a positive safe integer");
        }
        const root = resolve(this.options.mediaRoot);
        const directory = resolve(product.mediaDirectory);
        this.assertDescendant(root, directory);
        const filename = `${String(media.sequence).padStart(3, "0")}.jpg`;
        const finalPath = resolve(directory, filename);
        this.assertDescendant(directory, finalPath);
        return { finalPath, tempPath: `${finalPath}.part` };
    }

    private hasDownloadedChecksum(productId: string, mediaId: string, checksum: string): boolean {
        return this.repository.listMedia(productId).some((existing) =>
            existing.id !== mediaId && existing.downloadStatus === "downloaded" && existing.checksum === checksum,
        );
    }

    private async fail(product: ProductRecord, media: ProductMedia): Promise<ProductMedia> {
        return this.repository.runInTransaction(() => {
            const failed = this.repository.updateMedia(media.id, { downloadStatus: "failed" });
            this.repository.enqueueExcelSync(product.id);
            return failed;
        });
    }

    private assertAllowedMimeType(contentType: string | null): void {
        const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
        if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
            throw new Error(`Unsupported image MIME type: ${contentType ?? "missing"}`);
        }
    }

    private assertContentLength(contentLength: string | null): void {
        if (!contentLength) return;
        const bytes = Number(contentLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximumBytes) {
            throw new Error("Image exceeds maximum size");
        }
    }

    private async exists(path: string): Promise<boolean> {
        try {
            await this.fileSystem.access(path);
            return true;
        } catch {
            return false;
        }
    }

    private async removeIfPresent(path: string): Promise<void> {
        await this.fileSystem.rm(path, { force: true });
    }

    private assertDescendant(root: string, candidate: string): void {
        const pathFromRoot = relative(root, candidate);
        if (
            pathFromRoot === "" ||
            pathFromRoot === ".." ||
            pathFromRoot.startsWith(`..${sep}`) ||
            isAbsolute(pathFromRoot)
        ) {
            throw new Error(`Resolved path escapes its root: ${candidate}`);
        }
    }
}
