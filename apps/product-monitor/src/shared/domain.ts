export type ProductStatus = "receiving_images" | "completed" | "needs_review";
export type ExcelSyncStatus = "pending" | "synced" | "blocked" | "failed";
export type SaleStatus = "available" | "closed";

export type ProductRecord = {
    id: string;
    groupId: string;
    groupName: string;
    descriptionMessageId: string;
    senderId: string;
    senderName?: string;
    postedAt: number;
    rawContent: string;
    productName?: string;
    brand?: string;
    model?: string;
    cpu?: string;
    ram?: string;
    storage?: string;
    gpu?: string;
    display?: string;
    condition?: string;
    price?: number;
    rawPrice?: string;
    notes?: string;
    imageCount: number;
    coverImagePath?: string;
    mediaDirectory: string;
    heartCount: number;
    saleStatus: SaleStatus;
    saleStatusMessageId?: string;
    saleStatusText?: string;
    saleStatusUpdatedAt?: number;
    status: ProductStatus;
    excelSyncStatus: ExcelSyncStatus;
    /** How many times this same machine was posted again after the first listing. */
    repostCount: number;
    lastPostedAt?: number;
    createdAt: number;
    updatedAt: number;
};

export type ProductMedia = {
    id: string;
    productId: string;
    sourceMessageId: string;
    /** Durable origin required to safely retry a failed download. */
    sourceUrl?: string;
    sequence: number;
    localPath?: string;
    checksum?: string;
    downloadStatus: "pending" | "downloaded" | "failed" | "duplicate";
    createdAt: number;
};

export type OrphanMedia = {
    messageId: string;
    groupId: string;
    senderId: string;
    sourceUrl?: string;
    sentAt: number;
    createdAt: number;
};

export type NewOrphanMedia = OrphanMedia;

export type ImageAttachmentQuery = {
    groupId: string;
    senderIds: string[];
    /** Images arriving more than this many ms after a description are not attached to it. */
    sentAt: number;
    windowMs: number;
};

export type ProductReaction = {
    productId: string;
    targetMessageId: string;
    userId: string;
    icon: string;
    active: boolean;
    updatedAt: number;
};

export type ExcelSyncJob = {
    productId: string;
    operation: "upsert";
    status: "pending" | "running" | "blocked" | "failed";
    attempts: number;
    lastError?: string;
    updatedAt: number;
};

export type NormalizedDescriptionEvent = {
    groupId: string;
    groupName: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    content: string;
    sentAt: number;
    /** All server/client IDs that can later be referenced by a Zalo quote. */
    targetMessageIds?: string[];
};

export type NormalizedImageEvent = {
    groupId: string;
    senderId: string;
    messageId: string;
    imageUrl: string;
    sentAt: number;
    targetMessageIds?: string[];
};

export type NormalizedSaleStatusEvent = {
    groupId: string;
    groupName?: string;
    senderId: string;
    targetSenderName?: string;
    messageId: string;
    targetMessageIds: string[];
    targetContent?: string;
    targetSentAt?: number;
    messageAliases?: string[];
    content: string;
    sentAt: number;
};

export type NormalizedReactionEvent = {
    groupId: string;
    targetMessageIds: string[];
    userId: string;
    icon: string;
    active: boolean;
    occurredAt: number;
    rType?: number;
};

export type NewProductRecord = ProductRecord;
export type NewProductMedia = ProductMedia;

export type ProductFilter = {
    groupId?: string;
    status?: ProductStatus;
    fromPostedAt?: number;
    toPostedAt?: number;
    limit?: number;
};

export type HeartStateInput = ProductReaction;

export type SaleStatusInput = {
    productId: string;
    messageId: string;
    targetMessageId: string;
    status: SaleStatus;
    rawContent: string;
    occurredAt: number;
};
