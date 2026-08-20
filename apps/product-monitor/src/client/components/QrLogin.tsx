type QrLoginProps = {
    image?: string;
    state?: string;
    busy: boolean;
    /** Credentials are still valid; only the connection to Zalo is down. */
    offline?: boolean;
    onBegin(): void;
};

export function QrLogin({ image, state, busy, offline, onBegin }: QrLoginProps) {
    const qrSource = image && (image.startsWith("data:")
        ? image
        : `data:image/png;base64,${image}`);
    return (
        <main className="auth-shell">
            <section className="auth-story" aria-label="Giới thiệu chế độ chỉ đọc">
                <div className="brand brand--inverse">
                    <span className="brand__mark">▦</span>
                    <span>Zalo Group Monitor<small>LOCAL · READ ONLY</small></span>
                </div>
                <div>
                    <p className="eyebrow">REAL-TIME PRODUCT INTELLIGENCE</p>
                    <h1>Theo dõi sản phẩm Zalo,<br />không can thiệp cuộc trò chuyện.</h1>
                    <p>Mô tả, ảnh và tym được lưu cục bộ trước khi đồng bộ an toàn sang Excel.</p>
                </div>
                <p className="privacy-line">◈ Không gửi seen, reaction hoặc tin nhắn</p>
            </section>
            <section className="auth-stage">
                <div className="auth-card">
                    <p className="eyebrow">ĐĂNG NHẬP CỤC BỘ</p>
                    <h2>Kết nối tài khoản Zalo</h2>
                    {offline ? (
                        <p role="status" className="auth-notice">
                            Phiên đăng nhập vẫn còn hiệu lực nhưng không kết nối được tới Zalo.
                            Kiểm tra mạng — công cụ sẽ tự thử lại, bạn chưa cần quét mã.
                        </p>
                    ) : (
                        <p>Mở Zalo trên điện thoại và quét mã để bắt đầu.</p>
                    )}
                    {qrSource ? (
                        <img className="qr-image" src={qrSource} alt="Mã QR đăng nhập Zalo" />
                    ) : (
                        <div className="qr-placeholder" aria-hidden="true">⌗</div>
                    )}
                    {state && <span className="state-pill">{stateLabel(state)}</span>}
                    <button className="button button--primary" onClick={onBegin} disabled={busy}>
                        {busy ? "Đang tạo mã…" : "Tạo mã QR đăng nhập"}
                    </button>
                    <ol className="auth-steps">
                        <li>Mở ứng dụng Zalo trên điện thoại</li>
                        <li>Chọn biểu tượng quét mã QR</li>
                        <li>Xác nhận đăng nhập trên điện thoại</li>
                    </ol>
                </div>
            </section>
        </main>
    );
}

const stateLabel = (state: string) => ({
    waiting_for_scan: "Đang chờ quét",
    waiting_for_confirmation: "Đang chờ xác nhận",
    connected: "Đã kết nối",
}[state] ?? state);
