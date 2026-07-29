import Database from "better-sqlite3";
import type { NewProductRecord, NormalizedDescriptionEvent } from "../src/shared/domain.js";

export const createTestDatabase = () => new Database(":memory:");

export const fixtureProduct = (overrides: Partial<NewProductRecord> = {}): NewProductRecord => ({
    id: "product-1",
    groupId: "group-1",
    groupName: "Laptop giá tốt",
    descriptionMessageId: "message-1",
    senderId: "admin-1",
    postedAt: Date.parse("2026-07-25T12:48:00+07:00"),
    rawContent: "HP ZBOOK 15 G3 - CORE I7 6820HQ - RAM 16GB - Ổ SSD 512GB - GIÁ THU VỀ 5 TRIỆU 900",
    mediaDirectory: "data/media/2026-07/product-1",
    imageCount: 0,
    heartCount: 0,
    status: "receiving_images",
    excelSyncStatus: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
});

export const descriptionEvent = (overrides: Partial<NormalizedDescriptionEvent> = {}): NormalizedDescriptionEvent => ({
    groupId: "group-1",
    groupName: "Laptop giá tốt",
    senderId: "admin-1",
    messageId: "message-1",
    content: "HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - Ổ SSD 256GB - MÀN 15.6 INCH FULLHD - GIÁ 3 TRIỆU 8",
    sentAt: Date.now(),
    ...overrides,
});
