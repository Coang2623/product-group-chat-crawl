import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import type { AppConfig } from "../config.js";
import type { ProductRepository } from "../db/product-repository.js";
import type { ProductRecord } from "../../shared/domain.js";

export interface ExcelFileSystem {
    copyFile(source: string, destination: string): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
    access(path: string): Promise<void>;
}

export type ExcelSyncWorkerOptions = {
    fileSystem?: ExcelFileSystem;
    temporaryId?: () => string;
};

const nodeFileSystem: ExcelFileSystem = { access, copyFile, rename };

const HEADERS = [
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
    "Trạng thái bán",
    "Trạng thái",
    "Nội dung gốc",
    "Message ID",
] as const;

const monthFormatter = new Intl.DateTimeFormat("en-CA-u-nu-latn", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

const sheetMonth = (timestamp: number): string => {
    const parts = monthFormatter.formatToParts(timestamp);
    return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
};

const productStatus = (status: ProductRecord["status"]): string => ({
    receiving_images: "Đang nhận ảnh",
    completed: "Hoàn tất",
    needs_review: "Cần kiểm tra",
})[status];

const saleStatus = (status: ProductRecord["saleStatus"]): string => ({
    available: "Còn hàng",
    reserved: "Có cọc",
    partially_sold: "Đã bán một phần",
    sold: "Đã bán",
})[status];

export class ExcelSyncWorker {
    private readonly fileSystem: ExcelFileSystem;
    private readonly temporaryId: () => string;

    public constructor(
        private readonly repository: ProductRepository,
        private readonly config: AppConfig,
        options: ExcelSyncWorkerOptions = {},
    ) {
        this.fileSystem = options.fileSystem ?? nodeFileSystem;
        this.temporaryId = options.temporaryId ?? randomUUID;
    }

    async syncPending(): Promise<{ synced: number; blocked: number; failed: number }> {
        const result = { synced: 0, blocked: 0, failed: 0 };
        const jobs = this.repository.listPendingExcelJobs();
        for (const job of jobs) {
            await this.syncProduct(job.productId);
            const status = this.repository.getProduct(job.productId)?.excelSyncStatus;
            if (status === "synced") result.synced += 1;
            else if (status === "blocked") result.blocked += 1;
            else if (status === "failed") result.failed += 1;
        }
        return result;
    }

    async syncProduct(productId: string): Promise<void> {
        const product = this.repository.getProduct(productId);
        if (!product) return;
        this.repository.markExcelJob(productId, "running");

        const temporaryPath = `${this.config.workbookPath}.${this.temporaryId()}.tmp.xlsx`;
        try {
            await mkdir(dirname(this.config.workbookPath), { recursive: true });
            const workbook = await this.buildWorkbook();
            await workbook.xlsx.writeFile(temporaryPath);
            if (await this.exists(this.config.workbookPath)) {
                await this.fileSystem.copyFile(
                    this.config.workbookPath,
                    `${this.config.workbookPath}.bak`,
                );
            }
            await this.fileSystem.rename(temporaryPath, this.config.workbookPath);
            this.repository.completeExcelJob(productId);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            if (isWorkbookLock(error)) {
                this.repository.markExcelJob(productId, "blocked", errorMessage(error));
            } else {
                this.repository.markExcelJob(productId, "failed", errorMessage(error));
            }
        }
    }

    private async buildWorkbook(): Promise<ExcelJS.Workbook> {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Zalo Product Monitor";
        workbook.created = new Date();
        const rowsByMonth = new Map<string, ProductRecord[]>();
        for (const product of this.repository.listProducts()) {
            const month = sheetMonth(product.postedAt);
            const products = rowsByMonth.get(month) ?? [];
            products.push(product);
            rowsByMonth.set(month, products);
        }

        for (const month of [...rowsByMonth.keys()].sort()) {
            const sheet = workbook.addWorksheet(month);
            sheet.addRow([...HEADERS]);
            this.styleSheet(sheet);
            const products = rowsByMonth.get(month)!
                .sort((left, right) => left.postedAt - right.postedAt || left.id.localeCompare(right.id));
            for (const [index, product] of products.entries()) {
                const row = sheet.addRow([
                    index + 1,
                    dateFormatter.format(product.postedAt),
                    timeFormatter.format(product.postedAt),
                    "",
                    product.productName ?? "",
                    product.brand ?? "",
                    product.model ?? "",
                    product.cpu ?? "",
                    product.ram ?? "",
                    product.storage ?? "",
                    product.gpu ?? "",
                    product.display ?? "",
                    product.condition ?? "",
                    product.price ?? "",
                    product.rawPrice ?? "",
                    product.notes ?? "",
                    product.imageCount,
                    {
                        text: "Mở thư mục ảnh",
                        hyperlink: pathToFileURL(product.mediaDirectory).href,
                    },
                    product.heartCount,
                    saleStatus(product.saleStatus),
                    productStatus(product.status),
                    product.rawContent,
                    product.descriptionMessageId,
                ]);
                row.height = 72;
                row.getCell(14).numFmt = "#,##0";
                await this.addCover(workbook, sheet, product, row.number);
            }
        }
        return workbook;
    }

    private styleSheet(sheet: ExcelJS.Worksheet): void {
        const header = sheet.getRow(1);
        header.font = { bold: true, color: { argb: "FFFFFFFF" } };
        header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
        header.alignment = { vertical: "middle", horizontal: "center" };
        header.height = 24;
        sheet.views = [{ state: "frozen", ySplit: 1 }];
        sheet.autoFilter = { from: "A1", to: "W1" };
        sheet.columns.forEach((column, index) => {
            column.width = index === 3 ? 16 : index === 21 ? 45 : index === 17 ? 22 : 18;
        });
    }

    private async addCover(
        workbook: ExcelJS.Workbook,
        sheet: ExcelJS.Worksheet,
        product: ProductRecord,
        rowNumber: number,
    ): Promise<void> {
        if (!product.coverImagePath || !(await this.exists(product.coverImagePath))) return;
        const extension = extname(product.coverImagePath).toLowerCase();
        if (extension !== ".png" && extension !== ".jpg" && extension !== ".jpeg") return;
        const imageId = workbook.addImage({
            filename: product.coverImagePath,
            extension: extension === ".png" ? "png" : "jpeg",
        });
        sheet.addImage(imageId, {
            tl: { col: 3.1, row: rowNumber - 0.9 },
            ext: { width: 88, height: 88 },
            editAs: "oneCell",
        });
    }

    private async exists(path: string): Promise<boolean> {
        try {
            await this.fileSystem.access(path);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }
}

const isWorkbookLock = (error: unknown): boolean =>
    ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
