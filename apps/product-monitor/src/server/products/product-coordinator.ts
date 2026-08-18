import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
    NewProductRecord,
    NormalizedDescriptionEvent,
    NormalizedImageEvent,
    NormalizedSaleStatusEvent,
    ProductMedia,
    ProductRecord,
    SaleStatus,
} from "../../shared/domain.js";
import type { ProductRepository } from "../db/product-repository.js";
import { parseLaptopPost, type LaptopParseResult } from "../parser/laptop-parser.js";

export type ProductCoordinatorOptions = {
    activeGroupId: string | (() => string | null);
    publisherId: string | (() => string | string[] | null);
    mediaRoot: string;
};

export class ProductCoordinator {
    public constructor(
        private readonly repository: ProductRepository,
        private readonly options: ProductCoordinatorOptions,
    ) {}

    handleDescription(event: NormalizedDescriptionEvent): ProductRecord {
        this.assertActiveGroup(event.groupId);
        this.assertPublisher(event.senderId);

        const existing = this.repository.getProductByMessageId(event.messageId);
        if (existing) {
            this.repository.linkMessage(existing.id, event.targetMessageIds ?? [event.messageId], "description", event.sentAt);
            return existing;
        }

        try {
            return this.repository.runInTransaction(() => {
                const completed = this.repository.completeActiveProduct(event.sentAt);
                if (completed) this.repository.enqueueExcelSync(completed.id);

                const parsed = parseLaptopPost(event.content);
                const product = this.repository.createProduct(
                    mapDescriptionToNewProduct(event, parsed, this.options.mediaRoot),
                );
                this.repository.linkMessage(product.id, event.targetMessageIds ?? [event.messageId], "description", event.sentAt);
                this.repository.enqueueExcelSync(product.id);
                return product;
            });
        } catch (error) {
            if (!isDescriptionMessageConflict(error)) throw error;
            const winner = this.repository.getProductByMessageId(event.messageId);
            if (!winner) throw error;
            return winner;
        }
    }

    handleImage(event: NormalizedImageEvent): ProductMedia | "orphan" {
        this.assertActiveGroup(event.groupId);
        this.assertPublisher(event.senderId);

        return this.repository.runInTransaction(() => {
            const active = this.repository.getActiveProduct();
            if (!active) return "orphan";
            if (active.groupId !== this.activeGroupId() || !this.publisherIds().includes(active.senderId)) {
                return "orphan";
            }

            const media = this.repository.addMedia({
                id: deterministicId("media", event.messageId),
                productId: active.id,
                sourceMessageId: event.messageId,
                sourceUrl: event.imageUrl,
                sequence: this.repository.listMedia(active.id).length + 1,
                downloadStatus: "pending",
                createdAt: event.sentAt,
            });
            this.repository.linkMessage(active.id, event.targetMessageIds ?? [event.messageId], "image", event.sentAt);
            this.repository.enqueueExcelSync(active.id);
            return media;
        });
    }

    handleSaleStatus(event: NormalizedSaleStatusEvent): ProductRecord | "ignored" | "orphan" {
        this.assertActiveGroup(event.groupId);
        this.assertPublisher(event.senderId);
        const saleStatus = classifySaleStatus(event.content);
        if (!saleStatus) return "ignored";
        if (this.repository.hasSaleStatusEvent(event.messageId)) {
            return this.repository.getProductByTargetMessageId(event.messageId) ?? "orphan";
        }

        let target = event.targetMessageIds
            .map((messageId) => this.repository.getProductByTargetMessageId(messageId))
            .find((product): product is ProductRecord => Boolean(product))
            ?? (event.targetContent
                ? this.repository.getProductByQuotedMessage(event.targetContent, event.targetSentAt)
                : null);
        let materializedFromQuote = false;
        if (!target && event.targetContent && event.targetSentAt !== undefined && event.groupName) {
            target = this.handleDescription({
                groupId: event.groupId,
                groupName: event.groupName,
                senderId: event.senderId,
                senderName: event.targetSenderName,
                messageId: event.targetMessageIds[0],
                targetMessageIds: event.targetMessageIds,
                content: event.targetContent,
                sentAt: event.targetSentAt,
            });
            materializedFromQuote = true;
        }
        if (!target) return "orphan";

        return this.repository.runInTransaction(() => {
            // Older versions interpreted every publisher text as a product. Remove only
            // the exact generated row for this now-recognized status reply.
            if (target.descriptionMessageId !== event.messageId) {
                this.repository.deleteGeneratedStatusProduct(event.messageId);
            }
            const targetMessageId = event.targetMessageIds[0] ?? target.descriptionMessageId;
            const updated = this.repository.applySaleStatus({
                productId: target.id,
                messageId: event.messageId,
                targetMessageId,
                status: saleStatus,
                rawContent: event.content,
                occurredAt: event.sentAt,
            });
            this.repository.linkMessage(
                target.id,
                event.messageAliases ?? [event.messageId],
                "sale_status",
                event.sentAt,
            );
            this.repository.enqueueExcelSync(target.id);
            if (materializedFromQuote && this.repository.getActiveProduct()?.id === target.id) {
                this.repository.completeActiveProduct(event.sentAt);
            }
            return this.repository.getProduct(updated.id) ?? updated;
        });
    }

    completeActive(completedAt: number): ProductRecord | null {
        return this.repository.runInTransaction(() => {
            const completed = this.repository.completeActiveProduct(completedAt);
            if (completed) this.repository.enqueueExcelSync(completed.id);
            return completed;
        });
    }

    private assertActiveGroup(groupId: string): void {
        if (groupId !== this.activeGroupId()) {
            throw new Error(`Event is not from active group: ${groupId}`);
        }
    }

    private assertPublisher(senderId: string): void {
        if (!this.publisherIds().includes(senderId)) {
            throw new Error(`Event is not from configured publisher: ${senderId}`);
        }
    }

    private activeGroupId(): string | null {
        return typeof this.options.activeGroupId === "function"
            ? this.options.activeGroupId()
            : this.options.activeGroupId;
    }

    private publisherIds(): string[] {
        const value = typeof this.options.publisherId === "function"
            ? this.options.publisherId()
            : this.options.publisherId;
        return Array.isArray(value) ? value : value ? [value] : [];
    }
}

const mapDescriptionToNewProduct = (
    event: NormalizedDescriptionEvent,
    parsed: LaptopParseResult,
    mediaRoot: string,
): NewProductRecord => {
    const id = deterministicId("product", event.messageId);
    const parsedFields = parsed.ok ? parsed.fields : {};

    return {
        id,
        groupId: event.groupId,
        groupName: event.groupName,
        descriptionMessageId: event.messageId,
        senderId: event.senderId,
        senderName: event.senderName,
        postedAt: event.sentAt,
        rawContent: event.content,
        ...parsedFields,
        notes: parsed.ok ? parsed.fields.notes : event.content,
        imageCount: 0,
        mediaDirectory: productMediaDirectory(mediaRoot, event.sentAt, id),
        heartCount: 0,
        saleStatus: "available",
        status: parsed.ok ? "receiving_images" : "needs_review",
        excelSyncStatus: "pending",
        createdAt: event.sentAt,
        updatedAt: event.sentAt,
    };
};

export const classifySaleStatus = (content: string): SaleStatus | null => {
    const normalized = content
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/đ/giu, "d")
        .toLocaleLowerCase("vi")
        .replace(/[^a-z0-9]+/gu, " ")
        .trim();
    if (!normalized) return null;
    if (/da ban 1 (?:chiec|may).*con 1/u.test(normalized)) return "partially_sold";
    if (/\b(?:da|dac) ban\b/u.test(normalized)) return "sold";
    if (/\bcoc\b/u.test(normalized) || /\bcho[ty]\b/u.test(normalized)) return "reserved";
    return null;
};

const BANGKOK_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
});

const productMediaDirectory = (mediaRoot: string, sentAt: number, productId: string): string => {
    const parts = BANGKOK_MONTH_FORMATTER.formatToParts(new Date(sentAt));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    if (!year || !month) throw new Error("Could not derive Asia/Bangkok product month");

    const monthDirectory = resolveDescendant(mediaRoot, `${year}-${month}`);
    return resolveDescendant(monthDirectory, productId);
};

const resolveDescendant = (root: string, child: string): string => {
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, child);
    const pathFromRoot = relative(resolvedRoot, candidate);
    if (
        pathFromRoot === "" ||
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathFromRoot)
    ) {
        throw new Error(`Resolved path escapes its root: ${candidate}`);
    }
    return candidate;
};

const deterministicId = (prefix: "product" | "media", messageId: string): string =>
    `${prefix}-${createHash("sha256").update(messageId, "utf8").digest("hex")}`;

const isDescriptionMessageConflict = (error: unknown): boolean =>
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message === "UNIQUE constraint failed: products.description_message_id";
