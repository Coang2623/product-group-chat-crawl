import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import {
    isHeart,
    ReactionAggregator,
} from "../src/server/reactions/reaction-aggregator.js";
import type { NormalizedReactionEvent, ProductRecord } from "../src/shared/domain.js";
import { createTestDatabase, fixtureProduct } from "./helpers.js";

describe("ReactionAggregator", () => {
    let database: Database.Database;
    let repository: SqliteProductRepository;
    let product: ProductRecord;
    let onIgnored: ReturnType<typeof vi.fn>;
    let aggregator: ReactionAggregator;

    beforeEach(() => {
        database = createTestDatabase();
        repository = new SqliteProductRepository(database);
        product = repository.createProduct(fixtureProduct());
        repository.addMedia({
            id: "media-1",
            productId: product.id,
            sourceMessageId: "image-1",
            sequence: 1,
            downloadStatus: "pending",
            createdAt: 1,
        });
        repository.addMedia({
            id: "media-2",
            productId: product.id,
            sourceMessageId: "image-2",
            sequence: 2,
            downloadStatus: "pending",
            createdAt: 2,
        });
        onIgnored = vi.fn();
        aggregator = new ReactionAggregator(repository, {
            activeGroupId: "group-1",
            onIgnored,
        });
    });

    afterEach(() => database.close());

    const reaction = (
        overrides: Partial<NormalizedReactionEvent> = {},
    ): NormalizedReactionEvent => ({
        groupId: "group-1",
        targetMessageIds: ["message-1"],
        userId: "user-1",
        icon: "/-heart",
        active: true,
        occurredAt: 100,
        ...overrides,
    });

    it("recognizes both canonical icon and numeric Zalo heart type", () => {
        expect(isHeart("/-heart")).toBe(true);
        expect(isHeart("/-like", 5)).toBe(true);
        expect(isHeart("/-like", 3)).toBe(false);
    });

    it("counts one person once across description and multiple product images", () => {
        aggregator.apply(reaction({ targetMessageIds: ["message-1"] }));
        aggregator.apply(reaction({ targetMessageIds: ["image-1"], occurredAt: 101 }));
        const updated = aggregator.apply(reaction({ targetMessageIds: ["image-2"], occurredAt: 102 }));

        expect(updated).toMatchObject([{ id: product.id, heartCount: 1 }]);
        expect(repository.getProduct(product.id)?.heartCount).toBe(1);
    });

    it("counts different users and canonicalizes rType 5 as a heart", () => {
        aggregator.apply(reaction({ userId: "user-1" }));
        aggregator.apply(reaction({
            userId: "user-2",
            icon: "/-like",
            rType: 5,
            targetMessageIds: ["image-1"],
        }));

        expect(repository.getProduct(product.id)?.heartCount).toBe(2);
    });

    it("decrements when a heart is removed or replaced", () => {
        aggregator.apply(reaction({ userId: "user-1" }));
        aggregator.apply(reaction({
            userId: "user-1",
            icon: ":>",
            active: true,
            occurredAt: 101,
        }));
        expect(repository.getProduct(product.id)?.heartCount).toBe(0);

        aggregator.apply(reaction({ userId: "user-2", occurredAt: 102 }));
        aggregator.apply(reaction({ userId: "user-2", active: false, occurredAt: 103 }));
        expect(repository.getProduct(product.id)?.heartCount).toBe(0);
    });

    it("does not let old or duplicate replay events corrupt newer state", () => {
        aggregator.apply(reaction({ occurredAt: 200 }));
        aggregator.apply(reaction({ icon: "/-like", occurredAt: 100 }));
        aggregator.apply(reaction({ occurredAt: 200 }));

        expect(repository.getProduct(product.id)?.heartCount).toBe(1);
    });

    it("coalesces targets by product and queues one latest Excel update", () => {
        const updated = aggregator.apply(reaction({
            targetMessageIds: ["message-1", "image-1", "image-2", "image-1"],
        }));

        expect(updated).toHaveLength(1);
        expect(repository.listPendingExcelJobs()).toHaveLength(1);
    });

    it("ignores another group and unmapped messages with a diagnostic", () => {
        expect(aggregator.apply(reaction({ groupId: "group-2" }))).toEqual([]);
        expect(aggregator.apply(reaction({ targetMessageIds: ["unknown"] }))).toEqual([]);
        expect(onIgnored).toHaveBeenCalledTimes(2);
        expect(repository.getProduct(product.id)?.heartCount).toBe(0);
    });
});
