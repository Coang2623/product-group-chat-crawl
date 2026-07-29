import type { ProductRecord } from "./domain.js";

export type ProductMonitorEvent =
    | { type: "product.created"; product: ProductRecord }
    | { type: "product.updated"; product: ProductRecord }
    | { type: "excel.status"; pending: number; blocked: boolean; lastError?: string }
    | { type: "connection.status"; state: "connected" | "reconnecting" | "disconnected" }
    | { type: "auth.qr"; image?: string; state: string };

export type ApiErrorBody = {
    error: {
        code: string;
        message: string;
    };
};
