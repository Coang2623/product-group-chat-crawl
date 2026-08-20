import { useMemo, useState } from "react";
import type { ProductRecord } from "../../shared/domain.js";

type MediaMoveBarProps = {
    selectedCount: number;
    /** Every product except the one being viewed; the source is never a valid target. */
    candidates: ProductRecord[];
    moving: boolean;
    onMove(toProductId: string): void;
    onCancel(): void;
};

/**
 * Zalo supplies no album key, so photos sometimes land on the neighbouring machine.
 * This is the manual repair: pick the photos, search for the machine they belong to.
 */
export function MediaMoveBar({
    selectedCount,
    candidates,
    moving,
    onMove,
    onCancel,
}: MediaMoveBarProps) {
    const [query, setQuery] = useState("");
    const [targetId, setTargetId] = useState("");

    const matches = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase("vi");
        const pool = needle
            ? candidates.filter((product) => searchText(product).includes(needle))
            : candidates;
        return pool.slice(0, 30);
    }, [candidates, query]);

    // A target chosen before typing can fall out of the narrowed list, which would
    // otherwise move photos onto a machine no longer on screen.
    const effectiveTarget = matches.some((product) => product.id === targetId) ? targetId : "";

    return (
        <div className="media-move" role="group" aria-label="Chuyển ảnh sang máy khác">
            <div className="media-move__count">Đã chọn {selectedCount} ảnh</div>
            <input
                aria-label="Tìm máy nhận ảnh"
                placeholder="Tìm máy nhận ảnh…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            <select
                aria-label="Máy nhận ảnh"
                value={effectiveTarget}
                onChange={(event) => setTargetId(event.target.value)}
            >
                <option value="">— Chọn máy —</option>
                {matches.map((product) => (
                    <option key={product.id} value={product.id}>{optionLabel(product)}</option>
                ))}
            </select>
            <button
                className="button button--primary"
                disabled={!effectiveTarget || !selectedCount || moving}
                onClick={() => onMove(effectiveTarget)}
            >
                {moving ? "Đang chuyển…" : "Chuyển ảnh"}
            </button>
            <button className="button button--secondary" onClick={onCancel} disabled={moving}>
                Hủy
            </button>
        </div>
    );
}

const searchText = (product: ProductRecord): string =>
    [product.productName, product.cpu, product.ram, product.storage, product.rawContent]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("vi");

/** The image count matters most here: a machine with none is the likely destination. */
const optionLabel = (product: ProductRecord): string => {
    const name = product.productName?.trim() || "Chưa đặt tên";
    const posted = new Date(product.postedAt).toLocaleString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
    return `${name} · ${product.imageCount} ảnh · ${posted}`;
};
