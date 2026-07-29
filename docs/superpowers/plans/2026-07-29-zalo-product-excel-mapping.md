# Zalo Product Excel Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng ứng dụng local chỉ đọc, theo dõi một nhóm Zalo, tự động map bài đăng laptop và ảnh/tym vào database, giao diện thời gian thực và một workbook Excel chia sheet theo tháng.

**Architecture:** Giữ thư viện Zalo hiện tại nguyên vẹn và tạo ứng dụng độc lập trong `apps/product-monitor`. Backend Node/TypeScript chuẩn hóa sự kiện Zalo thành domain event, lưu SQLite làm nguồn dữ liệu chính, xử lý media/reaction/Excel bằng các worker tách biệt và phát sự kiện một chiều qua SSE. Frontend React hiển thị bảng thời gian thực cùng panel chi tiết; mọi thao tác local đi qua REST và không gọi API ghi về Zalo.

**Tech Stack:** Node.js >=18, TypeScript 5.5, React 18, Vite 5, Express 4, Server-Sent Events, better-sqlite3 11, ExcelJS 4, Vitest 2, React Testing Library, Supertest.

## Global Constraints

- Chỉ một `activeGroupId` tại mỗi thời điểm.
- Chỉ message của quản trị viên/nguồn đăng đã xác định mới mở draft hoặc ghép ảnh.
- Một mô tả luôn tạo một sản phẩm và một dòng mới; không deduplicate sản phẩm.
- Chỉ hỗ trợ laptop và parser quy tắc; không dùng AI hoặc dịch vụ suy đoán bên ngoài.
- Mô tả mới đóng draft trước; người dùng có thể đóng thủ công draft cuối.
- Database local là nguồn dữ liệu chính; workbook Excel chỉ là đầu ra đồng bộ.
- Một workbook `zalo-products.xlsx`, mỗi tháng một sheet `YYYY-MM`.
- Ảnh đầu tiên được nhúng vào Excel; toàn bộ ảnh lưu dưới `data/media/YYYY-MM/{product-id}/`.
- Tim được tính theo người dùng duy nhất trên toàn bộ message mô tả và ảnh của sản phẩm.
- Không có bất kỳ API hoặc control nào gửi/sửa/thu hồi/reaction lại tin nhắn Zalo.
- Không commit credentials, database, media, workbook hoặc nội dung `.superpowers/brainstorm/`.

---

## File Structure

```text
apps/product-monitor/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── index.html
├── src/
│   ├── shared/
│   │   ├── domain.ts
│   │   └── api.ts
│   ├── server/
│   │   ├── config.ts
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── migrate.ts
│   │   │   └── product-repository.ts
│   │   ├── parser/laptop-parser.ts
│   │   ├── products/product-coordinator.ts
│   │   ├── media/media-store.ts
│   │   ├── reactions/reaction-aggregator.ts
│   │   ├── excel/excel-sync-worker.ts
│   │   ├── zalo/zalo-adapter.ts
│   │   └── http/app.ts
│   └── client/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── styles.css
│       └── components/
│           ├── QrLogin.tsx
│           ├── GroupPicker.tsx
│           ├── ProductTable.tsx
│           ├── ProductDetailPanel.tsx
│           └── ExcelSyncBanner.tsx
└── test/
    ├── fixtures/
    │   ├── laptop-posts.ts
    │   └── zalo-events.ts
    ├── config.test.ts
    ├── helpers.ts
    ├── product-repository.test.ts
    ├── laptop-parser.test.ts
    ├── product-coordinator.test.ts
    ├── media-store.test.ts
    ├── reaction-aggregator.test.ts
    ├── excel-sync-worker.test.ts
    ├── zalo-adapter.test.ts
    ├── http-app.test.ts
    ├── product-ui.test.tsx
    └── recovery-flow.test.ts
```

---

### Task 1: Scaffold ứng dụng và khóa domain contracts

**Files:**
- Create: `apps/product-monitor/package.json`
- Create: `apps/product-monitor/tsconfig.json`
- Create: `apps/product-monitor/vite.config.ts`
- Create: `apps/product-monitor/vitest.config.ts`
- Create: `apps/product-monitor/src/shared/domain.ts`
- Create: `apps/product-monitor/src/shared/api.ts`
- Create: `apps/product-monitor/src/server/config.ts`
- Create: `apps/product-monitor/test/config.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `ProductRecord`, `ProductMedia`, `ProductReaction`, `ExcelSyncJob`, `AppConfig`, `loadConfig(env)`.
- Consumes: none.

- [ ] **Step 1: Viết test cấu hình thất bại**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
    it("uses workspace-local durable paths", () => {
        const config = loadConfig({ PRODUCT_MONITOR_DATA_DIR: "W:/tmp/zalo-products" });
        expect(config.databasePath).toMatch(/products\.sqlite$/);
        expect(config.workbookPath).toMatch(/zalo-products\.xlsx$/);
        expect(config.mediaRoot).toMatch(/media$/);
    });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- config.test.ts`

Expected: FAIL vì package và `loadConfig` chưa tồn tại.

- [ ] **Step 3: Tạo package, scripts và domain types**

`apps/product-monitor/package.json` phải có scripts:

```json
{
  "name": "zalo-product-monitor",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \"tsx watch src/server/index.ts\" \"vite\"",
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/server/index.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "exceljs": "^4.4.0",
    "express": "^4.21.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zalo-api-final": "file:../..",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "concurrently": "^9.1.0",
    "jsdom": "^25.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`domain.ts` phải định nghĩa đúng các type đã duyệt trong spec và thêm:

```ts
export type ProductStatus = "receiving_images" | "completed" | "needs_review";
export type ExcelSyncStatus = "pending" | "synced" | "blocked" | "failed";

export type NormalizedDescriptionEvent = {
    groupId: string;
    groupName: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    content: string;
    sentAt: number;
};

export type NormalizedImageEvent = {
    groupId: string;
    senderId: string;
    messageId: string;
    imageUrl: string;
    sentAt: number;
};
```

- [ ] **Step 4: Cài dependencies và chạy test**

Run:

```bash
npm install
npm --prefix apps/product-monitor install
npm --prefix apps/product-monitor test -- config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore apps/product-monitor
git commit -m "feat: scaffold product monitor app"
```

---

### Task 2: SQLite migration và repository bền vững

**Files:**
- Create: `apps/product-monitor/src/server/db/migrate.ts`
- Create: `apps/product-monitor/src/server/db/product-repository.ts`
- Create: `apps/product-monitor/test/helpers.ts`
- Create: `apps/product-monitor/test/product-repository.test.ts`

**Interfaces:**
- Consumes: domain types từ Task 1.
- Produces:

```ts
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
```

`test/helpers.ts` phải cung cấp các factory dùng xuyên suốt plan:

```ts
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
```

- [ ] **Step 1: Viết test migration và khôi phục draft**

```ts
it("persists one active product and coalesces excel jobs", () => {
    const db = createTestDatabase();
    const repo = new SqliteProductRepository(db);
    const product = repo.createProduct(fixtureProduct({ status: "receiving_images" }));

    repo.enqueueExcelSync(product.id);
    repo.enqueueExcelSync(product.id);

    expect(repo.getActiveProduct()?.id).toBe(product.id);
    expect(repo.listPendingExcelJobs()).toHaveLength(1);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- product-repository.test.ts`

Expected: FAIL vì migration/repository chưa tồn tại.

- [ ] **Step 3: Tạo schema và transaction methods**

Schema tối thiểu:

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  description_message_id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  posted_at INTEGER NOT NULL,
  raw_content TEXT NOT NULL,
  product_name TEXT,
  brand TEXT,
  model TEXT,
  cpu TEXT,
  ram TEXT,
  storage TEXT,
  gpu TEXT,
  display TEXT,
  condition_text TEXT,
  price INTEGER,
  raw_price TEXT,
  notes TEXT,
  image_count INTEGER NOT NULL DEFAULT 0,
  cover_image_path TEXT,
  media_directory TEXT NOT NULL,
  heart_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  excel_sync_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_receiving_product
ON products(status) WHERE status = 'receiving_images';
CREATE TABLE product_media (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  source_message_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  local_path TEXT,
  checksum TEXT,
  download_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE product_reactions (
  product_id TEXT NOT NULL REFERENCES products(id),
  target_message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  icon TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, target_message_id, user_id)
);
CREATE TABLE excel_sync_jobs (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Chạy repository tests**

Run: `npm --prefix apps/product-monitor test -- product-repository.test.ts`

Expected: PASS, bao gồm unique active draft, cascade dữ liệu và coalesced job.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/db apps/product-monitor/test/product-repository.test.ts
git commit -m "feat: add durable product repository"
```

---

### Task 3: Laptop parser theo fixtures thực tế

**Files:**
- Create: `apps/product-monitor/src/server/parser/laptop-parser.ts`
- Create: `apps/product-monitor/test/fixtures/laptop-posts.ts`
- Create: `apps/product-monitor/test/laptop-parser.test.ts`

**Interfaces:**
- Consumes: raw text.
- Produces:

```ts
export type LaptopParseResult =
    | { ok: true; fields: ParsedLaptopFields }
    | { ok: false; fields: {}; reason: "structure_not_recognized" };

export function parseLaptopPost(content: string): LaptopParseResult;
export function parseVietnamesePrice(raw: string): number | null;
```

- [ ] **Step 1: Viết fixtures và failing table tests**

```ts
it.each([
    ["GIÁ 5 TRIỆU", 5_000_000],
    ["GIÁ : 3 TRIỆU 8", 3_800_000],
    ["GIÁ THU VỀ 5 TRIỆU 900", 5_900_000],
    ["4 TRIỆU 4", 4_400_000],
])("normalizes %s", (raw, expected) => {
    expect(parseVietnamesePrice(raw)).toBe(expected);
});

it("keeps alternate configuration in notes", () => {
    const result = parseLaptopPost(HP_ZBOOK_15_G3);
    expect(result).toMatchObject({
        ok: true,
        fields: {
            productName: "HP ZBook 15 G3",
            cpu: "Core i7 6820HQ",
            ram: "16GB",
            storage: "SSD 512GB",
            gpu: "Quadro M1000M",
            price: 5_900_000,
            notes: expect.stringContaining("RAM 8GB"),
        },
    });
});
```

- [ ] **Step 2: Chạy parser tests để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- laptop-parser.test.ts`

Expected: FAIL vì parser chưa tồn tại.

- [ ] **Step 3: Implement tokenizer và extractors**

Implementation phải:

```ts
const CORE_FIELD_PATTERNS = {
    cpu: /\b(?:CPU\s*)?(CORE\s+I[3579]\s*[- ]?\w+|M[123]\b)/i,
    ram: /\bRAM\s*:?\s*(\d+\s*GB)\b/i,
    storage: /\b(?:Ổ\s*)?(SSD|HDD)\s*:?\s*(\d+\s*(?:GB|TB))\b/i,
    gpu: /\b(?:CARD|GPU)\s*:?\s*([^-–\n]+)/i,
    display: /\bMÀN(?:\s+HÌNH)?\s*:?\s*([^-–\n]+)/i,
};
```

- Không xem dòng cấu hình thay thế sau giá chính là field chính.
- Giữ `rawPrice`.
- Trả `ok: false` nếu không nhận diện được tên, CPU, RAM, storage và giá.

- [ ] **Step 4: Chạy parser tests**

Run: `npm --prefix apps/product-monitor test -- laptop-parser.test.ts`

Expected: PASS cho toàn bộ MacBook Air, HP ProBook và HP ZBook đã cung cấp.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/parser apps/product-monitor/test/fixtures/laptop-posts.ts apps/product-monitor/test/laptop-parser.test.ts
git commit -m "feat: parse structured laptop posts"
```

---

### Task 4: Product draft state machine

**Files:**
- Create: `apps/product-monitor/src/server/products/product-coordinator.ts`
- Create: `apps/product-monitor/test/product-coordinator.test.ts`

**Interfaces:**
- Consumes: `NormalizedDescriptionEvent`, `NormalizedImageEvent`, `ProductRepository`, `parseLaptopPost`.
- Produces:

```ts
export class ProductCoordinator {
    handleDescription(event: NormalizedDescriptionEvent): ProductRecord;
    handleImage(event: NormalizedImageEvent): ProductMedia | "orphan";
    completeActive(completedAt: number): ProductRecord | null;
}
```

- [ ] **Step 1: Viết failing transition tests**

```ts
it("completes the previous draft before creating the next", () => {
    coordinator.handleDescription(descriptionEvent({ messageId: "m1" }));
    const second = coordinator.handleDescription(descriptionEvent({ messageId: "m2" }));

    expect(repo.getProductByMessageId("m1")?.status).toBe("completed");
    expect(repo.getActiveProduct()?.id).toBe(second.id);
});

it("marks unparseable posts for review without guessing fields", () => {
    const product = coordinator.handleDescription(descriptionEvent({ content: "máy đẹp inbox" }));
    expect(product.status).toBe("needs_review");
    expect(product.productName).toBeUndefined();
});
```

- [ ] **Step 2: Chạy tests để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- product-coordinator.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement transitions trong transaction**

Core sequence:

```ts
handleDescription(event: NormalizedDescriptionEvent): ProductRecord {
    this.assertActiveGroup(event.groupId);
    this.assertPublisher(event.senderId);
    this.repository.completeActiveProduct(event.sentAt);
    const parsed = parseLaptopPost(event.content);
    const product = this.repository.createProduct(
        mapDescriptionToNewProduct(event, parsed, this.mediaRoot),
    );
    this.repository.enqueueExcelSync(product.id);
    return product;
}
```

- Duplicate `descriptionMessageId` phải idempotent và trả bản ghi cũ.
- `handleImage` chỉ gắn vào active draft từ đúng group và publisher.

- [ ] **Step 4: Chạy tests**

Run: `npm --prefix apps/product-monitor test -- product-coordinator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/products apps/product-monitor/test/product-coordinator.test.ts
git commit -m "feat: coordinate product draft lifecycle"
```

---

### Task 5: Media download, checksum và cover image

**Files:**
- Create: `apps/product-monitor/src/server/media/media-store.ts`
- Create: `apps/product-monitor/test/media-store.test.ts`

**Interfaces:**
- Consumes: `ProductMedia`, `ProductRepository`, injected `fetch`.
- Produces:

```ts
export class MediaStore {
    download(product: ProductRecord, media: ProductMedia): Promise<ProductMedia>;
    retryPending(): Promise<void>;
}
```

- [ ] **Step 1: Viết failing media tests**

```ts
it("stores ordered images and chooses the first as cover", async () => {
    fetchMock.mockResolvedValue(imageResponse(JPEG_BYTES));
    await store.download(product, pendingMedia({ sequence: 1 }));
    await store.download(product, pendingMedia({ sequence: 2 }));

    expect(repo.getProduct(product.id)?.coverImagePath).toMatch(/001\.jpg$/);
    expect(repo.listMedia(product.id)).toHaveLength(2);
});

it("does not duplicate identical checksums", async () => {
    await store.download(product, pendingMedia({ sourceMessageId: "i1" }));
    await store.download(product, pendingMedia({ sourceMessageId: "i2" }));
    expect(repo.listMedia(product.id).filter((m) => m.downloadStatus === "downloaded")).toHaveLength(1);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- media-store.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement atomic image writes**

Implementation:

```ts
const bytes = Buffer.from(await response.arrayBuffer());
const checksum = createHash("sha256").update(bytes).digest("hex");
const finalPath = join(product.mediaDirectory, `${String(media.sequence).padStart(3, "0")}.jpg`);
const tempPath = `${finalPath}.tmp`;
await writeFile(tempPath, bytes);
await rename(tempPath, finalPath);
```

- Validate `content-type` bắt đầu bằng `image/`.
- Không ghi đè file hoàn tất.
- Download failure đặt `download_status = failed`, giữ URL nguồn và enqueue retry.

- [ ] **Step 4: Chạy tests**

Run: `npm --prefix apps/product-monitor test -- media-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/media apps/product-monitor/test/media-store.test.ts
git commit -m "feat: persist product media safely"
```

---

### Task 6: Reaction aggregation theo sản phẩm

**Files:**
- Create: `apps/product-monitor/src/server/reactions/reaction-aggregator.ts`
- Create: `apps/product-monitor/test/reaction-aggregator.test.ts`

**Interfaces:**
- Consumes:

```ts
export type NormalizedReactionEvent = {
    groupId: string;
    targetMessageIds: string[];
    userId: string;
    icon: string;
    active: boolean;
    occurredAt: number;
};
```

- Produces: `ReactionAggregator.apply(event): ProductRecord[]`.

- [ ] **Step 1: Viết failing reaction tests**

```ts
it("counts one person once across multiple product images", () => {
    aggregator.apply(heart({ userId: "u1", targetMessageIds: ["image-1"] }));
    aggregator.apply(heart({ userId: "u1", targetMessageIds: ["image-2"] }));
    expect(repo.getProduct(product.id)?.heartCount).toBe(1);
});

it("decrements when heart is removed or replaced", () => {
    aggregator.apply(heart({ userId: "u1" }));
    aggregator.apply(reaction({ userId: "u1", icon: ":>", active: true }));
    expect(repo.getProduct(product.id)?.heartCount).toBe(0);
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- reaction-aggregator.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement unique-user aggregation**

Heart predicate:

```ts
export const isHeart = (icon: string, rType?: number) => icon === "/-heart" || rType === 5;
```

Sau mỗi upsert/delete reaction:

```ts
const heartCount = repository.countUniqueHearts(productId);
repository.updateHeartCount(productId, heartCount);
repository.enqueueExcelSync(productId);
```

- Events cũ và mới phải idempotent theo timestamp.
- Reaction ngoài active group hoặc không map được message về product bị bỏ qua có log.

- [ ] **Step 4: Chạy tests**

Run: `npm --prefix apps/product-monitor test -- reaction-aggregator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/reactions apps/product-monitor/test/reaction-aggregator.test.ts
git commit -m "feat: aggregate product heart reactions"
```

---

### Task 7: Excel workbook writer và lock queue

**Files:**
- Create: `apps/product-monitor/src/server/excel/excel-sync-worker.ts`
- Create: `apps/product-monitor/test/excel-sync-worker.test.ts`

**Interfaces:**
- Consumes: `ProductRepository`, `ProductRecord`, media list, `AppConfig`.
- Produces:

```ts
export class ExcelSyncWorker {
    syncPending(): Promise<{ synced: number; blocked: number; failed: number }>;
    syncProduct(productId: string): Promise<void>;
}
```

Worker nhận filesystem adapter để test lock lỗi mà không khóa file thật:

```ts
export interface ExcelFileSystem {
    copyFile(source: string, destination: string): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
    access(path: string): Promise<void>;
}
```

- [ ] **Step 1: Viết failing workbook tests**

```ts
it("creates a monthly sheet and embeds only the cover", async () => {
    await worker.syncProduct(product.id);
    const workbook = await openWorkbook(config.workbookPath);
    const sheet = workbook.getWorksheet("2026-07")!;
    expect(sheet.getRow(2).getCell(5).value).toBe("HP ZBook 15 G3");
    expect(sheet.getImages()).toHaveLength(1);
});

it("keeps the job pending when the workbook is locked", async () => {
    fsAdapter.rename.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EBUSY" }));
    await expect(worker.syncProduct(product.id)).resolves.toBeUndefined();
    expect(repo.listPendingExcelJobs()[0]?.status).toBe("blocked");
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- excel-sync-worker.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement sheet schema và atomic replace**

Header order phải đúng 22 cột trong spec. Giá dùng number format `#,##0`; hyperlink:

```ts
row.getCell(18).value = {
    text: "Mở thư mục ảnh",
    hyperlink: pathToFileURL(product.mediaDirectory).href,
};
```

Atomic workflow:

```ts
await workbook.xlsx.writeFile(tempPath);
await copyFile(workbookPath, backupPath).catch(ignoreMissingFile);
await rename(tempPath, workbookPath);
```

- Với Windows, `EPERM`, `EACCES`, `EBUSY` đặt job `blocked`, không tăng failure counter.
- Upsert row bằng hidden product ID comment hoặc message ID index; không tạo dòng mới khi chỉ cập nhật ảnh/tim.
- Retry interval mặc định 10 giây và `syncPending()` có thể gọi thủ công.

- [ ] **Step 4: Chạy workbook tests và mở file smoke test**

Run:

```bash
npm --prefix apps/product-monitor test -- excel-sync-worker.test.ts
npm --prefix apps/product-monitor test -- excel-sync-worker.test.ts -t "creates a monthly sheet"
```

Expected: PASS; file test mở được bằng ExcelJS sau khi ghi.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/excel apps/product-monitor/test/excel-sync-worker.test.ts
git commit -m "feat: sync products to monthly Excel sheets"
```

---

### Task 8: Zalo adapter, group selection và event normalization

**Files:**
- Create: `apps/product-monitor/src/server/zalo/zalo-adapter.ts`
- Create: `apps/product-monitor/test/fixtures/zalo-events.ts`
- Create: `apps/product-monitor/test/zalo-adapter.test.ts`

**Interfaces:**
- Consumes: `Zalo`, `GroupMessage`, `Reaction` từ package hiện tại.
- Produces:

```ts
export interface ZaloProductAdapter {
    getConnectionState(): "signed_out" | "waiting_for_scan" | "connected" | "reconnecting" | "disconnected";
    beginQrLogin(onQr: (event: { image?: string; state: string }) => void): Promise<void>;
    listGroups(): Promise<Array<{ id: string; name: string; adminIds: string[] }>>;
    selectGroup(groupId: string): Promise<void>;
    start(): Promise<void>;
    stop(): void;
    onDescription(handler: (event: NormalizedDescriptionEvent) => void): void;
    onImage(handler: (event: NormalizedImageEvent) => void): void;
    onReaction(handler: (event: NormalizedReactionEvent) => void): void;
}
```

- [ ] **Step 1: Viết failing normalization tests**

```ts
it("accepts text only from the selected group admin", () => {
    adapter.selectGroup("g1");
    adapter.handleMessage(groupText({ groupId: "g1", senderId: "admin-1" }));
    adapter.handleMessage(groupText({ groupId: "g1", senderId: "member-1" }));
    expect(onDescription).toHaveBeenCalledTimes(1);
});

it("normalizes chat.photo href as an image event", () => {
    adapter.handleMessage(groupPhoto({
        content: { href: "https://photo.example/original.jpg", thumb: "https://photo.example/thumb.jpg" },
    }));
    expect(onImage).toHaveBeenCalledWith(expect.objectContaining({
        imageUrl: "https://photo.example/original.jpg",
    }));
});
```

- [ ] **Step 2: Chạy tests để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- zalo-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement adapter bằng API hiện có**

QR login:

```ts
const zalo = new Zalo({ selfListen: false, logging: true });
const api = await zalo.loginQR({}, (event) => {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        onQr({ image: event.data.image, state: "waiting_for_scan" });
    }
    if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
        onQr({ state: "waiting_for_confirmation" });
    }
    if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        onQr({ state: "connected" });
    }
});
```

Credentials/session data phải nằm trong `data/credentials.json`, được loại khỏi Git và chỉ đọc bởi backend local.

Group loading:

```ts
const all = await api.getAllGroups();
const ids = Object.keys(all.gridVerMap);
const details = await api.getGroupInfo(ids);
return Object.values(details.gridInfoMap).map((group) => ({
    id: group.groupId,
    name: group.name,
    adminIds: group.adminIds.map(String),
}));
```

Listener wiring:

```ts
api.listener.on("message", (message) => this.handleMessage(message));
api.listener.on("reaction", (reaction) => this.handleReaction(reaction));
api.listener.on("old_reactions", (reactions) => reactions.forEach((r) => this.handleReaction(r)));
api.listener.start();
api.listener.requestOldReactions(ThreadType.Group);
```

- `webchat` string content → description.
- `chat.photo` object content with `href` → image.
- Unknown attachment shape được log kèm raw event sanitized, không crash.

- [ ] **Step 4: Chạy adapter tests**

Run: `npm --prefix apps/product-monitor test -- zalo-adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/zalo apps/product-monitor/test/fixtures/zalo-events.ts apps/product-monitor/test/zalo-adapter.test.ts
git commit -m "feat: normalize selected Zalo group events"
```

---

### Task 9: REST API và SSE realtime

**Files:**
- Create: `apps/product-monitor/src/shared/api.ts`
- Create: `apps/product-monitor/src/server/http/app.ts`
- Create: `apps/product-monitor/test/http-app.test.ts`

**Interfaces:**
- Consumes: repository, coordinator, Excel worker, Zalo adapter.
- Produces:

```text
GET  /api/groups
POST /api/auth/qr
GET  /api/auth/status
PUT  /api/settings/active-group
GET  /api/products
GET  /api/products/:id
POST /api/products/:id/complete
POST /api/excel/sync
GET  /api/status
GET  /api/events
```

- [ ] **Step 1: Viết failing API tests**

```ts
it("selects exactly one active group", async () => {
    await request(app).put("/api/settings/active-group").send({ groupId: "g1" }).expect(204);
    expect(repo.getSetting("activeGroupId")).toBe("g1");
});

it("completes only the active local draft", async () => {
    await request(app).post(`/api/products/${product.id}/complete`).expect(200);
    expect(repo.getProduct(product.id)?.status).toBe("completed");
    expect(zaloWriteSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Chạy tests để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- http-app.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement validation và SSE hub**

SSE event union:

```ts
export type ProductMonitorEvent =
    | { type: "product.created"; product: ProductRecord }
    | { type: "product.updated"; product: ProductRecord }
    | { type: "excel.status"; pending: number; blocked: boolean; lastError?: string }
    | { type: "connection.status"; state: "connected" | "reconnecting" | "disconnected" };
```

SSE response headers:

```ts
res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
});
```

- Zod validate group ID và route params.
- API error body cố định `{ error: { code, message } }`.

- [ ] **Step 4: Chạy HTTP tests**

Run: `npm --prefix apps/product-monitor test -- http-app.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/product-monitor/src/server/http apps/product-monitor/src/shared/api.ts apps/product-monitor/test/http-app.test.ts
git commit -m "feat: expose product monitor API and events"
```

---

### Task 10: Cập nhật thiết kế Pencil cho màn Sản phẩm

**Files:**
- Modify: `zalo-tool.pen` bằng Pencil MCP.
- Export verification: `design-previews/product-mapping.png`

**Interfaces:**
- Consumes: UI section trong spec và API contracts Task 9.
- Produces: một top-level frame `Zalo Monitor / Product Mapping` theo phương án A.

- [ ] **Step 1: Dùng Pencil đọc đúng file và tìm vùng trống**

Call `get_app_state` và xác nhận active canvas là `/w:/Personal/zalo-tool/zalo-tool.pen`. Dùng `FindEmptySpace({width:1440,height:960,padding:80})`.

- [ ] **Step 2: Dựng màn Product Mapping**

Màn phải có:

- sidebar với mục `Sản phẩm` active;
- header tên nhóm, trạng thái listener, banner Excel bị khóa và `Đồng bộ lại ngay`;
- bảng với ảnh, thời gian, sản phẩm, cấu hình, giá, ảnh/tym, xử lý và Excel;
- bộ lọc nhanh;
- panel phải có gallery, dữ liệu map, nội dung gốc, lịch sử sync và `Kết thúc nhận ảnh`;
- trạng thái empty khi chưa chọn nhóm.

- [ ] **Step 3: Kiểm tra layout**

Run Pencil visitor:

```js
Get(productMappingScreen, (n, c) => c.problems && Print(n.name, "|", c.problems))
```

Expected: không có output problem.

- [ ] **Step 4: Export screenshot**

Export node sang `design-previews/product-mapping.png` và kiểm tra trực quan: bảng là vùng trội, panel phải không lấn bảng, trạng thái Excel nhận ra được mà không chỉ dựa màu.

- [ ] **Step 5: Commit**

```bash
git add zalo-tool.pen design-previews/product-mapping.png
git commit -m "design: add realtime product mapping screen"
```

---

### Task 11: React realtime product table và detail panel

**Files:**
- Create: `apps/product-monitor/index.html`
- Create: `apps/product-monitor/src/client/main.tsx`
- Create: `apps/product-monitor/src/client/App.tsx`
- Create: `apps/product-monitor/src/client/api.ts`
- Create: `apps/product-monitor/src/client/styles.css`
- Create: `apps/product-monitor/src/client/components/GroupPicker.tsx`
- Create: `apps/product-monitor/src/client/components/QrLogin.tsx`
- Create: `apps/product-monitor/src/client/components/ProductTable.tsx`
- Create: `apps/product-monitor/src/client/components/ProductDetailPanel.tsx`
- Create: `apps/product-monitor/src/client/components/ExcelSyncBanner.tsx`
- Create: `apps/product-monitor/test/product-ui.test.tsx`

**Interfaces:**
- Consumes: REST/SSE contracts Task 9 và Pencil screen Task 10.
- Produces: responsive local UI.

- [ ] **Step 1: Viết failing UI tests**

```tsx
it("updates an existing row in place when media and hearts change", async () => {
    render(<App api={fakeApi} />);
    emit({ type: "product.created", product });
    emit({ type: "product.updated", product: { ...product, imageCount: 5, heartCount: 12 } });

    expect(await screen.findByText("HP ZBook 15 G3")).toBeInTheDocument();
    expect(screen.getByText("5 ảnh · 12 tym")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
});

it("shows pending writes without blocking realtime data", async () => {
    emit({ type: "excel.status", pending: 6, blocked: true });
    expect(await screen.findByText(/Excel đang mở.*6 thay đổi/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Chạy tests để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- product-ui.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement group picker và app state**

App state giữ products trong `Map<string, ProductRecord>`:

```ts
setProducts((current) => {
    const next = new Map(current);
    next.set(event.product.id, event.product);
    return next;
});
```

- Sort `receiving_images` trước, sau đó `postedAt` giảm dần.
- Product update không đổi selection hoặc scroll nếu sort key không đổi.
- Chưa có `activeGroupId` thì chỉ render `GroupPicker`.
- Chưa đăng nhập thì render `QrLogin`, nhận QR/state qua API và SSE rồi mới tải danh sách nhóm.

- [ ] **Step 4: Implement table, filters và panel**

Required accessible labels:

```tsx
<button aria-label="Đồng bộ Excel lại ngay">Đồng bộ lại ngay</button>
<button aria-label={`Xem chi tiết ${product.productName ?? "sản phẩm"}`}>Xem</button>
<button aria-label="Kết thúc nhận ảnh">Kết thúc nhận ảnh</button>
```

- Không render composer, send button hoặc reaction action.
- Panel gallery dùng ảnh local từ route media read-only.
- Filter: all, receiving, review, unsynced; search: name/CPU/RAM/storage; price range.

- [ ] **Step 5: Chạy UI tests và build**

Run:

```bash
npm --prefix apps/product-monitor test -- product-ui.test.tsx
npm --prefix apps/product-monitor run build
```

Expected: PASS; Vite build không có TypeScript error.

- [ ] **Step 6: Commit**

```bash
git add apps/product-monitor/index.html apps/product-monitor/src/client apps/product-monitor/test/product-ui.test.tsx
git commit -m "feat: add realtime product mapping UI"
```

---

### Task 12: Bootstrap, recovery flow và end-to-end verification

**Files:**
- Create: `apps/product-monitor/src/server/index.ts`
- Create: `apps/product-monitor/test/recovery-flow.test.ts`
- Create: `apps/product-monitor/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: tất cả services Task 2–11.
- Produces: executable local application và operator documentation.

- [ ] **Step 1: Viết failing recovery test**

```ts
it("recovers an active draft and pending Excel job after restart", async () => {
    const first = await startHarness(sharedDataDir);
    first.coordinator.handleDescription(descriptionEvent({ messageId: "m1" }));
    await first.stop();

    const second = await startHarness(sharedDataDir);
    expect(second.repository.getActiveProduct()?.descriptionMessageId).toBe("m1");
    expect(second.repository.listPendingExcelJobs()).toHaveLength(1);
});
```

- [ ] **Step 2: Chạy recovery test để xác nhận thất bại**

Run: `npm --prefix apps/product-monitor test -- recovery-flow.test.ts`

Expected: FAIL vì composition root chưa tồn tại.

- [ ] **Step 3: Implement composition root**

Startup order:

```ts
const config = loadConfig(process.env);
const database = openDatabase(config.databasePath);
runMigrations(database);
const repository = new SqliteProductRepository(database);
const mediaStore = new MediaStore(repository, config);
const excelWorker = new ExcelSyncWorker(repository, config);
const coordinator = new ProductCoordinator(repository, config);
const reactions = new ReactionAggregator(repository);
const zalo = await createZaloAdapter(repository, config);
const app = createHttpApp({ repository, coordinator, excelWorker, zalo });
```

Sau khi HTTP server nghe:

1. restore active group/publisher;
2. retry media;
3. sync pending Excel jobs;
4. start Zalo listener;
5. schedule Excel retry mỗi 10 giây;
6. shutdown đóng listener, timer, HTTP server và database.

- [ ] **Step 4: Viết operator README**

README phải có exact commands:

```bash
npm run build
npm --prefix apps/product-monitor run build
npm --prefix apps/product-monitor start
```

Và mô tả:

- vị trí credentials theo cơ chế đăng nhập hiện có;
- chọn một nhóm;
- workbook/media/database ở đâu;
- ý nghĩa banner Excel đang mở;
- cách backup/restore;
- cảnh báo API Zalo cá nhân không chính thức và chế độ chỉ đọc.

- [ ] **Step 5: Chạy full verification**

Run:

```bash
npm run build
npm run lint
npm --prefix apps/product-monitor test
npm --prefix apps/product-monitor run build
```

Expected: tất cả PASS.

- [ ] **Step 6: Manual smoke test**

1. Đăng nhập bằng QR.
2. Chọn nhóm laptop.
3. Gửi fixture mô tả HP ZBook rồi năm ảnh.
4. Xác nhận UI có một dòng, năm ảnh và trạng thái receiving.
5. Gửi mô tả MacBook tiếp theo; HP ZBook chuyển completed.
6. Thả/gỡ tim; UI và Excel cập nhật unique count.
7. Mở workbook trong Excel, tạo một sản phẩm mới, xác nhận banner blocked.
8. Đóng Excel, nhấn sync, xác nhận job về synced.
9. Restart app, xác nhận dữ liệu và active draft phục hồi.

- [ ] **Step 7: Commit**

```bash
git add apps/product-monitor/src/server/index.ts apps/product-monitor/test/recovery-flow.test.ts apps/product-monitor/README.md README.md
git commit -m "feat: complete product monitor recovery flow"
```
