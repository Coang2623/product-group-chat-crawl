import { describe, expect, it, vi } from "vitest";
import { SseHub } from "../src/server/http/app.js";
import { recoverProductMonitor } from "../src/server/index.js";
import type { ProductRepository } from "../src/server/db/product-repository.js";

describe("startup recovery", () => {
    it("retries durable work before starting a restored listener", async () => {
        const order: string[] = [];
        const events: unknown[] = [];
        const hub = new SseHub();
        hub.subscribe((event) => events.push(event));
        const repository = {
            listPendingExcelJobs: vi.fn().mockReturnValue([]),
        } as unknown as ProductRepository;

        const restored = await recoverProductMonitor({
            repository,
            mediaStore: {
                retryPending: vi.fn().mockImplementation(async () => {
                    order.push("media");
                }),
            },
            excelWorker: {
                syncPending: vi.fn().mockImplementation(async () => {
                    order.push("excel");
                    return { synced: 1, blocked: 0, failed: 0 };
                }),
            },
            zalo: {
                restoreSession: vi.fn().mockImplementation(async () => {
                    order.push("session");
                    return true;
                }),
                start: vi.fn().mockImplementation(async () => {
                    order.push("listener");
                }),
            },
            events: hub,
        });

        expect(restored).toBe(true);
        expect(order).toEqual(["session", "media", "excel", "listener"]);
        expect(events).toContainEqual({ type: "connection.status", state: "connected" });
        expect(events).toContainEqual({ type: "excel.status", pending: 0, blocked: false });
    });

    it("keeps local recovery available while signed out", async () => {
        const retryPending = vi.fn().mockResolvedValue(undefined);
        const syncPending = vi.fn().mockResolvedValue({ synced: 0, blocked: 0, failed: 0 });
        const start = vi.fn();
        const restored = await recoverProductMonitor({
            repository: {
                listPendingExcelJobs: vi.fn().mockReturnValue([]),
            } as unknown as ProductRepository,
            mediaStore: { retryPending },
            excelWorker: { syncPending },
            zalo: {
                restoreSession: vi.fn().mockResolvedValue(false),
                start,
            },
            events: new SseHub(),
        });

        expect(restored).toBe(false);
        expect(retryPending).toHaveBeenCalledOnce();
        expect(syncPending).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
    });
});
