import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteProductRepository } from "../src/server/db/product-repository.js";
import {
    ExcelSyncWorker,
    type ExcelFileSystem,
} from "../src/server/excel/excel-sync-worker.js";
import type { AppConfig } from "../src/server/config.js";
import { createTestDatabase, fixtureProduct } from "./helpers.js";

const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69PpWQAAAABJRU5ErkJggg==",
    "base64",
);

describe("ExcelSyncWorker", () => {
    let directory: string;
    let database: Database.Database;
    let repository: SqliteProductRepository;
    let config: AppConfig;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "product-excel-"));
        database = createTestDatabase();
        repository = new SqliteProductRepository(database);
        config = {
            dataDirectory: directory,
            databasePath: join(directory, "products.sqlite"),
            workbookPath: join(directory, "zalo-products.xlsx"),
            mediaRoot: join(directory, "media"),
        };
    });

    afterEach(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });

    const createProductWithCover = async () => {
        const mediaDirectory = join(directory, "media", "2026-07", "product-1");
        await mkdir(mediaDirectory, { recursive: true });
        const cover = join(mediaDirectory, "001.png");
        await writeFile(cover, PNG_BYTES);
        const product = repository.createProduct(fixtureProduct({
            productName: "HP ZBook 15 G3",
            brand: "HP",
            model: "ZBook 15 G3",
            cpu: "Core i7 6820HQ",
            ram: "16GB",
            storage: "SSD 512GB",
            price: 5_900_000,
            rawPrice: "5 TRIỆU 900",
            mediaDirectory,
        }));
        repository.addMedia({
            id: "media-1",
            productId: product.id,
            sourceMessageId: "image-1",
            sequence: 1,
            localPath: cover,
            checksum: "checksum",
            downloadStatus: "downloaded",
            createdAt: product.postedAt,
        });
        repository.updateProductMediaSummary(product.id);
        repository.enqueueExcelSync(product.id);
        return repository.getProduct(product.id)!;
    };

    const openWorkbook = async () => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await readFile(config.workbookPath));
        return workbook;
    };

    it("creates a monthly sheet and embeds only the cover", async () => {
        const product = await createProductWithCover();
        const worker = new ExcelSyncWorker(repository, config);

        await worker.syncProduct(product.id);

        const workbook = await openWorkbook();
        const sheet = workbook.getWorksheet("2026-07")!;
        expect(sheet.getRow(1).values).toEqual([
            undefined,
            "STT",
            "Ngày đăng",
            "Giờ đăng",
            "Ảnh đại diện",
            "Tên sản phẩm",
            "Thương hiệu",
            "Model",
            "CPU",
            "RAM",
            "Ổ cứng",
            "Card/GPU",
            "Màn hình",
            "Tình trạng",
            "Giá",
            "Giá gốc",
            "Ghi chú",
            "Số ảnh",
            "Thư mục ảnh",
            "Số tym",
            "Trạng thái",
            "Nội dung gốc",
            "Message ID",
        ]);
        expect(sheet.getRow(2).getCell(5).value).toBe("HP ZBook 15 G3");
        expect(sheet.getRow(2).getCell(14).value).toBe(5_900_000);
        expect(sheet.getImages()).toHaveLength(1);
        expect(repository.listPendingExcelJobs()).toHaveLength(0);
        expect(repository.getProduct(product.id)?.excelSyncStatus).toBe("synced");
    });

    it("upserts without duplicating a row or embedded cover", async () => {
        const product = await createProductWithCover();
        const worker = new ExcelSyncWorker(repository, config);
        await worker.syncProduct(product.id);
        repository.updateHeartCount(product.id, 7);
        repository.enqueueExcelSync(product.id);

        await worker.syncProduct(product.id);

        const workbook = await openWorkbook();
        const sheet = workbook.getWorksheet("2026-07")!;
        expect(sheet.rowCount).toBe(2);
        expect(sheet.getRow(2).getCell(19).value).toBe(7);
        expect(sheet.getImages()).toHaveLength(1);
    });

    it("creates a separate sheet when products cross Bangkok months", async () => {
        const first = await createProductWithCover();
        repository.completeActiveProduct(first.postedAt + 1);
        const second = repository.createProduct(fixtureProduct({
            id: "product-2",
            descriptionMessageId: "message-2",
            postedAt: Date.parse("2026-08-01T00:05:00+07:00"),
            productName: "MacBook Air M1",
            mediaDirectory: join(directory, "media", "2026-08", "product-2"),
        }));
        repository.enqueueExcelSync(second.id);

        await new ExcelSyncWorker(repository, config).syncProduct(second.id);

        const workbook = await openWorkbook();
        expect(workbook.getWorksheet("2026-07")).toBeDefined();
        expect(workbook.getWorksheet("2026-08")).toBeDefined();
    });

    it("keeps the job blocked when the workbook is locked", async () => {
        const product = await createProductWithCover();
        const fsAdapter: ExcelFileSystem = {
            access,
            copyFile,
            rename: vi.fn().mockRejectedValue(Object.assign(new Error("locked"), { code: "EBUSY" })),
        };
        const worker = new ExcelSyncWorker(repository, config, { fileSystem: fsAdapter });

        await expect(worker.syncProduct(product.id)).resolves.toBeUndefined();

        expect(repository.listPendingExcelJobs()[0]).toMatchObject({
            productId: product.id,
            status: "blocked",
            attempts: 0,
        });
        expect(repository.getProduct(product.id)?.excelSyncStatus).toBe("blocked");
    });

    it("marks non-lock write errors failed without corrupting the existing workbook", async () => {
        const product = await createProductWithCover();
        const worker = new ExcelSyncWorker(repository, config);
        await worker.syncProduct(product.id);
        const original = await readFile(config.workbookPath);
        repository.enqueueExcelSync(product.id);
        const failing = new ExcelSyncWorker(repository, config, {
            fileSystem: {
                access,
                copyFile,
                rename: vi.fn().mockRejectedValue(Object.assign(new Error("disk"), { code: "EIO" })),
            },
        });

        await failing.syncProduct(product.id);

        expect(await readFile(config.workbookPath)).toEqual(original);
        expect(repository.listPendingExcelJobs()[0]).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("reports aggregate outcomes while retrying every queued product", async () => {
        const product = await createProductWithCover();
        const worker = new ExcelSyncWorker(repository, config);

        await expect(worker.syncPending()).resolves.toEqual({
            synced: 1,
            blocked: 0,
            failed: 0,
        });
        expect(repository.getProduct(product.id)?.excelSyncStatus).toBe("synced");
    });
});
