import type { ProductRecord } from "../shared/domain.js";

const MARKUP_STORAGE_KEY = "zaloMonitor.markupPercent";
const DEFAULT_MARKUP_PERCENT = 10;
/** Sale prices are quoted in whole steps, not to the dong. */
const PRICE_ROUNDING = 100_000;

// Storage may be absent, stubbed, or throw when access is blocked; a saved preference
// is never worth failing a render over.
export const loadMarkupPercent = (storage: Partial<Storage> | undefined): number => {
    try {
        if (typeof storage?.getItem !== "function") return DEFAULT_MARKUP_PERCENT;
        const stored = Number(storage.getItem(MARKUP_STORAGE_KEY));
        return isValidMarkup(stored) ? stored : DEFAULT_MARKUP_PERCENT;
    } catch {
        return DEFAULT_MARKUP_PERCENT;
    }
};

export const saveMarkupPercent = (
    storage: Partial<Storage> | undefined,
    percent: number,
): void => {
    try {
        if (!isValidMarkup(percent) || typeof storage?.setItem !== "function") return;
        storage.setItem(MARKUP_STORAGE_KEY, String(percent));
    } catch {
        // Preference persistence is best effort.
    }
};

export const isValidMarkup = (percent: number): boolean =>
    Number.isFinite(percent) && percent >= 0 && percent <= 100;

/**
 * The shop's "giá thu về" is what it must receive; the collaborator adds a markup on
 * top and keeps the difference. Rounded up so the quote never falls below that floor.
 */
export const sellingPrice = (basePrice: number | undefined, markupPercent: number): number | undefined => {
    if (basePrice === undefined || !isValidMarkup(markupPercent)) return undefined;
    const raw = basePrice * (1 + markupPercent / 100);
    return Math.ceil(raw / PRICE_ROUNDING) * PRICE_ROUNDING;
};

export const commission = (basePrice: number | undefined, markupPercent: number): number | undefined => {
    const selling = sellingPrice(basePrice, markupPercent);
    return selling === undefined || basePrice === undefined ? undefined : selling - basePrice;
};

export const formatDong = (value: number | undefined): string =>
    value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;

/**
 * Structured specs for handing to a copywriting assistant. It carries only facts the
 * parser is confident about, plus the original post, so the assistant never has to
 * guess a spec -- and never sees the shop's internal "giá thu về".
 */
export const specsForCopywriting = (product: ProductRecord, markupPercent: number): string => {
    const specs: Array<[string, string | undefined]> = [
        ["Tên máy", product.productName],
        ["CPU", product.cpu],
        ["RAM", product.ram],
        ["Ổ cứng", product.storage],
        ["Card/GPU", product.gpu],
        ["Màn hình", product.display],
        ["Tình trạng", product.condition],
        ["Giá bán", formatDongOrUndefined(sellingPrice(product.price, markupPercent))],
        ["Số ảnh", product.imageCount ? String(product.imageCount) : undefined],
    ];

    const lines = specs
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([label, value]) => `- ${label}: ${value}`);

    return [
        "Thông tin máy:",
        ...lines,
        "",
        "Nguyên văn bài đăng gốc:",
        product.rawContent.trim(),
    ].join("\n");
};

const formatDongOrUndefined = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : formatDong(value);
