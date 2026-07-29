import { resolve } from "node:path";
import express, {
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from "express";
import { z } from "zod";
import type { ProductMonitorEvent } from "../../shared/api.js";
import type { ProductRepository } from "../db/product-repository.js";
import type { ProductCoordinator } from "../products/product-coordinator.js";
import type { ZaloProductAdapter } from "../zalo/zalo-adapter.js";

type ExcelWorker = {
    syncPending(): Promise<{ synced: number; blocked: number; failed: number }>;
};

export type HttpAppDependencies = {
    repository: ProductRepository;
    coordinator: ProductCoordinator;
    excelWorker: ExcelWorker;
    zalo: ZaloProductAdapter;
    events?: SseHub;
};

const identifier = z.string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .refine((value) => value !== "." && value !== ".." && !value.includes(".."));
const activeGroupBody = z.object({ groupId: identifier }).strict();
const productParams = z.object({ id: identifier });
const listQuery = z.object({
    groupId: identifier.optional(),
    status: z.enum(["receiving_images", "completed", "needs_review"]).optional(),
    fromPostedAt: z.coerce.number().int().nonnegative().optional(),
    toPostedAt: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
}).strict();

export class SseHub {
    private readonly subscribers = new Set<(event: ProductMonitorEvent) => void>();

    subscribe(subscriber: (event: ProductMonitorEvent) => void): () => void {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    publish(event: ProductMonitorEvent): void {
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                this.subscribers.delete(subscriber);
            }
        }
    }
}

export function createHttpApp(dependencies: HttpAppDependencies): express.Express {
    const { repository, coordinator, excelWorker, zalo } = dependencies;
    const events = dependencies.events ?? new SseHub();
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "64kb" }));

    app.get("/api/groups", asyncRoute(async (_request, response) => {
        response.json({ groups: await zalo.listGroups() });
    }));

    app.post("/api/auth/qr", (_request, response) => {
        void zalo.beginQrLogin((event) => {
            events.publish({ type: "auth.qr", ...event });
        }).then(() => {
            events.publish({ type: "connection.status", state: "connected" });
        }).catch(() => {
            events.publish({ type: "connection.status", state: "disconnected" });
        });
        response.status(202).json({ state: "starting" });
    });

    app.get("/api/auth/status", (_request, response) => {
        response.json({ state: zalo.getConnectionState() });
    });

    app.put("/api/settings/active-group", asyncRoute(async (request, response) => {
        const { groupId } = parse(activeGroupBody, request.body);
        await zalo.selectGroup(groupId);
        response.status(204).send();
    }));

    app.get("/api/products", (request, response, next) => {
        try {
            const filter = parse(listQuery, request.query);
            response.json({ products: repository.listProducts(filter) });
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/products/:id", (request, response, next) => {
        try {
            const { id } = parse(productParams, request.params);
            const product = repository.getProduct(id);
            if (!product) throw new ApiError(404, "product_not_found", "Không tìm thấy sản phẩm");
            response.json({ product, media: repository.listMedia(product.id) });
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/media/:id", (request, response, next) => {
        try {
            const { id } = parse(productParams, request.params);
            const media = repository.getMedia(id);
            if (!media?.localPath || media.downloadStatus !== "downloaded") {
                throw new ApiError(404, "media_not_found", "Không tìm thấy ảnh");
            }
            response.sendFile(resolve(media.localPath), (error) => {
                if (error && !response.headersSent) next(error);
            });
        } catch (error) {
            next(error);
        }
    });

    app.post("/api/products/:id/complete", (request, response, next) => {
        try {
            const { id } = parse(productParams, request.params);
            const product = repository.getProduct(id);
            if (!product) throw new ApiError(404, "product_not_found", "Không tìm thấy sản phẩm");
            if (repository.getActiveProduct()?.id !== id) {
                throw new ApiError(409, "product_not_active", "Sản phẩm không còn nhận ảnh");
            }
            const completed = coordinator.completeActive(Date.now());
            if (!completed) throw new ApiError(409, "product_not_active", "Sản phẩm không còn nhận ảnh");
            events.publish({ type: "product.updated", product: completed });
            response.json({ product: completed });
        } catch (error) {
            next(error);
        }
    });

    app.post("/api/excel/sync", asyncRoute(async (_request, response) => {
        const result = await excelWorker.syncPending();
        publishExcelStatus(repository, events);
        response.json(result);
    }));

    app.get("/api/status", (_request, response) => {
        const jobs = repository.listPendingExcelJobs();
        response.json({
            connection: zalo.getConnectionState(),
            activeGroupId: repository.getSetting("activeGroupId"),
            activeProductId: repository.getActiveProduct()?.id ?? null,
            excel: {
                pending: jobs.length,
                blocked: jobs.some((job) => job.status === "blocked"),
                lastError: jobs.find((job) => job.lastError)?.lastError,
            },
        });
    });

    app.get("/api/events", (request, response) => {
        response.set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        response.write(": connected\n\n");
        const unsubscribe = events.subscribe((event) => {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        heartbeat.unref();
        request.on("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    app.use((_request, _response, next) => {
        next(new ApiError(404, "route_not_found", "Không tìm thấy API"));
    });

    app.use((
        error: unknown,
        _request: Request,
        response: Response,
        _next: NextFunction,
    ) => {
        void _next;
        const apiError = normalizeError(error);
        response.status(apiError.status).json({
            error: { code: apiError.code, message: apiError.message },
        });
    });

    app.locals.events = events;
    return app;
}

const asyncRoute = (
    handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler => (request, response, next) => {
    void handler(request, response).catch(next);
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new ApiError(400, "invalid_request", "Dữ liệu yêu cầu không hợp lệ");
    }
    return result.data;
};

class ApiError extends Error {
    public constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

const normalizeError = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;
    if (error instanceof SyntaxError) {
        return new ApiError(400, "invalid_json", "JSON không hợp lệ");
    }
    return new ApiError(500, "internal_error", "Lỗi nội bộ");
};

const publishExcelStatus = (repository: ProductRepository, events: SseHub): void => {
    const jobs = repository.listPendingExcelJobs();
    events.publish({
        type: "excel.status",
        pending: jobs.length,
        blocked: jobs.some((job) => job.status === "blocked"),
        lastError: jobs.find((job) => job.lastError)?.lastError,
    });
};
