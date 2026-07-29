import type { ProductDetail } from "../api.js";

type ProductDetailPanelProps = {
    detail: ProductDetail;
    completing: boolean;
    onClose(): void;
    onComplete(): void;
};

export function ProductDetailPanel({
    detail,
    completing,
    onClose,
    onComplete,
}: ProductDetailPanelProps) {
    const { product, media } = detail;
    return (
        <aside className="detail-panel" aria-label="Chi tiết sản phẩm">
            <header>
                <div><strong>{product.productName ?? "Sản phẩm cần kiểm tra"}</strong><small>{statusLabel(product.status)}</small></div>
                <button className="icon-button" aria-label="Đóng chi tiết" onClick={onClose}>×</button>
            </header>
            <div className="detail-panel__body">
                <div className="gallery">
                    {media.filter((item) => item.downloadStatus === "downloaded").map((item, index) => (
                        <img
                            key={item.id}
                            src={`/api/media/${encodeURIComponent(item.id)}`}
                            alt={`Ảnh sản phẩm ${index + 1}`}
                        />
                    ))}
                    {!media.some((item) => item.downloadStatus === "downloaded") && (
                        <div className="gallery__empty">Chưa tải được ảnh</div>
                    )}
                </div>
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

const statusLabel = (status: string) => ({
    receiving_images: "Đang nhận ảnh · realtime",
    completed: "Hoàn tất",
    needs_review: "Cần kiểm tra parser",
}[status] ?? status);
const excelLabel = (status: string) => ({
    pending: "Thay đổi đang chờ ghi vào workbook.",
    synced: "Dữ liệu đã đồng bộ.",
    blocked: "Excel đang mở; tác vụ được giữ lại.",
    failed: "Đồng bộ lỗi; có thể thử lại.",
}[status] ?? status);
