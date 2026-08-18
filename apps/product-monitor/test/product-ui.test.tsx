// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import type { ProductMonitorApi } from "../src/client/api.js";
import type { ProductMonitorEvent } from "../src/shared/api.js";
import type { ProductRecord } from "../src/shared/domain.js";

const product: ProductRecord = {
    id: "product-1",
    groupId: "g1",
    groupName: "Laptop giá tốt",
    descriptionMessageId: "message-1",
    senderId: "admin-1",
    postedAt: Date.parse("2026-07-29T10:45:00+07:00"),
    rawContent: "HP ZBOOK 15 G3 - CORE I7 6820HQ - RAM 16GB - SSD 512GB",
    productName: "HP ZBook 15 G3",
    brand: "HP",
    model: "ZBook 15 G3",
    cpu: "Core i7 6820HQ",
    ram: "16GB",
    storage: "SSD 512GB",
    price: 5_900_000,
    rawPrice: "5 TRIỆU 900",
    imageCount: 0,
    mediaDirectory: "data/media/2026-07/product-1",
    heartCount: 0,
    saleStatus: "available",
    status: "receiving_images",
    excelSyncStatus: "pending",
    createdAt: 1,
    updatedAt: 1,
};

const createApi = (overrides: Partial<ProductMonitorApi> = {}) => {
    let handler: ((event: ProductMonitorEvent) => void) | undefined;
    const api: ProductMonitorApi = {
        getStatus: vi.fn().mockResolvedValue({
            connection: "connected",
            activeGroupId: "g1",
            activeProductId: product.id,
            excel: { pending: 0, blocked: false },
        }),
        getGroups: vi.fn().mockResolvedValue([
            { id: "g1", name: "Laptop giá tốt", adminIds: ["admin-1"] },
        ]),
        selectGroup: vi.fn().mockResolvedValue(undefined),
        beginQrLogin: vi.fn().mockResolvedValue(undefined),
        getProducts: vi.fn().mockResolvedValue([]),
        getProduct: vi.fn().mockResolvedValue({
            product,
            media: [{
                id: "media-1",
                productId: product.id,
                sourceMessageId: "image-1",
                sequence: 1,
                localPath: "001.jpg",
                downloadStatus: "downloaded",
                createdAt: 2,
            }],
        }),
        completeProduct: vi.fn().mockResolvedValue({ ...product, status: "completed" }),
        syncExcel: vi.fn().mockResolvedValue({ synced: 1, blocked: 0, failed: 0 }),
        subscribe: vi.fn().mockImplementation((listener) => {
            handler = listener;
            return () => {
                handler = undefined;
            };
        }),
        ...overrides,
    };
    return {
        api,
        emit: (event: ProductMonitorEvent) => act(() => handler?.(event)),
    };
};

describe("Product Monitor UI", () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it("updates an existing row in place when media and hearts change", async () => {
        const { api, emit } = createApi();
        render(<App api={api} />);
        await screen.findByText("Sản phẩm realtime");

        emit({ type: "product.created", product });
        emit({ type: "product.updated", product: { ...product, imageCount: 5, heartCount: 12 } });

        expect(await screen.findByText("HP ZBook 15 G3")).toBeInTheDocument();
        expect(screen.getByText("5 ảnh · 12 tym")).toBeInTheDocument();
        expect(screen.getAllByRole("row")).toHaveLength(2);
    });

    it("shows pending writes without blocking realtime data", async () => {
        const { api, emit } = createApi();
        render(<App api={api} />);
        await screen.findByText("Sản phẩm realtime");

        emit({ type: "excel.status", pending: 6, blocked: true });

        expect(await screen.findByText(/Excel đang mở.*6 thay đổi/)).toBeInTheDocument();
        expect(screen.getByLabelText("Đồng bộ Excel lại ngay")).toBeEnabled();
    });

    it("filters products without adding any Zalo write controls", async () => {
        const review = {
            ...product,
            id: "product-2",
            descriptionMessageId: "message-2",
            productName: "MacBook Air M1",
            cpu: "Apple M1",
            status: "needs_review" as const,
            price: 7_000_000,
        };
        const { api } = createApi({
            getProducts: vi.fn().mockResolvedValue([product, review]),
        });
        render(<App api={api} />);

        await screen.findByText("MacBook Air M1");
        fireEvent.change(screen.getByLabelText("Tìm sản phẩm"), { target: { value: "ZBook" } });
        expect(screen.getByText("HP ZBook 15 G3")).toBeInTheDocument();
        expect(screen.queryByText("MacBook Air M1")).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /soạn|tin nhắn/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /gửi|reaction/i })).not.toBeInTheDocument();
    });

    it("opens the read-only detail panel and completes the active draft locally", async () => {
        const { api } = createApi({ getProducts: vi.fn().mockResolvedValue([product]) });
        render(<App api={api} />);

        fireEvent.click(await screen.findByLabelText("Xem chi tiết HP ZBook 15 G3"));
        const panel = await screen.findByRole("complementary", { name: "Chi tiết sản phẩm" });
        expect(within(panel).getByText("Nội dung gốc")).toBeInTheDocument();
        expect(within(panel).getByRole("img", { name: "Ảnh sản phẩm 1" }))
            .toHaveAttribute("src", "/api/media/media-1");

        fireEvent.click(within(panel).getByLabelText("Kết thúc nhận ảnh"));
        await waitFor(() => expect(api.completeProduct).toHaveBeenCalledWith(product.id));
    });

    it("shows group selection before loading products", async () => {
        const { api } = createApi({
            getStatus: vi.fn().mockResolvedValue({
                connection: "connected",
                activeGroupId: null,
                activeProductId: null,
                excel: { pending: 0, blocked: false },
            }),
        });
        render(<App api={api} />);

        fireEvent.click(await screen.findByRole("button", { name: /Theo dõi Laptop giá tốt/ }));
        await waitFor(() => expect(api.selectGroup).toHaveBeenCalledWith("g1"));
        await waitFor(() => expect(api.getProducts).toHaveBeenCalled());
    });

    it("shows QR login when the local session is signed out", async () => {
        const { api } = createApi({
            getStatus: vi.fn().mockResolvedValue({
                connection: "signed_out",
                activeGroupId: null,
                activeProductId: null,
                excel: { pending: 0, blocked: false },
            }),
        });
        render(<App api={api} />);

        expect(await screen.findByText("Kết nối tài khoản Zalo")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Tạo mã QR đăng nhập" }));
        expect(api.beginQrLogin).toHaveBeenCalledOnce();
    });
});
