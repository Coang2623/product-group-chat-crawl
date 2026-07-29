import type { ProductMonitorEvent } from "../shared/api.js";
import type { ProductMedia, ProductRecord } from "../shared/domain.js";

export type GroupSummary = { id: string; name: string; adminIds: string[] };
export type MonitorStatus = {
    connection: string;
    activeGroupId: string | null;
    activeProductId: string | null;
    excel: { pending: number; blocked: boolean; lastError?: string };
};
export type ProductDetail = { product: ProductRecord; media: ProductMedia[] };

export interface ProductMonitorApi {
    getStatus(): Promise<MonitorStatus>;
    getGroups(): Promise<GroupSummary[]>;
    selectGroup(groupId: string): Promise<void>;
    beginQrLogin(): Promise<void>;
    getProducts(): Promise<ProductRecord[]>;
    getProduct(id: string): Promise<ProductDetail>;
    completeProduct(id: string): Promise<ProductRecord>;
    syncExcel(): Promise<{ synced: number; blocked: number; failed: number }>;
    subscribe(handler: (event: ProductMonitorEvent) => void): () => void;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(path, {
        ...init,
        headers: init?.body
            ? { "Content-Type": "application/json", ...init.headers }
            : init?.headers,
    });
    if (!response.ok) {
        const body = await response.json().catch(() => null) as {
            error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
};

export const browserApi: ProductMonitorApi = {
    getStatus: () => request<MonitorStatus>("/api/status"),
    getGroups: async () => (await request<{ groups: GroupSummary[] }>("/api/groups")).groups,
    selectGroup: (groupId) => request<void>("/api/settings/active-group", {
        method: "PUT",
        body: JSON.stringify({ groupId }),
    }),
    beginQrLogin: () => request<void>("/api/auth/qr", { method: "POST" }),
    getProducts: async () => (await request<{ products: ProductRecord[] }>("/api/products")).products,
    getProduct: (id) => request<ProductDetail>(`/api/products/${encodeURIComponent(id)}`),
    completeProduct: async (id) => (
        await request<{ product: ProductRecord }>(
            `/api/products/${encodeURIComponent(id)}/complete`,
            { method: "POST" },
        )
    ).product,
    syncExcel: () => request("/api/excel/sync", { method: "POST" }),
    subscribe: (handler) => {
        const source = new EventSource("/api/events");
        source.onmessage = (event) => {
            try {
                handler(JSON.parse(event.data) as ProductMonitorEvent);
            } catch {
                // Ignore malformed local events and keep the stream alive.
            }
        };
        return () => source.close();
    },
};
