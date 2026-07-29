import type {
    NormalizedReactionEvent,
    ProductRecord,
} from "../../shared/domain.js";
import type { ProductRepository } from "../db/product-repository.js";

export type ReactionAggregatorOptions = {
    activeGroupId: string;
    onIgnored?: (
        reason: "inactive_group" | "unmapped_message",
        event: NormalizedReactionEvent,
        targetMessageId?: string,
    ) => void;
};

export const isHeart = (icon: string, rType?: number): boolean =>
    icon === "/-heart" || rType === 5;

/**
 * Projects raw reaction state into a unique-user heart count for each product.
 * SQLite remains authoritative, so replay after reconnect is safe.
 */
export class ReactionAggregator {
    public constructor(
        private readonly repository: ProductRepository,
        private readonly options: ReactionAggregatorOptions,
    ) {}

    apply(event: NormalizedReactionEvent): ProductRecord[] {
        if (event.groupId !== this.options.activeGroupId) {
            this.reportIgnored("inactive_group", event);
            return [];
        }

        return this.repository.runInTransaction(() => {
            const affectedProducts = new Map<string, ProductRecord>();
            const seenTargets = new Set<string>();
            const canonicalIcon = isHeart(event.icon, event.rType) ? "/-heart" : event.icon;

            for (const targetMessageId of event.targetMessageIds) {
                if (!targetMessageId || seenTargets.has(targetMessageId)) continue;
                seenTargets.add(targetMessageId);

                const product = this.repository.getProductByTargetMessageId(targetMessageId);
                if (!product || product.groupId !== this.options.activeGroupId) {
                    this.reportIgnored("unmapped_message", event, targetMessageId);
                    continue;
                }

                this.repository.setHeartState({
                    productId: product.id,
                    targetMessageId,
                    userId: event.userId,
                    icon: canonicalIcon,
                    active: event.active,
                    updatedAt: event.occurredAt,
                });
                affectedProducts.set(product.id, product);
            }

            const updated: ProductRecord[] = [];
            for (const product of affectedProducts.values()) {
                const heartCount = this.repository.countUniqueHearts(product.id);
                updated.push(this.repository.updateHeartCount(product.id, heartCount));
                this.repository.enqueueExcelSync(product.id);
            }
            return updated;
        });
    }

    private reportIgnored(
        reason: "inactive_group" | "unmapped_message",
        event: NormalizedReactionEvent,
        targetMessageId?: string,
    ): void {
        try {
            this.options.onIgnored?.(reason, event, targetMessageId);
        } catch {
            // Diagnostics must never interrupt read-only reaction ingestion.
        }
    }
}
