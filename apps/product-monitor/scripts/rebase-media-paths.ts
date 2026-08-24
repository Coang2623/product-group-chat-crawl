/**
 * Rewrites stored media paths onto a new data directory.
 *
 * Paths are recorded absolute, so a database captured on Windows points at
 * `D:\...\data\media\...` and is unusable anywhere else -- moving it into a
 * container leaves every product without photos. This rebases them, converting
 * separators as it goes.
 *
 * Dry run by default; pass --apply to write.
 *
 *   npx tsx apps/product-monitor/scripts/rebase-media-paths.ts \
 *     --db=products.sqlite --to=/data
 */
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const argument = (name: string): string | undefined =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const databasePath = argument("db") ?? "data/products.sqlite";
const target = argument("to");

if (!target) {
    console.error("Thiếu --to=<thư mục dữ liệu mới>, ví dụ --to=/data");
    process.exit(1);
}
// Separator follows the target: a POSIX destination must not keep backslashes.
const separator = target.includes("\\") && !target.startsWith("/") ? "\\" : "/";
const targetRoot = target.replace(/[\\/]+$/u, "");

const database = new Database(databasePath);

/**
 * Keeps everything from the `media` segment onwards, which is the part that is
 * the same in every data directory, and re-roots it on the target.
 */
const rebase = (value: string): string | null => {
    const match = /[\\/](media[\\/].*)$/u.exec(value);
    if (!match) return null;
    const tail = match[1].replace(/[\\/]/gu, separator);
    const next = `${targetRoot}${separator}${tail}`;
    return next === value ? null : next;
};

type Change = { table: string; column: string; id: string; from: string; to: string };
const changes: Change[] = [];

const collect = (table: string, column: string) => {
    const rows = database
        .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as Array<{ id: string; value: string }>;
    for (const row of rows) {
        const next = rebase(row.value);
        if (next) changes.push({ table, column, id: row.id, from: row.value, to: next });
    }
};

collect("products", "media_directory");
collect("products", "cover_image_path");
collect("product_media", "local_path");

if (!changes.length) {
    console.log("Không có đường dẫn nào cần đổi.");
    process.exit(0);
}

const summary = new Map<string, number>();
for (const change of changes) {
    const key = `${change.table}.${change.column}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
}
for (const [key, count] of summary) console.log(`${count} dòng ${key}`);
console.log("\nví dụ:");
console.log("  từ:", changes[0].from);
console.log("  sang:", changes[0].to);

if (!apply) {
    console.log("\nChạy lại với --apply để ghi thay đổi.");
    process.exit(0);
}

database.transaction(() => {
    for (const change of changes) {
        database
            .prepare(`UPDATE ${change.table} SET ${change.column} = ? WHERE id = ?`)
            .run(change.to, change.id);
    }
})();

console.log(`\nĐã đổi ${changes.length} đường dẫn.`);
database.close();
