import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { ProductCoordinator } from "../src/server/products/product-coordinator.js";
import type { NormalizedImageEvent } from "../src/shared/domain.js";
import { createTestDatabase, descriptionEvent } from "./helpers.js";

describe("ProductCoordinator", () => {
    const databases: Database.Database[] = [];
    const mediaRoot = join("data", "media");
    let repo: SqliteProductRepository;
    let coordinator: ProductCoordinator;

    beforeEach(() => {
        const database = createTestDatabase();
        databases.push(database);
        repo = new SqliteProductRepository(database);
        coordinator = new ProductCoordinator(repo, {
            activeGroupId: "group-1",
            publisherId: "admin-1",
            mediaRoot,
        });
    });

    afterEach(() => databases.splice(0).forEach((database) => database.close()));

    it("completes the previous draft before creating the next", () => {
        coordinator.handleDescription(descriptionEvent({ messageId: "m1", sentAt: 100 }));
        repo.markExcelJob(repo.getActiveProduct()!.id, "running");

        const second = coordinator.handleDescription(descriptionEvent({ messageId: "m2", sentAt: 200 }));

        const first = repo.getProductByMessageId("m1");
        expect(first).toMatchObject({ status: "completed", updatedAt: 200 });
        expect(repo.getActiveProduct()?.id).toBe(second.id);
        expect(repo.listPendingExcelJobs().map((job) => job.productId).sort()).toEqual(
            [first!.id, second.id].sort(),
        );
    });

    it("does not deduplicate matching product content from different description messages", () => {
        const content = descriptionEvent().content;

        const first = coordinator.handleDescription(descriptionEvent({ messageId: "m1", content, sentAt: 100 }));
        const second = coordinator.handleDescription(descriptionEvent({ messageId: "m2", content, sentAt: 200 }));

        expect(second.id).not.toBe(first.id);
        expect(repo.listProducts()).toHaveLength(2);
    });

    it("treats a replayed source message as the same event without closing the current draft", () => {
        const first = coordinator.handleDescription(descriptionEvent({ messageId: "m1", sentAt: 100 }));
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "m2", sentAt: 200 }));
        repo.markExcelJob(first.id, "running");
        repo.markExcelJob(active.id, "running");

        const replay = coordinator.handleDescription(descriptionEvent({ messageId: "m1", sentAt: 300 }));

        expect(replay).toEqual(repo.getProduct(first.id));
        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 200 });
        expect(repo.getActiveProduct()?.id).toBe(active.id);
        expect(repo.listProducts()).toHaveLength(2);
        expect(repo.listPendingExcelJobs()).toEqual([]);
    });

    it("rolls back completion and Excel enqueue when creating the replacement fails", () => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "active", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");
        const createProduct = repo.createProduct.bind(repo);
        repo.createProduct = (input) => {
            if (input.descriptionMessageId === "broken") throw new Error("injected create failure");
            return createProduct(input);
        };

        expect(() => coordinator.handleDescription(descriptionEvent({
            messageId: "broken",
            sentAt: 200,
        }))).toThrow("injected create failure");

        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(repo.getActiveProduct()?.id).toBe(active.id);
        expect(repo.listPendingExcelJobs()).toEqual([]);
    });

    it("marks unparseable posts for review without guessing fields", () => {
        const content = "máy đẹp inbox";
        const product = coordinator.handleDescription(descriptionEvent({
            messageId: "unparseable",
            content,
            sentAt: Date.parse("2026-07-25T05:48:00.000Z"),
        }));

        expect(product).toMatchObject({
            rawContent: content,
            notes: content,
            status: "needs_review",
            postedAt: Date.parse("2026-07-25T05:48:00.000Z"),
            createdAt: Date.parse("2026-07-25T05:48:00.000Z"),
            updatedAt: Date.parse("2026-07-25T05:48:00.000Z"),
        });
        expect(product.productName).toBeUndefined();
        expect(product.cpu).toBeUndefined();
        expect(product.ram).toBeUndefined();
        expect(product.storage).toBeUndefined();
        expect(product.price).toBeUndefined();
        expect(product.mediaDirectory).toBe(join(mediaRoot, "2026-07", product.id));
        expect(repo.getActiveProduct()).toBeNull();
        expect(repo.listPendingExcelJobs().map((job) => job.productId)).toContain(product.id);
    });

    it.each([
        ["group", { groupId: "group-2" }],
        ["publisher", { senderId: "member-1" }],
    ])("rejects a description from the wrong %s before mutating the active draft", (_reason, overrides) => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "active", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");

        expect(() => coordinator.handleDescription(descriptionEvent({
            messageId: "unauthorized",
            sentAt: 200,
            ...overrides,
        }))).toThrow();

        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(repo.getProductByMessageId("unauthorized")).toBeNull();
        expect(repo.listPendingExcelJobs()).toEqual([]);
    });

    it("attaches publisher images from the active group to the receiving product", () => {
        const product = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        repo.markExcelJob(product.id, "running");

        const media = coordinator.handleImage(imageEvent({ messageId: "image-1", sentAt: 150 }));

        expect(media).toMatchObject({
            productId: product.id,
            sourceMessageId: "image-1",
            sequence: 1,
            downloadStatus: "pending",
            createdAt: 150,
        });
        expect(repo.listMedia(product.id)).toEqual([media]);
        expect(repo.listPendingExcelJobs().map((job) => job.productId)).toEqual([product.id]);
    });

    it("returns orphan for an authorized image when there is no receiving product", () => {
        expect(coordinator.handleImage(imageEvent())).toBe("orphan");
    });

    it("rolls back attached media when its Excel enqueue fails", () => {
        const product = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        repo.markExcelJob(product.id, "running");
        repo.enqueueExcelSync = () => {
            throw new Error("injected enqueue failure");
        };

        expect(() => coordinator.handleImage(imageEvent())).toThrow("injected enqueue failure");

        expect(repo.listMedia(product.id)).toEqual([]);
    });

    it.each([
        ["group", { groupId: "group-2" }],
        ["publisher", { senderId: "member-1" }],
    ])("rejects an image from the wrong %s without attaching media or enqueueing Excel", (_reason, overrides) => {
        const product = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        repo.markExcelJob(product.id, "running");

        expect(() => coordinator.handleImage(imageEvent(overrides))).toThrow();

        expect(repo.listMedia(product.id)).toEqual([]);
        expect(repo.listPendingExcelJobs()).toEqual([]);
    });

    it("completes the active draft manually and enqueues its updated state", () => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");

        expect(coordinator.completeActive(500)).toMatchObject({
            id: active.id,
            status: "completed",
            updatedAt: 500,
        });
        expect(repo.getActiveProduct()).toBeNull();
        expect(repo.listPendingExcelJobs().map((job) => job.productId)).toEqual([active.id]);
        expect(coordinator.completeActive(600)).toBeNull();
    });

    it("rolls back manual completion when its Excel enqueue fails", () => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");
        repo.enqueueExcelSync = () => {
            throw new Error("injected enqueue failure");
        };

        expect(() => coordinator.completeActive(500)).toThrow("injected enqueue failure");

        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(repo.getActiveProduct()?.id).toBe(active.id);
    });
});

const imageEvent = (overrides: Partial<NormalizedImageEvent> = {}): NormalizedImageEvent => ({
    groupId: "group-1",
    senderId: "admin-1",
    messageId: "image-1",
    imageUrl: "https://example.test/image.jpg",
    sentAt: 150,
    ...overrides,
});
