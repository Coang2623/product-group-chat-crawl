import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { createTestDatabase, fixtureProduct } from "./helpers.js";

describe("SqliteProductRepository", () => {
    const databases: Database.Database[] = [];

    const createRepository = () => {
        const database = createTestDatabase();
        databases.push(database);
        return new SqliteProductRepository(database);
    };

    afterEach(() => databases.splice(0).forEach((database) => database.close()));

    it("persists one active product and coalesces excel jobs", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct({ status: "receiving_images" }));

        repo.enqueueExcelSync(product.id);
        repo.enqueueExcelSync(product.id);

        expect(repo.getActiveProduct()?.id).toBe(product.id);
        expect(repo.listPendingExcelJobs()).toHaveLength(1);
    });

    it("enforces a single active draft and completes it atomically", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct());

        expect(() => repo.createProduct(fixtureProduct({ id: "product-2", descriptionMessageId: "message-2" }))).toThrow();
        expect(repo.completeActiveProduct(100)).toMatchObject({ id: product.id, status: "completed", updatedAt: 100 });
        expect(repo.getActiveProduct()).toBeNull();
        expect(repo.completeActiveProduct(200)).toBeNull();
    });

    it("maps nullable fields and supports product lookups and filters", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct({
            senderName: "Tracie",
            productName: "ZBook",
            condition: "used",
            price: 5_900_000,
            rawPrice: "5 triệu 900",
            notes: "minor scratch",
        }));
        repo.completeActiveProduct(200);
        repo.createProduct(fixtureProduct({ id: "product-2", descriptionMessageId: "message-2", groupId: "group-2" }));

        expect(repo.getProduct(product.id)).toMatchObject({ senderName: "Tracie", condition: "used", price: 5_900_000 });
        expect(repo.getProductByMessageId("message-1")?.id).toBe(product.id);
        expect(repo.listProducts({ groupId: "group-1", status: "completed" }).map((item) => item.id)).toEqual([product.id]);
        expect(repo.listProducts({ groupId: "missing" })).toEqual([]);
    });

    it("cascades media, reactions, and sync jobs when a product is deleted", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct());
        repo.addMedia({ id: "media-1", productId: product.id, sourceMessageId: "image-1", sequence: 1, downloadStatus: "pending", createdAt: 10 });
        repo.setHeartState({ productId: product.id, targetMessageId: "image-1", userId: "user-1", icon: "heart", active: true, updatedAt: 11 });
        repo.enqueueExcelSync(product.id);

        expect(() => repo.database.prepare("DELETE FROM products WHERE id = ?").run(product.id)).not.toThrow();
        expect(repo.database.prepare("SELECT COUNT(*) AS count FROM product_media").get()).toMatchObject({ count: 0 });
        expect(repo.database.prepare("SELECT COUNT(*) AS count FROM product_reactions").get()).toMatchObject({ count: 0 });
        expect(repo.database.prepare("SELECT COUNT(*) AS count FROM excel_sync_jobs").get()).toMatchObject({ count: 0 });
    });

    it("updates media and derives its product summary", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct());
        repo.addMedia({ id: "media-1", productId: product.id, sourceMessageId: "image-1", sequence: 2, downloadStatus: "pending", createdAt: 10 });
        repo.addMedia({ id: "media-2", productId: product.id, sourceMessageId: "image-2", sequence: 1, localPath: "first.jpg", downloadStatus: "downloaded", createdAt: 11 });
        repo.updateMedia("media-1", { localPath: "second.jpg", checksum: "abc", downloadStatus: "downloaded" });

        expect(repo.listMedia(product.id).map((media) => media.id)).toEqual(["media-2", "media-1"]);
        expect(repo.updateProductMediaSummary(product.id)).toMatchObject({ imageCount: 2, coverImagePath: "first.jpg" });
    });

    it("counts only active canonical hearts per user and records sync job outcomes", () => {
        const repo = createRepository();
        const product = repo.createProduct(fixtureProduct());
        repo.setHeartState({ productId: product.id, targetMessageId: "image-1", userId: "user-1", icon: "/-heart", active: true, updatedAt: 1 });
        repo.setHeartState({ productId: product.id, targetMessageId: "image-2", userId: "user-1", icon: "/-heart", active: true, updatedAt: 2 });
        repo.setHeartState({ productId: product.id, targetMessageId: "image-1", userId: "user-2", icon: "/-heart", active: true, updatedAt: 3 });
        repo.setHeartState({ productId: product.id, targetMessageId: "image-3", userId: "user-3", icon: "/-like", active: true, updatedAt: 4 });

        expect(repo.countUniqueHearts(product.id)).toBe(2);
        repo.setHeartState({ productId: product.id, targetMessageId: "image-1", userId: "user-2", icon: "/-like", active: true, updatedAt: 5 });
        expect(repo.countUniqueHearts(product.id)).toBe(1);
        expect(repo.updateHeartCount(product.id, 2).heartCount).toBe(2);
        repo.enqueueExcelSync(product.id);
        repo.markExcelJob(product.id, "failed", "network");
        expect(repo.listPendingExcelJobs()).toEqual([]);
        expect(repo.database.prepare("SELECT attempts, last_error FROM excel_sync_jobs WHERE product_id = ?").get(product.id)).toMatchObject({ attempts: 1, last_error: "network" });
    });

    it("persists settings", () => {
        const repo = createRepository();
        expect(repo.getSetting("cursor")).toBeNull();
        repo.setSetting("cursor", "message-9");
        repo.setSetting("cursor", "message-10");
        expect(repo.getSetting("cursor")).toBe("message-10");
    });
});
