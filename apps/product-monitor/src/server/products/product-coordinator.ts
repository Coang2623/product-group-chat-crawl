import { join } from "node:path";
import type {
    NewProductRecord,
    NormalizedDescriptionEvent,
    NormalizedImageEvent,
    ProductMedia,
    ProductRecord,
} from "../../shared/domain.js";
import type { ProductRepository } from "../db/product-repository.js";
import { parseLaptopPost, type LaptopParseResult } from "../parser/laptop-parser.js";

export type ProductCoordinatorOptions = {
    activeGroupId: string;
    publisherId: string;
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
        if (existing) return existing;

        return this.repository.runInTransaction(() => {
            const completed = this.repository.completeActiveProduct(event.sentAt);
            if (completed) this.repository.enqueueExcelSync(completed.id);

            const parsed = parseLaptopPost(event.content);
            const product = this.repository.createProduct(
                mapDescriptionToNewProduct(event, parsed, this.options.mediaRoot),
            );
            this.repository.enqueueExcelSync(product.id);
            return product;
        });
    }

    handleImage(event: NormalizedImageEvent): ProductMedia | "orphan" {
        this.assertActiveGroup(event.groupId);
        this.assertPublisher(event.senderId);

        return this.repository.runInTransaction(() => {
            const active = this.repository.getActiveProduct();
            if (!active) return "orphan";
            if (active.groupId !== this.options.activeGroupId || active.senderId !== this.options.publisherId) {
                return "orphan";
            }

            const media = this.repository.addMedia({
                id: `media-${event.messageId}`,
                productId: active.id,
                sourceMessageId: event.messageId,
                sequence: this.repository.listMedia(active.id).length + 1,
                downloadStatus: "pending",
                createdAt: event.sentAt,
            });
            this.repository.enqueueExcelSync(active.id);
            return media;
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
        if (groupId !== this.options.activeGroupId) {
            throw new Error(`Event is not from active group: ${groupId}`);
        }
    }

    private assertPublisher(senderId: string): void {
        if (senderId !== this.options.publisherId) {
            throw new Error(`Event is not from configured publisher: ${senderId}`);
        }
    }
}

const mapDescriptionToNewProduct = (
    event: NormalizedDescriptionEvent,
    parsed: LaptopParseResult,
    mediaRoot: string,
): NewProductRecord => {
    const id = `product-${event.messageId}`;
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
        mediaDirectory: join(mediaRoot, new Date(event.sentAt).toISOString().slice(0, 7), id),
        heartCount: 0,
        status: parsed.ok ? "receiving_images" : "needs_review",
        excelSyncStatus: "pending",
        createdAt: event.sentAt,
        updatedAt: event.sentAt,
    };
};
