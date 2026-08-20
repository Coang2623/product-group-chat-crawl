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

/**
 * Publishers post a burst of descriptions seconds apart, then send photos for them.
 * Images are therefore attached to the newest description within this window rather
 * than only to a single open draft, which the burst would have already closed.
 */
export const DEFAULT_IMAGE_ATTACHMENT_WINDOW_MS = 15 * 60 * 1000;

/**
 * A draft is only closed by the next description, so the last product of a posting
 * session stays "receiving images" until the group posts again — possibly for days.
 * Once no image can still join it, it is finished in practice.
 */
export const DEFAULT_IDLE_DRAFT_TIMEOUT_MS = DEFAULT_IMAGE_ATTACHMENT_WINDOW_MS;

/**
 * A machine that did not sell is re-listed hours or days later. Identical text within
 * the same posting session is instead two machines of the same model, or a double-send,
 * so only a repost separated by this much time folds into the original row.
 */
export const DEFAULT_REPOST_MIN_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Publishers sometimes send a machine's photos and only then its description. Those
 * images land on whichever product was open, so a description reclaims images posted
 * in the moments just before it. Kept short: a real gap means the images belong to
 * the previous machine, which is the common ordering.
 */
export const DEFAULT_LEADING_IMAGE_WINDOW_MS = 60 * 1000;

export type ProductCoordinatorOptions = {
    activeGroupId: string | (() => string | null);
    publisherId: string | (() => string | string[] | null);
    mediaRoot: string;
    imageAttachmentWindowMs?: number;
    idleDraftTimeoutMs?: number;
    repostMinimumGapMs?: number;
    leadingImageWindowMs?: number;
};

/** Either the products a manual move touched, or why it could not be made. */
export type MediaMoveResult =
    | { moved: number; products: ProductRecord[] }
    | "unknown_product"
    | "unknown_media";

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
                const previous = this.repository.getActiveProduct();
                const completed = this.repository.completeActiveProduct(event.sentAt);
                if (completed) this.repository.enqueueExcelSync(completed.id);

                // An unsold machine is posted again word for word. Counting it as a new
                // product would inflate the Excel row count above the real stock.
                const repostTarget = this.findRepost(event);
                if (repostTarget) {
                    const updated = this.repository.recordRepost(repostTarget.id, event.sentAt);
                    this.repository.linkMessage(
                        updated.id,
                        event.targetMessageIds ?? [event.messageId],
                        "description",
                        event.sentAt,
                    );
                    this.repository.enqueueExcelSync(updated.id);
                    return updated;
                }

                const parsed = parseLaptopPost(event.content);
                const product = this.repository.createProduct(
                    mapDescriptionToNewProduct(event, parsed, this.options.mediaRoot),
                );
                this.repository.linkMessage(product.id, event.targetMessageIds ?? [event.messageId], "description", event.sentAt);
                this.repository.enqueueExcelSync(product.id);
                return this.reclaimLeadingImages(previous, product, event.sentAt);
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
            const target = this.resolveImageTarget(event.sentAt);
            if (!target) {
                this.repository.recordOrphanMedia({
                    messageId: event.messageId,
                    groupId: event.groupId,
                    senderId: event.senderId,
                    sourceUrl: event.imageUrl,
                    sentAt: event.sentAt,
                    createdAt: event.sentAt,
                });
                return "orphan";
            }

            const media = this.repository.addMedia({
                id: deterministicId("media", event.messageId),
                productId: target.id,
                sourceMessageId: event.messageId,
                sourceUrl: event.imageUrl,
                sequence: this.repository.listMedia(target.id).length + 1,
                downloadStatus: "pending",
                createdAt: event.sentAt,
            });
            this.repository.linkMessage(target.id, event.targetMessageIds ?? [event.messageId], "image", event.sentAt);
            this.repository.enqueueExcelSync(target.id);
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

    /**
     * Closes the open draft once it has been idle past the attachment window, so the
     * final product of a posting session does not sit in "receiving images" forever.
     * The timeout matches the image window: past it, no image would attach anyway.
     */
    completeIdleDraft(now: number): ProductRecord | null {
        const timeout = this.options.idleDraftTimeoutMs ?? DEFAULT_IDLE_DRAFT_TIMEOUT_MS;
        return this.repository.runInTransaction(() => {
            const active = this.repository.getActiveProduct();
            if (!active) return null;

            const media = this.repository.listMedia(active.id);
            const lastActivity = Math.max(
                active.postedAt,
                ...media.map((item) => item.createdAt),
            );
            if (now - lastActivity < timeout) return null;

            const completed = this.repository.completeActiveProduct(now);
            if (completed) this.repository.enqueueExcelSync(completed.id);
            return completed;
        });
    }

    /**
     * Moves images between machines by hand. Zalo sends photos and descriptions in no
     * fixed order and supplies no album key, so automatic attachment is a best guess
     * that sometimes lands photos on the neighbouring machine; this is the repair.
     * Returns both affected products so the caller can refresh either side.
     */
    moveMedia(mediaIds: string[], toProductId: string): MediaMoveResult {
        return this.repository.runInTransaction(() => {
            const target = this.repository.getProduct(toProductId);
            if (!target) return "unknown_product";

            const media = mediaIds.map((id) => this.repository.getMedia(id));
            if (media.some((item) => item === null)) return "unknown_media";

            const sources = new Set(
                media
                    .map((item) => item!.productId)
                    .filter((productId) => productId !== toProductId),
            );
            // Nothing actually moves, so skip the churn of a rewrite and a sync job.
            if (!sources.size) return { moved: 0, products: [target] };

            this.repository.reassignMedia(mediaIds, toProductId);
            const touched = [...sources, toProductId];
            for (const productId of touched) {
                this.repository.updateProductMediaSummary(productId);
                this.repository.enqueueExcelSync(productId);
            }
            return {
                moved: mediaIds.length,
                products: touched
                    .map((productId) => this.repository.getProduct(productId))
                    .filter((product): product is ProductRecord => product !== null),
            };
        });
    }

    completeActive(completedAt: number): ProductRecord | null {
        return this.repository.runInTransaction(() => {
            const completed = this.repository.completeActiveProduct(completedAt);
            if (completed) this.repository.enqueueExcelSync(completed.id);
            return completed;
        });
    }

    /**
     * Prefers the open draft, then falls back to the newest recent description from a
     * configured publisher. Without the fallback every burst-posted product loses its
     * photos, because the next description closes the draft within seconds.
     */
    /**
     * Moves images that arrived immediately before this description onto it. Publishers
     * sometimes send a machine's photos first, and those images would otherwise stay on
     * the previous machine, leaving this one with none and that one with a double set.
     */
    private reclaimLeadingImages(
        previous: ProductRecord | null,
        product: ProductRecord,
        describedAt: number,
    ): ProductRecord {
        if (!previous || previous.id === product.id) return product;
        const window = this.options.leadingImageWindowMs ?? DEFAULT_LEADING_IMAGE_WINDOW_MS;
        const all = this.repository.listMedia(previous.id);
        const leading = all.filter((media) =>
            media.createdAt >= describedAt - window && media.createdAt <= describedAt);
        // Everything the previous machine has arrived in this window, so there is no
        // evidence these photos are not simply its own; leave them where they are.
        if (!leading.length || leading.length >= all.length) return product;

        this.repository.reassignMedia(leading.map((media) => media.id), product.id);
        this.repository.updateProductMediaSummary(previous.id);
        this.repository.updateProductMediaSummary(product.id);
        this.repository.enqueueExcelSync(previous.id);
        this.repository.enqueueExcelSync(product.id);
        return this.repository.getProduct(product.id) ?? product;
    }

    /** The same machine re-listed later, as opposed to a second unit posted right now. */
    private findRepost(event: NormalizedDescriptionEvent): ProductRecord | null {
        const minimumGap = this.options.repostMinimumGapMs ?? DEFAULT_REPOST_MIN_GAP_MS;
        const candidate = this.repository.findRepostTarget(event.groupId, event.content);
        if (!candidate) return null;
        const lastPostedAt = candidate.lastPostedAt ?? candidate.postedAt;
        return event.sentAt - lastPostedAt >= minimumGap ? candidate : null;
    }

    private resolveImageTarget(sentAt: number): ProductRecord | null {
        const groupId = this.activeGroupId();
        const publisherIds = this.publisherIds();
        if (!groupId || !publisherIds.length) return null;

        const active = this.repository.getActiveProduct();
        if (active && active.groupId === groupId && publisherIds.includes(active.senderId)) return active;

        return this.repository.findImageAttachmentTarget({
            groupId,
            senderIds: publisherIds,
            sentAt,
            windowMs: this.options.imageAttachmentWindowMs ?? DEFAULT_IMAGE_ATTACHMENT_WINDOW_MS,
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
        repostCount: 0,
        saleStatus: "available",
        status: parsed.ok ? "receiving_images" : "needs_review",
        excelSyncStatus: "pending",
        createdAt: event.sentAt,
        updatedAt: event.sentAt,
    };
};

export const classifySaleStatus = (content: string): SaleStatus | null => {
    const lowered = content.toLocaleLowerCase("vi");
    if (["cọc", "bán", "chốt"].some((keyword) => lowered.includes(keyword))) return "closed";

    const asciiTokens = lowered.match(/\p{L}+/gu)?.filter((token) => token === token
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/đ/giu, "d")) ?? [];
    return asciiTokens.some((token) => ["coc", "ban", "chot"].includes(token))
        ? "closed"
        : null;
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
