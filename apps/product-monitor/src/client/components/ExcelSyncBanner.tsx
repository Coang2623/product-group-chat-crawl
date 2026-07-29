type ExcelSyncBannerProps = {
    pending: number;
    blocked: boolean;
    syncing: boolean;
    onSync(): void;
};

export function ExcelSyncBanner({ pending, blocked, syncing, onSync }: ExcelSyncBannerProps) {
    if (!pending && !blocked) return null;
    const message = blocked
        ? `Excel đang mở · dữ liệu realtime vẫn an toàn · ${pending} thay đổi đang chờ`
        : `Đang chờ Excel · ${pending} thay đổi chưa đồng bộ`;
    return (
        <section className={`excel-banner ${blocked ? "excel-banner--blocked" : ""}`} aria-live="polite">
            <strong>{message}</strong>
            <button
                className="button button--warning"
                aria-label="Đồng bộ Excel lại ngay"
                onClick={onSync}
                disabled={syncing}
            >
                ↻ {syncing ? "Đang đồng bộ…" : "Đồng bộ lại ngay"}
            </button>
        </section>
    );
}
