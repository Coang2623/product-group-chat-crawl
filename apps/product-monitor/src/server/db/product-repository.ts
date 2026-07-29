import type Database from "better-sqlite3";
import { migrate } from "./migrate.js";
import type {
    ExcelSyncJob,
    HeartStateInput,
    NewProductMedia,
    NewProductRecord,
    ProductFilter,
    ProductMedia,
    ProductRecord,
} from "../../shared/domain.js";

type ProductRow = Record<string, unknown>;
type MediaRow = Record<string, unknown>;
type JobRow = Record<string, unknown>;

const optionalString = (value: unknown): string | undefined => (value === null ? undefined : String(value));
const productFromRow = (row: ProductRow): ProductRecord => ({
    id: String(row.id),
    groupId: String(row.group_id),
    groupName: String(row.group_name),
    descriptionMessageId: String(row.description_message_id),
    senderId: String(row.sender_id),
    senderName: optionalString(row.sender_name),
    postedAt: Number(row.posted_at),
    rawContent: String(row.raw_content),
    productName: optionalString(row.product_name),
    brand: optionalString(row.brand),
    model: optionalString(row.model),
    cpu: optionalString(row.cpu),
    ram: optionalString(row.ram),
    storage: optionalString(row.storage),
    gpu: optionalString(row.gpu),
    display: optionalString(row.display),
    condition: optionalString(row.condition_text),
    price: row.price === null ? undefined : Number(row.price),
    rawPrice: optionalString(row.raw_price),
    notes: optionalString(row.notes),
    imageCount: Number(row.image_count),
    coverImagePath: optionalString(row.cover_image_path),
    mediaDirectory: String(row.media_directory),
    heartCount: Number(row.heart_count),
    status: row.status as ProductRecord["status"],
    excelSyncStatus: row.excel_sync_status as ProductRecord["excelSyncStatus"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
});

const mediaFromRow = (row: MediaRow): ProductMedia => ({
    id: String(row.id),
    productId: String(row.product_id),
    sourceMessageId: String(row.source_message_id),
    sequence: Number(row.sequence),
    localPath: optionalString(row.local_path),
    checksum: optionalString(row.checksum),
    downloadStatus: row.download_status as ProductMedia["downloadStatus"],
    createdAt: Number(row.created_at),
});

const jobFromRow = (row: JobRow): ExcelSyncJob => ({
    productId: String(row.product_id),
    operation: row.operation as ExcelSyncJob["operation"],
    status: row.status as ExcelSyncJob["status"],
    attempts: Number(row.attempts),
    lastError: optionalString(row.last_error),
    updatedAt: Number(row.updated_at),
});

export interface ProductRepository {
    createProduct(input: NewProductRecord): ProductRecord;
    completeActiveProduct(completedAt: number): ProductRecord | null;
    getActiveProduct(): ProductRecord | null;
    getProduct(id: string): ProductRecord | null;
    getProductByMessageId(messageId: string): ProductRecord | null;
    listProducts(filter?: ProductFilter): ProductRecord[];
    addMedia(input: NewProductMedia): ProductMedia;
    updateMedia(id: string, patch: Partial<ProductMedia>): ProductMedia;
    listMedia(productId: string): ProductMedia[];
    updateProductMediaSummary(productId: string): ProductRecord;
    setHeartState(input: HeartStateInput): void;
    countUniqueHearts(productId: string): number;
    updateHeartCount(productId: string, heartCount: number): ProductRecord;
    enqueueExcelSync(productId: string): void;
    listPendingExcelJobs(): ExcelSyncJob[];
    markExcelJob(productId: string, status: ExcelSyncJob["status"], error?: string): void;
    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;
}

export class SqliteProductRepository implements ProductRepository {
    public readonly database: Database.Database;

    public constructor(database: Database.Database) {
        this.database = database;
        migrate(database);
    }

    createProduct(input: NewProductRecord): ProductRecord {
        this.database.prepare(`
            INSERT INTO products (
                id, group_id, group_name, description_message_id, sender_id, sender_name, posted_at, raw_content,
                product_name, brand, model, cpu, ram, storage, gpu, display, condition_text, price, raw_price, notes,
                image_count, cover_image_path, media_directory, heart_count, status, excel_sync_status, created_at, updated_at
            ) VALUES (
                @id, @groupId, @groupName, @descriptionMessageId, @senderId, @senderName, @postedAt, @rawContent,
                @productName, @brand, @model, @cpu, @ram, @storage, @gpu, @display, @condition, @price, @rawPrice, @notes,
                @imageCount, @coverImagePath, @mediaDirectory, @heartCount, @status, @excelSyncStatus, @createdAt, @updatedAt
            )
        `).run({
            ...input,
            senderName: input.senderName ?? null,
            productName: input.productName ?? null,
            brand: input.brand ?? null,
            model: input.model ?? null,
            cpu: input.cpu ?? null,
            ram: input.ram ?? null,
            storage: input.storage ?? null,
            gpu: input.gpu ?? null,
            display: input.display ?? null,
            condition: input.condition ?? null,
            price: input.price ?? null,
            rawPrice: input.rawPrice ?? null,
            notes: input.notes ?? null,
            coverImagePath: input.coverImagePath ?? null,
        });
        return this.requireProduct(input.id);
    }

    completeActiveProduct(completedAt: number): ProductRecord | null {
        return this.database.transaction(() => {
            const active = this.getActiveProduct();
            if (!active) return null;
            this.database.prepare("UPDATE products SET status = 'completed', updated_at = ? WHERE id = ?").run(completedAt, active.id);
            return this.requireProduct(active.id);
        })();
    }

    getActiveProduct(): ProductRecord | null {
        return this.productOrNull(this.database.prepare("SELECT * FROM products WHERE status = 'receiving_images'").get());
    }

    getProduct(id: string): ProductRecord | null {
        return this.productOrNull(this.database.prepare("SELECT * FROM products WHERE id = ?").get(id));
    }

    getProductByMessageId(messageId: string): ProductRecord | null {
        return this.productOrNull(this.database.prepare("SELECT * FROM products WHERE description_message_id = ?").get(messageId));
    }

    listProducts(filter: ProductFilter = {}): ProductRecord[] {
        const clauses: string[] = [];
        const params: Record<string, unknown> = {};
        if (filter.groupId !== undefined) {
            clauses.push("group_id = @groupId");
            params.groupId = filter.groupId;
        }
        if (filter.status !== undefined) {
            clauses.push("status = @status");
            params.status = filter.status;
        }
        if (filter.fromPostedAt !== undefined) {
            clauses.push("posted_at >= @fromPostedAt");
            params.fromPostedAt = filter.fromPostedAt;
        }
        if (filter.toPostedAt !== undefined) {
            clauses.push("posted_at <= @toPostedAt");
            params.toPostedAt = filter.toPostedAt;
        }
        const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
        const limit = filter.limit === undefined ? "" : " LIMIT @limit";
        if (filter.limit !== undefined) params.limit = filter.limit;
        return this.database.prepare(`SELECT * FROM products${where} ORDER BY posted_at DESC, id DESC${limit}`).all(params)
            .map((row) => productFromRow(row as ProductRow));
    }

    addMedia(input: NewProductMedia): ProductMedia {
        this.database.prepare(`
            INSERT INTO product_media (id, product_id, source_message_id, sequence, local_path, checksum, download_status, created_at)
            VALUES (@id, @productId, @sourceMessageId, @sequence, @localPath, @checksum, @downloadStatus, @createdAt)
        `).run({ ...input, localPath: input.localPath ?? null, checksum: input.checksum ?? null });
        return this.requireMedia(input.id);
    }

    updateMedia(id: string, patch: Partial<ProductMedia>): ProductMedia {
        const editable: Array<keyof ProductMedia> = ["sequence", "localPath", "checksum", "downloadStatus"];
        const columns: Record<string, string> = { sequence: "sequence", localPath: "local_path", checksum: "checksum", downloadStatus: "download_status" };
        const fields = editable.filter((key) => patch[key] !== undefined);
        if (fields.length) {
            const assignments = fields.map((key) => `${columns[key]} = @${key}`).join(", ");
            const values = Object.fromEntries(fields.map((key) => [key, patch[key]]));
            this.database.prepare(`UPDATE product_media SET ${assignments} WHERE id = @id`).run({ id, ...values });
        }
        return this.requireMedia(id);
    }

    listMedia(productId: string): ProductMedia[] {
        return this.database.prepare("SELECT * FROM product_media WHERE product_id = ? ORDER BY sequence ASC, id ASC").all(productId)
            .map((row) => mediaFromRow(row as MediaRow));
    }

    updateProductMediaSummary(productId: string): ProductRecord {
        return this.database.transaction(() => {
            const summary = this.database.prepare(`
                SELECT COUNT(*) AS image_count,
                       (SELECT local_path FROM product_media WHERE product_id = @productId AND local_path IS NOT NULL ORDER BY sequence ASC, id ASC LIMIT 1) AS cover_image_path
                FROM product_media WHERE product_id = @productId
            `).get({ productId }) as { image_count: number; cover_image_path: string | null };
            this.database.prepare("UPDATE products SET image_count = ?, cover_image_path = ?, updated_at = ? WHERE id = ?")
                .run(summary.image_count, summary.cover_image_path, Date.now(), productId);
            return this.requireProduct(productId);
        })();
    }

    setHeartState(input: HeartStateInput): void {
        this.database.prepare(`
            INSERT INTO product_reactions (product_id, target_message_id, user_id, icon, active, updated_at)
            VALUES (@productId, @targetMessageId, @userId, @icon, @active, @updatedAt)
            ON CONFLICT(product_id, target_message_id, user_id) DO UPDATE SET
                icon = excluded.icon, active = excluded.active, updated_at = excluded.updated_at
        `).run({ ...input, active: Number(input.active) });
    }

    countUniqueHearts(productId: string): number {
        const row = this.database.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM product_reactions WHERE product_id = ? AND active = 1 AND icon = '/-heart'").get(productId) as { count: number };
        return row.count;
    }

    updateHeartCount(productId: string, heartCount: number): ProductRecord {
        this.database.prepare("UPDATE products SET heart_count = ?, updated_at = ? WHERE id = ?").run(heartCount, Date.now(), productId);
        return this.requireProduct(productId);
    }

    enqueueExcelSync(productId: string): void {
        this.database.prepare(`
            INSERT INTO excel_sync_jobs (product_id, operation, status, attempts, last_error, updated_at)
            VALUES (?, 'upsert', 'pending', 0, NULL, ?)
            ON CONFLICT(product_id) DO UPDATE SET operation = 'upsert', status = 'pending', last_error = NULL, updated_at = excluded.updated_at
        `).run(productId, Date.now());
    }

    listPendingExcelJobs(): ExcelSyncJob[] {
        return this.database.prepare("SELECT * FROM excel_sync_jobs WHERE status = 'pending' ORDER BY updated_at ASC, product_id ASC").all()
            .map((row) => jobFromRow(row as JobRow));
    }

    markExcelJob(productId: string, status: ExcelSyncJob["status"], error?: string): void {
        this.database.prepare(`
            UPDATE excel_sync_jobs
            SET status = @status,
                attempts = attempts + CASE WHEN @status = 'failed' THEN 1 ELSE 0 END,
                last_error = @error,
                updated_at = @updatedAt
            WHERE product_id = @productId
        `).run({ productId, status, error: error ?? null, updatedAt: Date.now() });
    }

    getSetting(key: string): string | null {
        const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    setSetting(key: string, value: string): void {
        this.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    }

    private productOrNull(row: unknown): ProductRecord | null {
        return row ? productFromRow(row as ProductRow) : null;
    }

    private requireProduct(id: string): ProductRecord {
        const product = this.getProduct(id);
        if (!product) throw new Error(`Product not found: ${id}`);
        return product;
    }

    private requireMedia(id: string): ProductMedia {
        const row = this.database.prepare("SELECT * FROM product_media WHERE id = ?").get(id);
        if (!row) throw new Error(`Product media not found: ${id}`);
        return mediaFromRow(row as MediaRow);
    }
}
