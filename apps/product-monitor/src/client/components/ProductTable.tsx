import type { ProductRecord } from "../../shared/domain.js";

type ProductTableProps = {
    products: ProductRecord[];
    selectedId?: string;
    onSelect(product: ProductRecord): void;
};

export function ProductTable({ products, selectedId, onSelect }: ProductTableProps) {
    return (
        <section className="table-card">
            <header className="table-card__header">
                <div><strong>{products.length} sản phẩm</strong><span> · cập nhật tại chỗ</span></div>
                <span>Đang nhận ảnh trước ↕</span>
            </header>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>Ảnh</th>
                            <th>Thời gian</th>
                            <th>Sản phẩm</th>
                            <th>Cấu hình</th>
                            <th>Giá</th>
                            <th>Ảnh / Tym</th>
                            <th>Bán hàng</th>
                            <th>Xử lý</th>
                            <th>Excel</th>
                            <th><span className="sr-only">Thao tác</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {products.map((product) => (
                            <tr key={product.id} className={selectedId === product.id ? "is-selected" : ""}>
                                <td>
                                    {product.coverImagePath
                                        ? <img className="cover" src={productCover(product)} alt="" />
                                        : <span className="cover cover--empty">▱</span>}
                                </td>
                                <td><time>{formatTime(product.postedAt)}</time><small>{formatDate(product.postedAt)}</small></td>
                                <td><strong>{product.productName ?? "Chưa nhận diện"}</strong><small>{shortId(product.descriptionMessageId)}</small></td>
                                <td>{[product.cpu, product.ram, product.storage].filter(Boolean).join(" · ") || "Giữ nội dung gốc"}</td>
                                <td className="price">{formatPrice(product.price)}</td>
                                <td>{product.imageCount} ảnh · {product.heartCount} tym</td>
                                <td><SaleBadge status={product.saleStatus} /></td>
                                <td><StatusBadge status={product.status} /></td>
                                <td><ExcelBadge status={product.excelSyncStatus} /></td>
                                <td>
                                    <button
                                        className="icon-button"
                                        aria-label={`Xem chi tiết ${product.productName ?? "sản phẩm"}`}
                                        onClick={() => onSelect(product)}
                                    >→</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!products.length && (
                    <div className="empty-table">
                        <span>▦</span>
                        <strong>Chưa có sản phẩm phù hợp</strong>
                        <p>Dòng mới sẽ xuất hiện ngay khi admin gửi mô tả laptop.</p>
                    </div>
                )}
            </div>
        </section>
    );
}

function SaleBadge({ status }: { status: ProductRecord["saleStatus"] }) {
    const label = {
        available: "Còn hàng",
        closed: "Đã chốt",
    }[status];
    return <span className={`badge badge--sale-${status}`}>{label}</span>;
}

function StatusBadge({ status }: { status: ProductRecord["status"] }) {
    const label = {
        receiving_images: "Đang nhận ảnh",
        completed: "Hoàn tất",
        needs_review: "Cần kiểm tra",
    }[status];
    return <span className={`badge badge--${status}`}>{label}</span>;
}

function ExcelBadge({ status }: { status: ProductRecord["excelSyncStatus"] }) {
    const label = { pending: "Chờ Excel", synced: "Đã sync", blocked: "Bị khóa", failed: "Lỗi sync" }[status];
    return <span className={`badge badge--excel-${status}`}>{label}</span>;
}

const productCover = (product: ProductRecord) => `/api/products/${encodeURIComponent(product.id)}/cover`;
const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 9)}…` : id;
const formatPrice = (price?: number) => price === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(price)} ₫`;
const formatTime = (timestamp: number) => new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok",
}).format(timestamp);
const formatDate = (timestamp: number) => new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", timeZone: "Asia/Bangkok",
}).format(timestamp);
