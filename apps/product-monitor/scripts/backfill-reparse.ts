/**
 * Re-parses stored raw_content with the current parser and reports or applies the diff.
 *
 * The parser fixes (CPU without a generation suffix, trailing title separators, chip
 * casing, bare million prices) only affect rows written after the fix, so existing rows
 * keep their old values until this backfill runs.
 *
 * Usage:
 *   npx tsx scripts/backfill-reparse.ts <database-path>          # dry run, writes nothing
 *   npx tsx scripts/backfill-reparse.ts <database-path> --apply  # writes the changes
 */
import Database from "better-sqlite3";
import { parseLaptopPost } from "../src/server/parser/laptop-parser.js";

type Row = {
    id: string;
    raw_content: string;
    product_name: string | null;
    cpu: string | null;
    ram: string | null;
    storage: string | null;
    gpu: string | null;
    display: string | null;
    price: number | null;
    raw_price: string | null;
    status: string;
};

const FIELDS = ["product_name", "cpu", "ram", "storage", "gpu", "display", "price", "raw_price"] as const;

const databasePath = process.argv[2];
const apply = process.argv.includes("--apply");
if (!databasePath) {
    console.error("Usage: backfill-reparse.ts <database-path> [--apply]");
    process.exit(1);
}

const database = new Database(databasePath, { readonly: !apply });
const rows = database.prepare("SELECT * FROM products").all() as Row[];

const changes: Array<{ id: string; field: string; before: unknown; after: unknown }> = [];
const updates: Array<Record<string, unknown>> = [];
let nowParseable = 0;
let stillUnparseable = 0;

for (const row of rows) {
    const parsed = parseLaptopPost(row.raw_content);
    if (!parsed.ok) {
        stillUnparseable += 1;
        continue;
    }
    if (row.status === "needs_review") nowParseable += 1;

    const next: Record<string, unknown> = {
        product_name: parsed.fields.productName,
        cpu: parsed.fields.cpu,
        ram: parsed.fields.ram,
        storage: parsed.fields.storage,
        gpu: parsed.fields.gpu ?? null,
        display: parsed.fields.display ?? null,
        price: parsed.fields.price,
        raw_price: parsed.fields.rawPrice,
    };

    let rowChanged = false;
    for (const field of FIELDS) {
        const before = row[field] ?? null;
        const after = next[field] ?? null;
        if (before === after) continue;
        // Never blank a field the current parser cannot recover.
        if (after === null && before !== null) continue;
        changes.push({ id: row.id, field, before, after });
        rowChanged = true;
    }
    if (rowChanged) {
        updates.push({
            ...next,
            gpu: next.gpu ?? row.gpu ?? null,
            display: next.display ?? row.display ?? null,
            status: row.status === "needs_review" ? "completed" : row.status,
            id: row.id,
        });
    }
}

const byField = new Map<string, number>();
for (const change of changes) byField.set(change.field, (byField.get(change.field) ?? 0) + 1);

console.log(`Sản phẩm:            ${rows.length}`);
console.log(`Dòng sẽ thay đổi:    ${updates.length}`);
console.log(`needs_review -> OK:  ${nowParseable}`);
console.log(`Vẫn không parse nổi: ${stillUnparseable}`);
console.log("\nThay đổi theo trường:");
for (const [field, count] of [...byField].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field.padEnd(14)} ${count}`);
}

console.log("\nVí dụ (tối đa 15):");
for (const change of changes.slice(0, 15)) {
    console.log(`  ${change.field.padEnd(13)} ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
}

if (!apply) {
    console.log("\n[DRY RUN] Chưa ghi gì. Thêm --apply để thực sự cập nhật.");
    database.close();
    process.exit(0);
}

const update = database.prepare(`
    UPDATE products SET
        product_name = @product_name, cpu = @cpu, ram = @ram, storage = @storage,
        gpu = @gpu, display = @display, price = @price, raw_price = @raw_price,
        status = @status
    WHERE id = @id
`);
const enqueue = database.prepare(`
    INSERT INTO excel_sync_jobs (product_id, operation, status, attempts, updated_at)
    VALUES (@id, 'upsert', 'pending', 0, @now)
    ON CONFLICT(product_id) DO UPDATE SET status = 'pending', updated_at = @now
`);

const now = Number(process.env.BACKFILL_NOW ?? Date.now());
database.transaction(() => {
    for (const row of updates) {
        update.run(row);
        enqueue.run({ id: row.id, now });
    }
})();

console.log(`\n[APPLIED] Đã cập nhật ${updates.length} dòng và xếp hàng đồng bộ Excel.`);
database.close();
