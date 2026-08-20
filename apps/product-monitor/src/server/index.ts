import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { SqliteProductRepository, type ProductRepository } from "./db/product-repository.js";
import { ExcelSyncWorker } from "./excel/excel-sync-worker.js";
import { createHttpApp, SseHub } from "./http/app.js";
import { MediaStore } from "./media/media-store.js";
import { ProductCoordinator } from "./products/product-coordinator.js";
import { isProductInformation } from "./parser/product-message-classifier.js";
import { parseLaptopPost } from "./parser/laptop-parser.js";
import { ReactionAggregator } from "./reactions/reaction-aggregator.js";
import { ZaloAdapter, type ZaloProductAdapter } from "./zalo/zalo-adapter.js";

const RETRY_INTERVAL_MS = 10_000;

type PipelineDependencies = {
    repository: ProductRepository;
    coordinator: ProductCoordinator;
    reactions: ReactionAggregator;
    mediaStore: MediaStore;
    excelWorker: ExcelSyncWorker;
    zalo: ZaloProductAdapter;
    events: SseHub;
};

export function wireProductPipeline(dependencies: PipelineDependencies): void {
    const { repository, coordinator, reactions, mediaStore, excelWorker, zalo, events } = dependencies;

    zalo.onDescription((event) => {
        const previous = repository.getActiveProduct();
        const product = coordinator.handleDescription(event);
        if (previous && previous.id !== product.id) {
            const completed = repository.getProduct(previous.id);
            if (completed) events.publish({ type: "product.updated", product: completed });
        }
        events.publish({ type: "product.created", product });
        publishExcelStatus(repository, events);
    });

    zalo.onImage((event) => {
        const media = coordinator.handleImage(event);
        if (media === "orphan") return;
        const product = repository.getProduct(media.productId);
        if (!product) return;
        events.publish({ type: "product.updated", product });
        void mediaStore.download(product, media).then(() => {
            const updated = repository.getProduct(product.id);
            if (updated) events.publish({ type: "product.updated", product: updated });
            publishExcelStatus(repository, events);
        });
    });

    zalo.onReaction((event) => {
        for (const product of reactions.apply(event)) {
            events.publish({ type: "product.updated", product });
        }
        publishExcelStatus(repository, events);
    });

    zalo.onSaleStatus?.((event) => {
        const product = coordinator.handleSaleStatus(event);
        if (product === "ignored" || product === "orphan") return;
        events.publish({ type: "product.updated", product });
        publishExcelStatus(repository, events);
    });

    void excelWorker;
}

export async function recoverProductMonitor(dependencies: {
    repository: ProductRepository;
    mediaStore: Pick<MediaStore, "retryPending">;
    excelWorker: Pick<ExcelSyncWorker, "syncPending"> & Partial<Pick<ExcelSyncWorker, "collectStaleTemporaryFiles">>;
    zalo: Pick<ZaloProductAdapter, "restoreSession" | "start">;
    events: SseHub;
}): Promise<boolean> {
    const restored = await dependencies.zalo.restoreSession();
    const collected = await dependencies.excelWorker.collectStaleTemporaryFiles?.()
        .catch((error) => {
            console.error("[excel-gc]", safeMessage(error));
            return 0;
        });
    if (collected) console.log(`[excel-gc] removed ${collected} stale temporary workbook(s)`);
    await dependencies.mediaStore.retryPending();
    await dependencies.excelWorker.syncPending();
    publishExcelStatus(dependencies.repository, dependencies.events);
    if (restored) {
        await dependencies.zalo.start();
        dependencies.events.publish({ type: "connection.status", state: "connected" });
    }
    return restored;
}

export async function startProductMonitor(
    env: Record<string, string | undefined> = process.env,
): Promise<{ url: string; close(): Promise<void> }> {
    const config = loadConfig(env);
    await mkdir(config.dataDirectory, { recursive: true });
    const database = new Database(config.databasePath);
    const repository = new SqliteProductRepository(database);
    const removedNonProductRows = removeNonProductRows(repository);
    const reparsedProducts = reparseNeedsReviewProducts(repository);
    const events = new SseHub();
    const activeGroupId = () => repository.getSetting("activeGroupId");
    const activePublishers = () => parseStoredList(repository.getSetting("activeGroupAdminIds"));
    const coordinator = new ProductCoordinator(repository, {
        activeGroupId,
        publisherId: activePublishers,
        mediaRoot: config.mediaRoot,
    });
    const reactions = new ReactionAggregator(repository, { activeGroupId });
    const mediaStore = new MediaStore(repository, {
        mediaRoot: config.mediaRoot,
        fetch: (url) => fetch(url),
        onError: (error) => console.error("[media]", safeMessage(error)),
    });
    const excelWorker = new ExcelSyncWorker(repository, config);
    if (removedNonProductRows > 0 || reparsedProducts > 0) {
        const rebuildMarker = repository.listProducts({ limit: 1 })[0];
        if (rebuildMarker) repository.enqueueExcelSync(rebuildMarker.id);
    }
    const zalo = new ZaloAdapter({
        credentialsPath: config.credentialsPath,
        settings: repository,
        onDiagnostic: (code, event) => console.warn(`[zalo:${code}]`, event),
    });
    wireProductPipeline({ repository, coordinator, reactions, mediaStore, excelWorker, zalo, events });

    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const builtClient = resolve(moduleDirectory, "../client");
    const app = createHttpApp({
        repository,
        coordinator,
        excelWorker,
        zalo,
        events,
        clientDirectory: existsSync(resolve(builtClient, "index.html")) ? builtClient : undefined,
    });
    const server = await listen(app, config.port, config.host);
    const url = `http://${config.host}:${config.port}`;

    await recoverProductMonitor({ repository, mediaStore, excelWorker, zalo, events })
        .catch((error) => console.error("[recovery]", safeMessage(error)));
    const closeIdleDraft = () => {
        const completed = coordinator.completeIdleDraft(Date.now());
        if (completed) events.publish({ type: "product.updated", product: completed });
    };
    closeIdleDraft();
    const retryTimer = setInterval(() => {
        closeIdleDraft();
        void mediaStore.retryPending()
            .then(() => excelWorker.syncPending())
            .then(() => publishExcelStatus(repository, events))
            .catch((error) => console.error("[retry]", safeMessage(error)));
    }, RETRY_INTERVAL_MS);
    retryTimer.unref();

    let closed = false;
    return {
        url,
        async close() {
            if (closed) return;
            closed = true;
            clearInterval(retryTimer);
            zalo.stop();
            await closeServer(server);
            database.close();
        },
    };
}

const removeNonProductRows = (repository: ProductRepository): number => repository.runInTransaction(() => {
    const rows = repository.listProducts().filter((product) => !isProductInformation(product.rawContent));
    for (const product of rows) repository.deleteProduct(product.id);
    return rows.length;
});

const reparseNeedsReviewProducts = (repository: ProductRepository): number => repository.runInTransaction(() => {
    let reparsed = 0;
    for (const product of repository.listProducts({ status: "needs_review" })) {
        const parsed = parseLaptopPost(product.rawContent);
        if (!parsed.ok) continue;
        repository.applyParsedFields(product.id, parsed.fields);
        repository.enqueueExcelSync(product.id);
        reparsed += 1;
    }
    return reparsed;
});

const listen = (
    app: ReturnType<typeof createHttpApp>,
    port: number,
    host: string,
): Promise<Server> => new Promise((resolveServer, reject) => {
    const server = app.listen(port, host, () => resolveServer(server));
    server.once("error", reject);
});

const closeServer = (server: Server): Promise<void> => new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
});

const parseStoredList = (value: string | null): string[] => {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
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

const safeMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const isEntryPoint = process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
    const runtime = await startProductMonitor();
    console.log(`Zalo Product Monitor: ${runtime.url}`);
    let stopping = false;
    const shutdown = () => {
        if (stopping) return;
        stopping = true;
        void runtime.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
