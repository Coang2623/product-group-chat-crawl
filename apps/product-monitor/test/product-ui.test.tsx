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
        moveMedia: vi.fn().mockResolvedValue([]),
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

    const threeImageApi = () => createApi({
        getProducts: vi.fn().mockResolvedValue([product]),
        getProduct: vi.fn().mockResolvedValue({
            product,
            media: [1, 2, 3].map((sequence) => ({
                id: `media-${sequence}`,
                productId: product.id,
                sourceMessageId: `image-${sequence}`,
                sequence,
                localPath: `00${sequence}.jpg`,
                downloadStatus: "downloaded" as const,
                createdAt: sequence,
            })),
        }),
    });

    const openLightbox = async (label = "Phóng to ảnh 1") => {
        fireEvent.click(await screen.findByLabelText("Xem chi tiết HP ZBook 15 G3"));
        const panel = await screen.findByRole("complementary", { name: "Chi tiết sản phẩm" });
        fireEvent.click(within(panel).getByLabelText(label));
        return screen.findByRole("dialog");
    };

    it("zooms an image when its thumbnail is clicked", async () => {
        const { api } = threeImageApi();
        render(<App api={api} />);

        const dialog = await openLightbox();

        expect(within(dialog).getByRole("img", { name: "Ảnh sản phẩm 1" }))
            .toHaveAttribute("src", "/api/media/media-1");
        expect(within(dialog).getByText("1 / 3")).toBeInTheDocument();
    });

    it("steps through the images of one product with the arrow buttons", async () => {
        const { api } = threeImageApi();
        render(<App api={api} />);
        const dialog = await openLightbox();

        fireEvent.click(within(dialog).getByLabelText("Ảnh sau"));
        expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();

        fireEvent.click(within(dialog).getByLabelText("Ảnh trước"));
        expect(within(dialog).getByText("1 / 3")).toBeInTheDocument();
    });

    it("wraps around at both ends so the arrows never dead-end", async () => {
        const { api } = threeImageApi();
        render(<App api={api} />);
        const dialog = await openLightbox();

        fireEvent.click(within(dialog).getByLabelText("Ảnh trước"));
        expect(within(dialog).getByText("3 / 3")).toBeInTheDocument();

        fireEvent.click(within(dialog).getByLabelText("Ảnh sau"));
        expect(within(dialog).getByText("1 / 3")).toBeInTheDocument();
    });

    it("navigates and closes with the keyboard", async () => {
        const { api } = threeImageApi();
        render(<App api={api} />);
        const dialog = await openLightbox();

        fireEvent.keyDown(window, { key: "ArrowRight" });
        expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();

        fireEvent.keyDown(window, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("hides the arrows when a product has a single image", async () => {
        const { api } = createApi({ getProducts: vi.fn().mockResolvedValue([product]) });
        render(<App api={api} />);

        const dialog = await openLightbox();

        expect(within(dialog).queryByLabelText("Ảnh sau")).not.toBeInTheDocument();
        expect(within(dialog).getByText("1 / 1")).toBeInTheDocument();
    });

    describe("moving photos to another machine", () => {
        const other: ProductRecord = {
            ...product,
            id: "product-2",
            descriptionMessageId: "message-2",
            productName: "MSI Bravo 15",
            brand: "MSI",
            postedAt: product.postedAt + 60_000,
        };

        const twoMachineApi = () => createApi({
            getProducts: vi.fn().mockResolvedValue([product, other]),
            getProduct: vi.fn().mockResolvedValue({
                product,
                media: [1, 2].map((sequence) => ({
                    id: `media-${sequence}`,
                    productId: product.id,
                    sourceMessageId: `image-${sequence}`,
                    sequence,
                    localPath: `00${sequence}.jpg`,
                    downloadStatus: "downloaded" as const,
                    createdAt: sequence,
                })),
            }),
        });

        const enterSelection = async () => {
            fireEvent.click(await screen.findByLabelText("Xem chi tiết HP ZBook 15 G3"));
            const panel = await screen.findByRole("complementary", { name: "Chi tiết sản phẩm" });
            fireEvent.click(within(panel).getByRole("button", { name: "Chuyển ảnh sang máy khác" }));
            return panel;
        };

        it("sends the selected photos to the chosen machine", async () => {
            const { api } = twoMachineApi();
            render(<App api={api} />);

            const panel = await enterSelection();
            fireEvent.click(within(panel).getByLabelText("Chọn ảnh 1"));
            fireEvent.change(within(panel).getByLabelText("Máy nhận ảnh"), {
                target: { value: other.id },
            });
            fireEvent.click(within(panel).getByRole("button", { name: "Chuyển ảnh" }));

            await waitFor(() => expect(api.moveMedia).toHaveBeenCalledWith(["media-1"], other.id));
        });

        it("never offers the machine already showing the photos as a target", async () => {
            const { api } = twoMachineApi();
            render(<App api={api} />);

            const panel = await enterSelection();

            const options = within(panel).getByLabelText("Máy nhận ảnh")
                .querySelectorAll("option");
            expect([...options].map((option) => option.value)).toEqual(["", other.id]);
        });

        it("keeps the move disabled until both a photo and a machine are chosen", async () => {
            const { api } = twoMachineApi();
            render(<App api={api} />);

            const panel = await enterSelection();
            const move = within(panel).getByRole("button", { name: "Chuyển ảnh" });
            expect(move).toBeDisabled();

            fireEvent.click(within(panel).getByLabelText("Chọn ảnh 1"));
            expect(move).toBeDisabled();

            fireEvent.change(within(panel).getByLabelText("Máy nhận ảnh"), {
                target: { value: other.id },
            });
            expect(move).toBeEnabled();
            expect(api.moveMedia).not.toHaveBeenCalled();
        });

        it("reloads the gallery so moved photos leave the panel", async () => {
            const { api } = twoMachineApi();
            (api.moveMedia as ReturnType<typeof vi.fn>).mockResolvedValue([
                { ...product, imageCount: 1 },
                { ...other, imageCount: 1 },
            ]);
            render(<App api={api} />);

            const panel = await enterSelection();
            fireEvent.click(within(panel).getByLabelText("Chọn ảnh 1"));
            (api.getProduct as ReturnType<typeof vi.fn>).mockResolvedValue({
                product: { ...product, imageCount: 1 },
                media: [{
                    id: "media-2",
                    productId: product.id,
                    sourceMessageId: "image-2",
                    sequence: 1,
                    localPath: "001.jpg",
                    downloadStatus: "downloaded" as const,
                    createdAt: 2,
                }],
            });
            fireEvent.change(within(panel).getByLabelText("Máy nhận ảnh"), {
                target: { value: other.id },
            });
            fireEvent.click(within(panel).getByRole("button", { name: "Chuyển ảnh" }));

            await waitFor(() => expect(
                within(panel).getAllByRole("img", { name: /Ảnh sản phẩm/ }),
            ).toHaveLength(1));
            // Selection mode closes, so the zoom label is back.
            expect(within(panel).getByLabelText("Phóng to ảnh 1")).toBeInTheDocument();
        });

        it("stays in selection mode when the move fails", async () => {
            const { api } = twoMachineApi();
            (api.moveMedia as ReturnType<typeof vi.fn>)
                .mockRejectedValue(new Error("Không tìm thấy ảnh"));
            render(<App api={api} />);

            const panel = await enterSelection();
            fireEvent.click(within(panel).getByLabelText("Chọn ảnh 1"));
            fireEvent.change(within(panel).getByLabelText("Máy nhận ảnh"), {
                target: { value: other.id },
            });
            fireEvent.click(within(panel).getByRole("button", { name: "Chuyển ảnh" }));

            expect(await screen.findByRole("alert")).toHaveTextContent("Không tìm thấy ảnh");
            expect(within(panel).getByLabelText("Chọn ảnh 1")).toHaveAttribute("aria-pressed", "true");
        });
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
