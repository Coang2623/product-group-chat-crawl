/**
 * Attaches photos that were recorded as orphans before a description could claim them.
 * Applies the same backwards-looking window the coordinator now uses, so it only fixes
 * rows the live rule would have handled had it existed when they arrived.
 *
 * Dry run by default; pass --apply to write. Point at a database with --db.
 */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "../src/server/db/migrate.js";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import { DEFAULT_ORPHAN_ADOPTION_WINDOW_MS } from "../src/server/products/product-coordinator.js";

const apply = process.argv.includes("--apply");
const databaseArgument = process.argv.find((value) => value.startsWith("--db="));
const databasePath = databaseArgument?.slice("--db=".length) ?? "data/products.sqlite";

const database = new Database(databasePath);
if (apply) migrate(database);
const repository = new SqliteProductRepository(database);

const orphans = repository.listOrphanMedia();
if (!orphans.length) {
    console.log("Không có ảnh mồ côi nào.");
    process.exit(0);
}

type Claim = { productId: string; productName: string; postedAt: number; orphans: typeof orphans };
const claims = new Map<string, Claim>();
const unclaimed: typeof orphans = [];

for (const orphan of orphans) {
    // The first description from the same publisher within the window after the photo.
    const owner = database.prepare(`
        SELECT id, product_name, posted_at FROM products
        WHERE group_id = ? AND sender_id = ? AND posted_at >= ? AND posted_at <= ?
        ORDER BY posted_at
        LIMIT 1
    `).get(
        orphan.groupId,
        orphan.senderId,
        orphan.sentAt,
        orphan.sentAt + DEFAULT_ORPHAN_ADOPTION_WINDOW_MS,
    ) as { id: string; product_name: string | null; posted_at: number } | undefined;

    if (!owner) {
        unclaimed.push(orphan);
        continue;
    }
    const claim = claims.get(owner.id) ?? {
        productId: owner.id,
        productName: owner.product_name ?? "(chưa đặt tên)",
        postedAt: owner.posted_at,
        orphans: [],
    };
    claim.orphans.push(orphan);
    claims.set(owner.id, claim);
}

for (const claim of claims.values()) {
    const gap = Math.round((claim.postedAt - claim.orphans[0].sentAt) / 1000);
    console.log(`${claim.orphans.length} ảnh -> ${claim.productName} (ảnh đến trước mô tả ${gap}s)`);
}
if (unclaimed.length) {
    console.log(`\n${unclaimed.length} ảnh không tìm được máy trong ${
        DEFAULT_ORPHAN_ADOPTION_WINDOW_MS / 1000}s, giữ nguyên.`);
}
if (!claims.size) process.exit(0);

if (!apply) {
    console.log("\nChạy lại với --apply để ghi thay đổi.");
    process.exit(0);
}

for (const claim of claims.values()) {
    repository.runInTransaction(() => {
        let sequence = repository.listMedia(claim.productId).length;
        for (const orphan of claim.orphans) {
            sequence += 1;
            repository.addMedia({
                id: `media-${createHash("sha256").update(orphan.messageId).digest("hex")}`,
                productId: claim.productId,
                sourceMessageId: orphan.messageId,
                sourceUrl: orphan.sourceUrl,
                sequence,
                downloadStatus: "pending",
                createdAt: orphan.sentAt,
            });
            repository.linkMessage(claim.productId, [orphan.messageId], "image", orphan.sentAt);
            repository.deleteOrphanMedia(orphan.messageId);
        }
        repository.enqueueExcelSync(claim.productId);
    });
}

console.log("\nĐã gán ảnh. Khởi động lại server để tải ảnh về.");
database.close();
