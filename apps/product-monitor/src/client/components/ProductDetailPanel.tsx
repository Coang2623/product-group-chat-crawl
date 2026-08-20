import { useEffect, useState } from "react";
import type { ProductRecord } from "../../shared/domain.js";
import type { ProductDetail } from "../api.js";
import { commission, formatDong, sellingPrice, specsForCopywriting } from "../selling.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { MediaMoveBar } from "./MediaMoveBar.js";

type ProductDetailPanelProps = {
    detail: ProductDetail;
    completing: boolean;
    moving: boolean;
    markupPercent: number;
    moveCandidates: ProductRecord[];
    onClose(): void;
    onComplete(): void;
    onMoveMedia(mediaIds: string[], toProductId: string): Promise<boolean>;
};

export function ProductDetailPanel({
    detail,
    completing,
    moving,
    markupPercent,
    moveCandidates,
    onClose,
    onComplete,
    onMoveMedia,
}: ProductDetailPanelProps) {
    const { product, media } = detail;
    const downloaded = media.filter((item) => item.downloadStatus === "downloaded");
    const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [selecting, setSelecting] = useState(false);

    // Images stream in while a product is still receiving them, so a stored index can
    // outlive the image it pointed at.
    useEffect(() => {
        setZoomedIndex((current) => (current === null || current < downloaded.length ? current : null));
    }, [downloaded.length]);

    // Switching machines must not carry a selection onto a gallery it does not belong to.
    useEffect(() => {
        setSelectedIds([]);
        setSelecting(false);
    }, [product.id]);

    const toggle = (id: string) => setSelectedIds((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

    const moveSelected = async (toProductId: string) => {
        if (await onMoveMedia(selectedIds, toProductId)) {
            setSelectedIds([]);
            setSelecting(false);
        }
    };

    return (
        <aside className="detail-panel" aria-label="Chi tiết sản phẩm">
            <header>
                <div><strong>{product.productName ?? "Sản phẩm cần kiểm tra"}</strong><small>{statusLabel(product.status)}</small></div>
                <button className="icon-button" aria-label="Đóng chi tiết" onClick={onClose}>×</button>
            </header>
            <div className="detail-panel__body">
                <div className={selecting ? "gallery gallery--selecting" : "gallery"}>
                    {downloaded.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            className={selectedIds.includes(item.id) ? "gallery__item is-selected" : "gallery__item"}
                            aria-label={selecting ? `Chọn ảnh ${index + 1}` : `Phóng to ảnh ${index + 1}`}
                            aria-pressed={selecting ? selectedIds.includes(item.id) : undefined}
                            onClick={() => (selecting ? toggle(item.id) : setZoomedIndex(index))}
                        >
                            <img
                                src={`/api/media/${encodeURIComponent(item.id)}`}
                                alt={`Ảnh sản phẩm ${index + 1}`}
                            />
                            {selecting && <span className="gallery__tick" aria-hidden="true">✓</span>}
                        </button>
                    ))}
                    {!downloaded.length && (
                        <div className="gallery__empty">Chưa tải được ảnh</div>
                    )}
                </div>
                {Boolean(downloaded.length) && !selecting && (
                    <button className="button button--ghost" onClick={() => setSelecting(true)}>
                        Chuyển ảnh sang máy khác
                    </button>
                )}
                {selecting && (
                    <MediaMoveBar
                        selectedCount={selectedIds.length}
                        candidates={moveCandidates}
                        moving={moving}
                        onMove={(toProductId) => void moveSelected(toProductId)}
                        onCancel={() => {
                            setSelectedIds([]);
                            setSelecting(false);
                        }}
                    />
                )}
                {zoomedIndex !== null && (
                    <ImageLightbox
                        images={downloaded.map((item, index) => ({
                            id: item.id,
                            label: `Ảnh sản phẩm ${index + 1}`,
                        }))}
                        index={zoomedIndex}
                        onIndexChange={setZoomedIndex}
                        onClose={() => setZoomedIndex(null)}
                    />
                )}
                <section className="selling-box">
                    <div className="section-heading"><span>BÁN HÀNG</span><b>+{markupPercent}%</b></div>
                    <dl className="mapped-fields">
                        <div><dt>Giá thu về</dt><dd>{formatDong(product.price)}</dd></div>
                        <div><dt>Giá bán</dt><dd className="selling-box__price">{formatDong(sellingPrice(product.price, markupPercent))}</dd></div>
                        <div><dt>Hoa hồng</dt><dd>{formatDong(commission(product.price, markupPercent))}</dd></div>
                    </dl>
                    <div className="selling-box__actions">
                        <CopyButton
                            label="Copy cấu hình cho AI"
                            copiedLabel="Đã copy cấu hình"
                            text={() => specsForCopywriting(product, markupPercent)}
                        />
                        <a
                            className="button button--secondary"
                            href={`/api/products/${encodeURIComponent(product.id)}/images.zip`}
                        >
                            Tải {downloaded.length} ảnh
                        </a>
                    </div>
                </section>
                <section>
                    <div className="section-heading"><span>DỮ LIỆU ĐÃ MAP</span><b>{product.status === "needs_review" ? "CẦN KIỂM TRA" : "PARSER OK"}</b></div>
                    <dl className="mapped-fields">
                        {[
                            ["CPU", product.cpu],
                            ["RAM", product.ram],
                            ["Ổ cứng", product.storage],
                            ["GPU", product.gpu],
                            ["Màn hình", product.display],
                            ["Giá", product.price && `${new Intl.NumberFormat("vi-VN").format(product.price)} ₫`],
                        ].map(([label, value]) => value && (
                            <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>
                        ))}
                    </dl>
                </section>
                {product.notes && <section><h3>Ghi chú</h3><p>{product.notes}</p></section>}
                <section>
                    <h3>Trạng thái bán</h3>
                    <p>{saleLabel(product.saleStatus)}</p>
                    {product.saleStatusText && <small>Cập nhật từ reply: “{product.saleStatusText}”</small>}
                </section>
                <section className="raw-content"><h3>Nội dung gốc</h3><p>{product.rawContent}</p></section>
                <section><h3>Message ID</h3><code>{product.descriptionMessageId}</code></section>
                <section><h3>Lịch sử đồng bộ</h3><p>{excelLabel(product.excelSyncStatus)}</p></section>
            </div>
            <footer>
                <a className="button button--secondary" href={`file:///${product.mediaDirectory.replaceAll("\\", "/")}`}>Mở thư mục ảnh</a>
                {product.status === "receiving_images" && (
                    <button
                        className="button button--primary"
                        aria-label="Kết thúc nhận ảnh"
                        onClick={onComplete}
                        disabled={completing}
                    >
                        {completing ? "Đang kết thúc…" : "Kết thúc nhận ảnh"}
                    </button>
                )}
            </footer>
        </aside>
    );
}

function CopyButton({ label, copiedLabel, text }: {
    label: string;
    copiedLabel: string;
    text(): string;
}) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 2_000);
        return () => clearTimeout(timer);
    }, [copied]);

    return (
        <button
            className="button button--primary"
            onClick={() => void copyText(text()).then(setCopied)}
        >
            {copied ? copiedLabel : label}
        </button>
    );
}

/** navigator.clipboard needs a secure context, which plain http://127.0.0.1 may not be. */
const copyText = async (value: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(value);
        return true;
    } catch {
        return copyViaTextarea(value);
    }
};

const copyViaTextarea = (value: string): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        textarea.remove();
    }
};

const statusLabel = (status: string) => ({
    receiving_images: "Đang nhận ảnh · realtime",
    completed: "Hoàn tất",
    needs_review: "Cần kiểm tra parser",
}[status] ?? status);
const saleLabel = (status: string) => ({
    available: "Còn hàng",
    closed: "Đã chốt",
}[status] ?? status);
const excelLabel = (status: string) => ({
    pending: "Thay đổi đang chờ ghi vào workbook.",
    synced: "Dữ liệu đã đồng bộ.",
    blocked: "Excel đang mở; tác vụ được giữ lại.",
    failed: "Đồng bộ lỗi; có thể thử lại.",
}[status] ?? status);
