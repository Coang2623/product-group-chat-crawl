import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import type Database from "better-sqlite3";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { ProductCoordinator } from "../src/server/products/product-coordinator.js";
import {
    createHttpApp,
    SseHub,
} from "../src/server/http/app.js";
import type { ZaloProductAdapter } from "../src/server/zalo/zalo-adapter.js";
import { createTestDatabase, descriptionEvent } from "./helpers.js";

describe("product monitor HTTP app", () => {
    let database: Database.Database;
    let repository: SqliteProductRepository;
    let coordinator: ProductCoordinator;
    let excelWorker: { syncPending: ReturnType<typeof vi.fn> };
    let zalo: ZaloProductAdapter;
    let selectGroup: ReturnType<typeof vi.fn>;
    let beginQrLogin: ReturnType<typeof vi.fn>;
    let writeSpy: ReturnType<typeof vi.fn>;
    let app: ReturnType<typeof createHttpApp>;
    const temporaryDirectories: string[] = [];

    beforeEach(() => {
        database = createTestDatabase();
        repository = new SqliteProductRepository(database);
        coordinator = new ProductCoordinator(repository, {
            activeGroupId: "g1",
            publisherId: "admin-1",
            mediaRoot: "data/media",
        });
        excelWorker = {
            syncPending: vi.fn().mockResolvedValue({ synced: 1, blocked: 0, failed: 0 }),
        };
        selectGroup = vi.fn().mockImplementation(async (groupId: string) => {
            repository.setSetting("activeGroupId", groupId);
        });
        beginQrLogin = vi.fn().mockImplementation(async (callback) => {
            callback({ image: "qr-image", state: "waiting_for_scan" });
        });
        writeSpy = vi.fn();
        zalo = {
            getConnectionState: () => "connected",
            beginQrLogin,
            restoreSession: vi.fn().mockResolvedValue(true),
            listGroups: vi.fn().mockResolvedValue([
                { id: "g1", name: "Laptop giá tốt", adminIds: ["admin-1"] },
            ]),
            selectGroup,
            start: vi.fn(),
            stop: vi.fn(),
            onDescription: vi.fn(),
            onImage: vi.fn(),
            onReaction: vi.fn(),
            ...({ writeToZalo: writeSpy } as object),
        };
        app = createHttpApp({ repository, coordinator, excelWorker, zalo });
    });

    afterEach(async () => {
        database.close();
        await Promise.all(temporaryDirectories.splice(0).map(
            (directory) => rm(directory, { recursive: true, force: true }),
        ));
    });

    it("lists groups and selects exactly one active group", async () => {
        const groups = await request(app).get("/api/groups").expect(200);
        expect(groups.body).toEqual({
            groups: [{ id: "g1", name: "Laptop giá tốt", adminIds: ["admin-1"] }],
        });

        await request(app)
            .put("/api/settings/active-group")
            .send({ groupId: "g1" })
            .expect(204);

        expect(selectGroup).toHaveBeenCalledWith("g1");
        expect(repository.getSetting("activeGroupId")).toBe("g1");
    });

    it("rejects malformed group and product identifiers consistently", async () => {
        await request(app)
            .put("/api/settings/active-group")
            .send({ groupId: "../escape" })
            .expect(400, {
                error: { code: "invalid_request", message: "Dữ liệu yêu cầu không hợp lệ" },
            });
        await request(app)
            .get("/api/products/%20")
            .expect(400);
    });

    it("lists products and returns details with media", async () => {
        const product = coordinator.handleDescription(descriptionEvent({
            groupId: "g1",
            messageId: "product-message",
        }));
        coordinator.handleImage({
            groupId: "g1",
            senderId: "admin-1",
            messageId: "image-message",
            imageUrl: "https://image.example/one.jpg",
            sentAt: product.postedAt + 1,
        });

        const list = await request(app).get("/api/products?status=receiving_images").expect(200);
        const detail = await request(app).get(`/api/products/${product.id}`).expect(200);

        expect(list.body.products).toHaveLength(1);
        expect(detail.body).toMatchObject({
            product: { id: product.id },
            media: [{ sourceMessageId: "image-message" }],
        });
    });

    it("completes only the active local draft without a Zalo write", async () => {
        const product = coordinator.handleDescription(descriptionEvent({
            groupId: "g1",
            messageId: "active-message",
        }));

        await request(app).post(`/api/products/${product.id}/complete`).expect(200);

        expect(repository.getProduct(product.id)?.status).toBe("completed");
        expect(writeSpy).not.toHaveBeenCalled();
        await request(app).post(`/api/products/${product.id}/complete`).expect(409);
    });

    it("returns not found for an unknown product", async () => {
        await request(app).get("/api/products/missing-product").expect(404, {
            error: { code: "product_not_found", message: "Không tìm thấy sản phẩm" },
        });
    });

    it("starts QR login asynchronously and publishes the QR state", async () => {
        const events: unknown[] = [];
        const hub = new SseHub();
        hub.subscribe((event) => events.push(event));
        app = createHttpApp({ repository, coordinator, excelWorker, zalo, events: hub });

        await request(app).post("/api/auth/qr").expect(202);
        await vi.waitFor(() => expect(beginQrLogin).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(events).toContainEqual({
            type: "auth.qr",
            image: "qr-image",
            state: "waiting_for_scan",
        }));

        await request(app).get("/api/auth/status").expect(200, {
            state: "connected",
        });
    });

    it("syncs Excel on demand and reports durable status", async () => {
        const product = coordinator.handleDescription(descriptionEvent({
            groupId: "g1",
            messageId: "excel-message",
        }));

        await request(app).post("/api/excel/sync").expect(200, {
            synced: 1,
            blocked: 0,
            failed: 0,
        });
        const status = await request(app).get("/api/status").expect(200);
        expect(status.body).toMatchObject({
            connection: "connected",
            excel: { pending: 1, blocked: false },
            activeGroupId: null,
            activeProductId: product.id,
        });
    });

    it("fans each SSE event out to all current subscribers", () => {
        const hub = new SseHub();
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribe = hub.subscribe(first);
        hub.subscribe(second);

        hub.publish({ type: "connection.status", state: "connected" });
        unsubscribe();
        hub.publish({ type: "connection.status", state: "disconnected" });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
    });

    describe("bulk image download", () => {
        const addDownloadedImage = async (productId: string, sequence: number) => {
            const directory = await mkdtemp(join(tmpdir(), "zip-media-"));
            temporaryDirectories.push(directory);
            const file = join(directory, `00${sequence}.jpg`);
            await writeFile(file, Buffer.from(`image-${sequence}`));
            repository.addMedia({
                id: `media-${sequence}`,
                productId,
                sourceMessageId: `image-${sequence}`,
                sequence,
                localPath: file,
                checksum: `checksum-${sequence}`,
                downloadStatus: "downloaded",
                createdAt: sequence,
            });
            repository.updateProductMediaSummary(productId);
        };

        it("returns every downloaded image as one readable archive", async () => {
            const product = coordinator.handleDescription(descriptionEvent({ groupId: "g1", messageId: "m1", sentAt: 100 }));
            await addDownloadedImage(product.id, 1);
            await addDownloadedImage(product.id, 2);

            const response = await request(app)
                .get(`/api/products/${product.id}/images.zip`)
                .buffer(true)
                .parse((res, callback) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => callback(null, Buffer.concat(chunks)));
                })
                .expect(200)
                .expect("Content-Type", "application/zip");

            expect(response.headers["content-disposition"]).toContain(".zip");
            const archive = await JSZip.loadAsync(response.body);
            expect(Object.keys(archive.files).sort()).toEqual(["001.jpg", "002.jpg"]);
            await expect(archive.file("001.jpg")!.async("string")).resolves.toBe("image-1");
            await expect(archive.file("002.jpg")!.async("string")).resolves.toBe("image-2");
        });

        it("reduces a Vietnamese product name to an ASCII filename", async () => {
            const product = coordinator.handleDescription(descriptionEvent({ groupId: "g1", messageId: "m1", sentAt: 100 }));
            await addDownloadedImage(product.id, 1);

            const response = await request(app).get(`/api/products/${product.id}/images.zip`).expect(200);

            // A quote or separator here would break the Content-Disposition header.
            expect(response.headers["content-disposition"]).toMatch(/filename="[A-Za-z0-9-]+\.zip"/);
        });

        it("reports 404 when the product has no downloaded image", async () => {
            const product = coordinator.handleDescription(descriptionEvent({ groupId: "g1", messageId: "m1", sentAt: 100 }));

            await request(app).get(`/api/products/${product.id}/images.zip`).expect(404);
        });

        it("reports 404 for an unknown product", async () => {
            await request(app).get("/api/products/does-not-exist/images.zip").expect(404);
        });
    });
});
