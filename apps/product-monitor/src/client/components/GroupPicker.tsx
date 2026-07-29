import type { GroupSummary } from "../api.js";

type GroupPickerProps = {
    groups: GroupSummary[];
    busy: boolean;
    onSelect(group: GroupSummary): void;
};

export function GroupPicker({ groups, busy, onSelect }: GroupPickerProps) {
    return (
        <main className="setup-page">
            <div className="setup-card">
                <p className="eyebrow">THIẾT LẬP NGUỒN DỮ LIỆU</p>
                <h1>Chọn một nhóm Zalo để theo dõi</h1>
                <p>Chỉ dữ liệu mới từ nhóm được chọn và do quản trị viên đăng mới đi vào pipeline.</p>
                <div className="group-list">
                    {groups.map((group) => (
                        <button
                            key={group.id}
                            className="group-option"
                            disabled={busy}
                            aria-label={`Theo dõi ${group.name}`}
                            onClick={() => onSelect(group)}
                        >
                            <span className="avatar">{initials(group.name)}</span>
                            <span><strong>{group.name}</strong><small>{group.adminIds.length} quản trị viên</small></span>
                            <span aria-hidden="true">→</span>
                        </button>
                    ))}
                    {!groups.length && <p className="empty-copy">Tài khoản chưa có nhóm khả dụng.</p>}
                </div>
            </div>
        </main>
    );
}

const initials = (name: string) =>
    name.split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
