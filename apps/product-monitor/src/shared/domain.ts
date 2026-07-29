export type ProductStatus = "receiving_images" | "completed" | "needs_review";
export type ExcelSyncStatus = "pending" | "synced" | "blocked" | "failed";

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
    status: ProductStatus;
    excelSyncStatus: ExcelSyncStatus;
    createdAt: number;
    updatedAt: number;
};

export type ProductMedia = {
    id: string;
    productId: string;
    sourceMessageId: string;
    sequence: number;
    localPath?: string;
    checksum?: string;
    downloadStatus: "pending" | "downloaded" | "failed";
    createdAt: number;
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
};

export type NormalizedImageEvent = {
    groupId: string;
    senderId: string;
    messageId: string;
    imageUrl: string;
    sentAt: number;
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
