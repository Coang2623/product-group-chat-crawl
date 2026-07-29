import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProductMedia, ProductRecord } from "../../shared/domain.js";
import type { ProductRepository } from "../db/product-repository.js";

const DEFAULT_MAXIMUM_BYTES = 10 * 1024 * 1024;

type DownloadResponse = {
    ok: boolean;
    status: number;
    headers: Pick<Headers, "get">;
    body: ReadableStream<Uint8Array> | null;
};

type WriteResult = { bytesWritten: number };

type WritableFile = {
    write(data: Uint8Array): Promise<WriteResult>;
    close(): Promise<void>;
};

type PathStats = {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
};

export type MediaFileSystem = {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    lstat(path: string): Promise<PathStats>;
    realpath(path: string): Promise<string>;
    open(path: string, flags: "wx"): Promise<WritableFile>;
    link(existingPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rm(path: string, options: { force: true }): Promise<void>;
};

export type MediaStoreOptions = {
    mediaRoot: string;
    fetch: (url: string) => Promise<DownloadResponse>;
    fileSystem?: MediaFileSystem;
    maximumBytes?: number;
    temporaryId?: () => string;
    onError?: (error: unknown) => void;
};

const nodeFileSystem: MediaFileSystem = { mkdir, lstat, realpath, open, link, unlink, rm };

/** Downloads product images into a contained directory and commits their metadata atomically. */
export class MediaStore {
    private readonly fileSystem: MediaFileSystem;
    private readonly maximumBytes: number;
    private readonly temporaryId: () => string;

    public constructor(
        private readonly repository: ProductRepository,
        private readonly options: MediaStoreOptions,
    ) {
        this.fileSystem = options.fileSystem ?? nodeFileSystem;
        this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
        this.temporaryId = options.temporaryId ?? randomUUID;
        if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes <= 0) {
            throw new Error("maximumBytes must be a positive safe integer");
        }
    }

    async download(callerProduct: ProductRecord, callerMedia: ProductMedia): Promise<ProductMedia> {
        const product = this.repository.getProduct(callerProduct.id);
        const media = this.repository.getMedia(callerMedia.id);
        if (!product || !media || media.productId !== product.id || callerMedia.productId !== product.id) {
            return media ?? callerMedia;
        }
        if (media.downloadStatus === "downloaded" || media.downloadStatus === "duplicate") return media;

        let tempPath: string | undefined;
        let finalPath: string | undefined;
        let publishedFinal = false;
        let checksum: string | undefined;
        try {
            if (!media.sourceUrl) throw new Error("Media has no source URL");
            const paths = await this.safePathsFor(product, media);
            tempPath = paths.tempPath;
            finalPath = paths.finalPath;
            const response = await this.options.fetch(media.sourceUrl);
            if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
            this.assertImageMimeType(response.headers.get("content-type"));
            this.assertContentLength(response.headers.get("content-length"));

            checksum = await this.writeStreamToPart(response.body, tempPath);
            if (this.hasDownloadedChecksum(product.id, media.id, checksum)) {
                await this.cleanup(tempPath);
                return this.markDuplicate(media.id, checksum);
            }

            await this.fileSystem.link(tempPath, finalPath);
            publishedFinal = true;
            await this.fileSystem.unlink(tempPath);
            return this.commitDownloaded(product.id, media.id, finalPath, checksum);
        } catch (error) {
            if (this.isDownloadedChecksumConflict(error)) {
                await this.cleanup(tempPath, publishedFinal ? finalPath : undefined);
                return this.markDuplicate(media.id, checksum);
            }
            this.report(error);
            await this.cleanup(tempPath, publishedFinal ? finalPath : undefined);
            return this.markFailed(media.id);
        }
    }

    async retryPending(): Promise<void> {
        for (const media of this.repository.listRetryableMedia()) {
            const product = this.repository.getProduct(media.productId);
            if (product) await this.download(product, media);
        }
    }

    private async safePathsFor(product: ProductRecord, media: ProductMedia): Promise<{ tempPath: string; finalPath: string }> {
        if (!Number.isSafeInteger(media.sequence) || media.sequence < 1) {
            throw new Error("Media sequence must be a positive safe integer");
        }
        const root = resolve(this.options.mediaRoot);
        const directory = resolve(product.mediaDirectory);
        this.assertDescendant(root, directory);
        const realDirectory = await this.ensureOwnedDirectory(root, directory);
        const filename = `${String(media.sequence).padStart(3, "0")}.jpg`;
        const finalPath = resolve(realDirectory, filename);
        this.assertDescendant(realDirectory, finalPath);
        return { finalPath, tempPath: `${finalPath}.${this.temporaryId()}.part` };
    }

    private async ensureOwnedDirectory(root: string, directory: string): Promise<string> {
        await this.fileSystem.mkdir(root, { recursive: true });
        await this.assertDirectoryNotLink(root);
        const realRoot = await this.fileSystem.realpath(root);
        const descendant = relative(root, directory);
        const segments = descendant.split(sep).filter(Boolean);
        let current = root;
        for (const segment of segments) {
            current = join(current, segment);
            await this.fileSystem.mkdir(current, { recursive: true });
            await this.assertDirectoryNotLink(current);
        }
        const realDirectory = await this.fileSystem.realpath(directory);
        this.assertDescendant(realRoot, realDirectory);
        return realDirectory;
    }

    private async assertDirectoryNotLink(path: string): Promise<void> {
        const stats = await this.fileSystem.lstat(path);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error(`Media path is not a real directory: ${path}`);
        }
    }

    private async writeStreamToPart(body: ReadableStream<Uint8Array> | null, tempPath: string): Promise<string> {
        if (!body) throw new Error("Image response has no body");
        const file = await this.fileSystem.open(tempPath, "wx");
        const reader = body.getReader();
        const checksum = createHash("sha256");
        let bytesReceived = 0;
        let completed = false;
        let primaryError: unknown;
        let closeError: unknown;
        let digest: string | undefined;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytesReceived += value.byteLength;
                if (bytesReceived > this.maximumBytes) throw new Error("Image exceeds maximum size");
                await this.writeCompletely(file, value);
                checksum.update(value);
            }
            digest = checksum.digest("hex");
            completed = true;
        } catch (error) {
            primaryError = error;
        } finally {
            if (!completed) this.cancelReader(reader);
            try {
                reader.releaseLock();
            } catch (error) {
                this.report(error);
            }
            try {
                await file.close();
            } catch (error) {
                if (primaryError) this.report(error);
                else closeError = error;
            }
        }
        if (primaryError) throw primaryError;
        if (closeError) throw closeError;
        if (!digest) throw new Error("Image download did not produce a checksum");
        return digest;
    }

    private async writeCompletely(file: WritableFile, bytes: Uint8Array): Promise<void> {
        let offset = 0;
        while (offset < bytes.byteLength) {
            const { bytesWritten } = await file.write(bytes.subarray(offset));
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
                throw new Error("Media filesystem reported an invalid partial write");
            }
            offset += bytesWritten;
        }
    }

    private commitDownloaded(productId: string, mediaId: string, finalPath: string, checksum: string): ProductMedia {
        return this.repository.runInTransaction(() => {
            const downloaded = this.repository.updateMedia(mediaId, {
                localPath: finalPath,
                checksum,
                downloadStatus: "downloaded",
            });
            this.repository.updateProductMediaSummary(productId);
            this.repository.enqueueExcelSync(productId);
            return downloaded;
        });
    }

    private markDuplicate(mediaId: string, checksum: string | undefined): ProductMedia {
        return this.repository.runInTransaction(() => this.repository.updateMedia(mediaId, {
            checksum,
            downloadStatus: "duplicate",
        }));
    }

    private markFailed(mediaId: string): ProductMedia {
        return this.repository.runInTransaction(() => this.repository.updateMedia(mediaId, {
            downloadStatus: "failed",
        }));
    }

    private hasDownloadedChecksum(productId: string, mediaId: string, checksum: string): boolean {
        return this.repository.listMedia(productId).some((existing) =>
            existing.id !== mediaId && existing.downloadStatus === "downloaded" && existing.checksum === checksum,
        );
    }

    private isDownloadedChecksumConflict(error: unknown): boolean {
        return error instanceof Error &&
            (error as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
            (error.message.includes("product_media_downloaded_checksum_unique") ||
                error.message.includes("product_media.product_id, product_media.checksum"));
    }

    private assertImageMimeType(contentType: string | null): void {
        if (!contentType?.trim().toLowerCase().startsWith("image/")) {
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

    private async cleanup(...paths: Array<string | undefined>): Promise<void> {
        for (const path of paths) {
            if (!path) continue;
            try {
                await this.fileSystem.rm(path, { force: true });
            } catch (error) {
                this.report(error);
            }
        }
    }

    private cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
        void reader.cancel().catch((error: unknown) => this.report(error));
    }

    private report(error: unknown): void {
        try {
            this.options.onError?.(error);
        } catch {
            // Error reporting must not change media persistence outcomes.
        }
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
