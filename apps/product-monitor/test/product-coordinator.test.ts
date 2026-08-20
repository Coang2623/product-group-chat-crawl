import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { ProductCoordinator } from "../src/server/products/product-coordinator.js";
import type { NormalizedImageEvent } from "../src/shared/domain.js";
import { createTestDatabase, descriptionEvent, fixtureProduct } from "./helpers.js";

describe("ProductCoordinator", () => {
    const databases: Database.Database[] = [];
    const temporaryDirectories: string[] = [];
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

    afterEach(() => {
        databases.splice(0).forEach((database) => database.close());
        temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
    });

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

    it("keeps matching content posted in the same session as two separate machines", () => {
        // Two units of the same model listed back to back, not a re-listing.
        const content = descriptionEvent().content;

        const first = coordinator.handleDescription(descriptionEvent({ messageId: "m1", content, sentAt: 100 }));
        const second = coordinator.handleDescription(descriptionEvent({ messageId: "m2", content, sentAt: 200 }));

        expect(second.id).not.toBe(first.id);
        expect(repo.listProducts()).toHaveLength(2);
    });

    it("marks deposit and sold replies as closed through client message aliases", () => {
        const target = coordinator.handleDescription(descriptionEvent({
            messageId: "product-global",
            targetMessageIds: ["product-global", "product-client"],
            sentAt: 100,
        }));
        // Simulate the row produced by the older adapter before quoted texts were separated.
        coordinator.handleDescription(descriptionEvent({
            messageId: "deposit-global",
            content: "C\u00f3 c\u1ecdc",
            sentAt: 200,
        }));

        const closedByDeposit = coordinator.handleSaleStatus({
            groupId: "group-1",
            senderId: "admin-1",
            messageId: "deposit-global",
            messageAliases: ["deposit-global", "deposit-client"],
            targetMessageIds: ["product-client"],
            content: "C\u00f3 c\u1ecdc",
            sentAt: 200,
        });
        expect(closedByDeposit).toMatchObject({ id: target.id, saleStatus: "closed", saleStatusText: "C\u00f3 c\u1ecdc" });
        expect(repo.getProductByMessageId("deposit-global")).toBeNull();

        const sold = coordinator.handleSaleStatus({
            groupId: "group-1",
            senderId: "admin-1",
            messageId: "sold-global",
            targetMessageIds: ["deposit-client"],
            content: "\u0110\u00e3 b\u00e1n",
            sentAt: 300,
        });
        expect(sold).toMatchObject({ id: target.id, saleStatus: "closed", saleStatusText: "\u0110\u00e3 b\u00e1n" });
        expect(repo.listProducts()).toHaveLength(1);
    });

    it("marks any reply containing a sales keyword as closed", () => {
        const target = coordinator.handleDescription(descriptionEvent({ messageId: "product", sentAt: 100 }));
        const updated = coordinator.handleSaleStatus({
            groupId: "group-1",
            senderId: "admin-1",
            messageId: "partial-status",
            targetMessageIds: ["product"],
            content: "Ch\u1ed1t kh\u00e1ch n\u00e0y",
            sentAt: 200,
        });
        expect(updated).toMatchObject({ id: target.id, saleStatus: "closed" });
    });

    it("materializes a quoted product outside the retained history window", () => {
        const updated = coordinator.handleSaleStatus({
            groupId: "group-1",
            groupName: "Laptop group",
            senderId: "admin-1",
            targetSenderName: "Admin",
            messageId: "status-message",
            targetMessageIds: ["old-client-message"],
            targetContent: descriptionEvent().content,
            targetSentAt: 100,
            content: "\u0110\u00e3 b\u00e1n",
            sentAt: 200,
        });

        expect(updated).toMatchObject({
            descriptionMessageId: "old-client-message",
            saleStatus: "closed",
            status: "completed",
        });
        expect(repo.getActiveProduct()).toBeNull();
        expect(repo.listProducts()).toHaveLength(1);
    });

    it("does not confuse the Vietnamese word bạn with bán", () => {
        const target = coordinator.handleDescription(descriptionEvent({ messageId: "product", sentAt: 100 }));
        const result = coordinator.handleSaleStatus({
            groupId: "group-1",
            senderId: "admin-1",
            messageId: "ordinary-reply",
            targetMessageIds: ["product"],
            content: "C\u1ea3m \u01a1n b\u1ea1n",
            sentAt: 200,
        });

        expect(result).toBe("ignored");
        expect(repo.getProduct(target.id)?.saleStatus).toBe("available");
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

    it("returns the winning replay after a unique conflict and rolls back the losing lifecycle", () => {
        const directory = mkdtempSync(join(tmpdir(), "product-coordinator-race-"));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "products.sqlite");
        const loserDatabase = new Database(databasePath);
        const winnerDatabase = new Database(databasePath);
        databases.push(loserDatabase, winnerDatabase);
        const loserRepo = new SqliteProductRepository(loserDatabase);
        const winnerRepo = new SqliteProductRepository(winnerDatabase);
        const raceCoordinator = new ProductCoordinator(loserRepo, {
            activeGroupId: "group-1",
            publisherId: "admin-1",
            mediaRoot,
        });
        const active = raceCoordinator.handleDescription(descriptionEvent({ messageId: "active", sentAt: 100 }));
        loserRepo.markExcelJob(active.id, "running");
        const rawMessageId = "../same-message";
        const winnerId = `product-${createHash("sha256").update(rawMessageId, "utf8").digest("hex")}`;
        const winner = fixtureProduct({
            id: winnerId,
            descriptionMessageId: rawMessageId,
            rawContent: "máy đẹp inbox",
            notes: "máy đẹp inbox",
            productName: undefined,
            status: "needs_review",
            mediaDirectory: resolve(mediaRoot, "2026-07", winnerId),
            createdAt: 150,
            updatedAt: 150,
        });
        const runInTransaction = loserRepo.runInTransaction.bind(loserRepo);
        let injectWinner = true;
        loserRepo.runInTransaction = (operation) => {
            if (injectWinner) {
                injectWinner = false;
                winnerRepo.createProduct(winner);
            }
            return runInTransaction(operation);
        };

        const replay = raceCoordinator.handleDescription(descriptionEvent({
            messageId: rawMessageId,
            content: "máy đẹp inbox",
            sentAt: 200,
        }));

        expect(replay).toEqual(winnerRepo.getProduct(winner.id));
        expect(loserRepo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(loserRepo.getActiveProduct()?.id).toBe(active.id);
        expect(loserRepo.listProducts()).toHaveLength(2);
        expect(loserRepo.listPendingExcelJobs()).toEqual([]);
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

    it("does not swallow a different SQLite unique constraint", () => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "active", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");
        const error = Object.assign(new Error("UNIQUE constraint failed: products.id"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
        });
        repo.createProduct = () => {
            throw error;
        };

        expect(() => coordinator.handleDescription(descriptionEvent({
            messageId: "different-constraint",
            sentAt: 200,
        }))).toThrow(error);

        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(repo.listPendingExcelJobs()).toEqual([]);
    });

    it("rolls back the full description lifecycle when enqueueing the new product fails", () => {
        const active = coordinator.handleDescription(descriptionEvent({ messageId: "active", sentAt: 100 }));
        repo.markExcelJob(active.id, "running");
        const enqueueExcelSync = repo.enqueueExcelSync.bind(repo);
        repo.enqueueExcelSync = (productId) => {
            if (productId !== active.id) throw new Error("injected enqueue failure");
            enqueueExcelSync(productId);
        };

        expect(() => coordinator.handleDescription(descriptionEvent({
            messageId: "replacement",
            sentAt: 200,
        }))).toThrow("injected enqueue failure");

        expect(repo.getProduct(active.id)).toMatchObject({ status: "receiving_images", updatedAt: 100 });
        expect(repo.getProductByMessageId("replacement")).toBeNull();
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
        expect(product.mediaDirectory).toBe(resolve(mediaRoot, "2026-07", product.id));
        expect(repo.getActiveProduct()).toBeNull();
        expect(repo.listPendingExcelJobs().map((job) => job.productId)).toContain(product.id);
    });

    it("derives fixed filesystem-safe product IDs and contained media paths from adversarial message IDs", () => {
        const messageIds = [
            "../escape",
            "..\\escape",
            ": * ?",
            `${"Sản-phẩm-非常に長い-".repeat(40)}🌏`,
        ];
        const monthRoot = resolve(mediaRoot, "2026-07");

        messageIds.forEach((messageId, index) => {
            const product = coordinator.handleDescription(descriptionEvent({
                messageId,
                // Distinct text per iteration: identical text days apart is a repost.
                content: `DELL LATITUDE 74${index}0 :\nCPU CORE I5 8350U - RAM 8GB - Ổ SSD 256GB\nGIÁ 5 TRIỆU`,
                sentAt: Date.parse(`2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
            }));
            const relativePath = relative(monthRoot, product.mediaDirectory);

            expect(product.id).toMatch(/^product-[a-f0-9]{64}$/);
            expect(product.descriptionMessageId).toBe(messageId);
            expect(product.id).not.toContain(messageId);
            expect(isAbsolute(product.mediaDirectory)).toBe(true);
            expect(basename(product.mediaDirectory)).toBe(product.id);
            expect(relativePath).toBe(product.id);
            expect(relativePath).not.toBe("..");
            expect(relativePath.startsWith(`..${sep}`)).toBe(false);
        });
    });

    it("uses the Asia/Bangkok calendar month for media paths at a UTC month boundary", () => {
        const product = coordinator.handleDescription(descriptionEvent({
            messageId: "bangkok-boundary",
            sentAt: Date.parse("2026-07-31T18:00:00.000Z"),
        }));

        expect(product.mediaDirectory).toBe(resolve(mediaRoot, "2026-08", product.id));
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

    it("derives fixed filesystem-safe media IDs while retaining raw source message IDs", () => {
        const product = coordinator.handleDescription(descriptionEvent({ messageId: "description", sentAt: 100 }));
        const messageIds = [
            "../escape.jpg",
            "..\\escape.jpg",
            ": * ?.jpg",
            `${"Ảnh-非常に長い-".repeat(40)}🌏`,
        ];

        messageIds.forEach((messageId, index) => {
            const media = coordinator.handleImage(imageEvent({ messageId, sentAt: 200 + index }));
            if (media === "orphan") throw new Error("Expected media to attach");

            expect(media.id).toMatch(/^media-[a-f0-9]{64}$/);
            expect(media.id).not.toContain(messageId);
            expect(media.sourceMessageId).toBe(messageId);
        });
        expect(repo.listMedia(product.id)).toHaveLength(messageIds.length);
    });

    describe("reposted machines", () => {
        const DAY = 24 * 60 * 60 * 1000;

        it("updates the original row instead of adding a second one", () => {
            const first = coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));

            const second = coordinator.handleDescription(descriptionEvent({ messageId: "d2", sentAt: 1_000 + DAY }));

            expect(second.id).toBe(first.id);
            expect(repo.listProducts()).toHaveLength(1);
            expect(second.repostCount).toBe(1);
            expect(second.lastPostedAt).toBe(1_000 + DAY);
        });

        it("keeps the first posting date so the listing history is not lost", () => {
            const first = coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));
            const second = coordinator.handleDescription(descriptionEvent({ messageId: "d2", sentAt: 1_000 + DAY }));

            expect(second.postedAt).toBe(first.postedAt);
        });

        it("returns a resold machine to available", () => {
            const first = coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));
            repo.applySaleStatus({
                productId: first.id,
                messageId: "sold-1",
                targetMessageId: "d1",
                status: "closed",
                rawContent: "đã cọc",
                occurredAt: 2_000,
            });

            const reposted = coordinator.handleDescription(descriptionEvent({ messageId: "d2", sentAt: 1_000 + DAY }));

            expect(reposted.saleStatus).toBe("available");
        });

        it("counts a different machine as its own product", () => {
            coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));

            coordinator.handleDescription(descriptionEvent({
                messageId: "d2",
                sentAt: 1_000 + DAY,
                content: "DELL LATITUDE 7490 :\nCPU CORE I5 8350U - RAM 8GB - Ổ SSD 256GB\nGIÁ 5 TRIỆU",
            }));

            expect(repo.listProducts()).toHaveLength(2);
        });

        it("attaches images from the repost to the same machine", () => {
            const first = coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));
            coordinator.completeActive(2_000);
            coordinator.handleDescription(descriptionEvent({ messageId: "d2", sentAt: 1_000 + DAY }));

            const media = coordinator.handleImage(imageEvent({ messageId: "img", sentAt: 1_000 + DAY + 500 }));

            if (media === "orphan") throw new Error("Expected media to attach");
            expect(media.productId).toBe(first.id);
        });
    });

    describe("idle draft timeout", () => {
        const timeout = 15 * 60 * 1000;

        it("closes a draft left open after the last posting session", () => {
            const product = coordinator.handleDescription(descriptionEvent({ sentAt: 1_000 }));

            const completed = coordinator.completeIdleDraft(1_000 + timeout);

            expect(completed?.id).toBe(product.id);
            expect(repo.getProduct(product.id)?.status).toBe("completed");
            expect(repo.getActiveProduct()).toBeNull();
        });

        it("keeps a draft open while it is still within the window", () => {
            coordinator.handleDescription(descriptionEvent({ sentAt: 1_000 }));

            expect(coordinator.completeIdleDraft(1_000 + timeout - 1)).toBeNull();
            expect(repo.getActiveProduct()).not.toBeNull();
        });

        it("measures idleness from the newest image, not the description", () => {
            // A publisher still sending photos must not have the draft closed underneath them.
            coordinator.handleDescription(descriptionEvent({ sentAt: 1_000 }));
            coordinator.handleImage(imageEvent({ messageId: "late", sentAt: 1_000 + timeout }));

            expect(coordinator.completeIdleDraft(1_000 + timeout + 1)).toBeNull();
            expect(coordinator.completeIdleDraft(1_000 + 2 * timeout)).not.toBeNull();
        });

        it("does nothing when no draft is open", () => {
            expect(coordinator.completeIdleDraft(Date.now())).toBeNull();
        });

        it("queues the closed product for Excel", () => {
            const product = coordinator.handleDescription(descriptionEvent({ sentAt: 1_000 }));
            repo.markExcelJob(product.id, "running");

            coordinator.completeIdleDraft(1_000 + timeout);

            expect(repo.listPendingExcelJobs().map((job) => job.productId)).toContain(product.id);
        });
    });

    it("returns orphan for an authorized image when there is no product at all", () => {
        expect(coordinator.handleImage(imageEvent())).toBe("orphan");
    });

    it("records an orphan image so it can be reconciled instead of being dropped", () => {
        expect(coordinator.handleImage(imageEvent({ messageId: "stray", sentAt: 150 }))).toBe("orphan");

        expect(repo.listOrphanMedia()).toEqual([{
            messageId: "stray",
            groupId: "group-1",
            senderId: "admin-1",
            sourceUrl: "https://example.test/image.jpg",
            sentAt: 150,
            createdAt: 150,
        }]);
    });

    it("attaches images to a needs_review description rather than discarding them", () => {
        const product = coordinator.handleDescription(
            descriptionEvent({ content: "máy đẹp inbox", sentAt: 100 }),
        );

        const media = coordinator.handleImage(imageEvent({ sentAt: 150 }));

        if (media === "orphan") throw new Error("Expected media to attach");
        expect(media.productId).toBe(product.id);
    });

    it("attaches images to the most recent description after its draft was completed", () => {
        const product = coordinator.handleDescription(descriptionEvent({ sentAt: 100 }));
        coordinator.completeActive(120);

        const media = coordinator.handleImage(imageEvent({ sentAt: 150 }));

        if (media === "orphan") throw new Error("Expected media to attach");
        expect(media.productId).toBe(product.id);
    });

    it("attaches a burst of images to the newest description, not the first one", () => {
        // Publishers post several descriptions seconds apart, then send the photos.
        coordinator.handleDescription(descriptionEvent({ messageId: "d1", sentAt: 1_000 }));
        coordinator.handleDescription(descriptionEvent({ messageId: "d2", sentAt: 8_000 }));
        const newest = coordinator.handleDescription(descriptionEvent({ messageId: "d3", sentAt: 15_000 }));

        const media = coordinator.handleImage(imageEvent({ messageId: "img", sentAt: 20_000 }));

        if (media === "orphan") throw new Error("Expected media to attach");
        expect(media.productId).toBe(newest.id);
    });

    it("does not attach an image to a description older than the attachment window", () => {
        coordinator.handleDescription(descriptionEvent({ messageId: "old", sentAt: 1_000 }));
        coordinator.completeActive(1_100);

        const windowMs = 15 * 60 * 1000;
        expect(coordinator.handleImage(imageEvent({ sentAt: 1_000 + windowMs + 1 }))).toBe("orphan");
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
