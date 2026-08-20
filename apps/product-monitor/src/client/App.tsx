import { useEffect, useMemo, useState } from "react";
import type { ProductMonitorEvent } from "../shared/api.js";
import type { ProductRecord } from "../shared/domain.js";
import type {
    GroupSummary,
    MonitorStatus,
    ProductDetail,
    ProductMonitorApi,
} from "./api.js";
import { ExcelSyncBanner } from "./components/ExcelSyncBanner.js";
import { GroupPicker } from "./components/GroupPicker.js";
import { ProductDetailPanel } from "./components/ProductDetailPanel.js";
import { ProductTable } from "./components/ProductTable.js";
import { QrLogin } from "./components/QrLogin.js";
import { isValidMarkup, loadMarkupPercent, saveMarkupPercent } from "./selling.js";

type Filter = "all" | "receiving" | "review" | "unsynced";

export function App({ api }: { api: ProductMonitorApi }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>();
    const [connection, setConnection] = useState("signed_out");
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const [groups, setGroups] = useState<GroupSummary[]>([]);
    const [products, setProducts] = useState<Map<string, ProductRecord>>(new Map());
    const [excel, setExcel] = useState<MonitorStatus["excel"]>({ pending: 0, blocked: false });
    const [qr, setQr] = useState<{ image?: string; state?: string }>({});
    const [busy, setBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [selected, setSelected] = useState<ProductDetail>();
    const [completing, setCompleting] = useState(false);
    const [moving, setMoving] = useState(false);
    const [markupPercent, setMarkupPercent] = useState(
        () => loadMarkupPercent(typeof localStorage === "undefined" ? undefined : localStorage),
    );
    const [filter, setFilter] = useState<Filter>("all");
    const [search, setSearch] = useState("");
    const [minPrice, setMinPrice] = useState("");
    const [maxPrice, setMaxPrice] = useState("");
    const [brand, setBrand] = useState("");
    const [ram, setRam] = useState("");
    // Defaults to stock a collaborator can still sell; sold machines are history.
    const [sale, setSale] = useState<"all" | "available" | "closed">("available");

    const loadProducts = async () => {
        const records = await api.getProducts();
        setProducts(new Map(records.map((product) => [product.id, product])));
    };

    const loadConnectedWorkspace = async (groupId: string | null) => {
        const availableGroups = await api.getGroups();
        setGroups(availableGroups);
        if (groupId) await loadProducts();
    };

    useEffect(() => {
        let active = true;
        const unsubscribe = api.subscribe((event) => {
            if (!active) return;
            handleEvent(event);
        });
        void api.getStatus()
            .then(async (status) => {
                if (!active) return;
                setConnection(status.connection);
                setActiveGroupId(status.activeGroupId);
                setExcel(status.excel);
                if (status.connection === "connected") {
                    await loadConnectedWorkspace(status.activeGroupId);
                }
            })
            .catch((reason: unknown) => setError(errorMessage(reason)))
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
            unsubscribe();
        };

        function handleEvent(event: ProductMonitorEvent) {
            if (event.type === "product.created" || event.type === "product.updated") {
                setProducts((current) => {
                    const next = new Map(current);
                    next.set(event.product.id, event.product);
                    return next;
                });
                setSelected((current) => current?.product.id === event.product.id
                    ? { ...current, product: event.product }
                    : current);
            } else if (event.type === "excel.status") {
                setExcel(event);
            } else if (event.type === "connection.status") {
                setConnection(event.state);
                if (event.state === "connected") {
                    void loadConnectedWorkspace(activeGroupId);
                }
            } else if (event.type === "auth.qr") {
                setQr({ image: event.image, state: event.state });
                if (event.state === "connected") {
                    setConnection("connected");
                    void loadConnectedWorkspace(null);
                }
            }
        }
    }, [api]);

    useEffect(() => {
        if (connection === "connected") return;
        const timer = window.setInterval(() => {
            void api.getStatus().then((status) => {
                if (status.connection !== "connected") return;
                setConnection("connected");
                setActiveGroupId(status.activeGroupId);
                setExcel(status.excel);
                void loadConnectedWorkspace(status.activeGroupId);
            }).catch(() => undefined);
        }, 1_500);
        return () => window.clearInterval(timer);
    }, [api, connection]);

    const visibleProducts = useMemo(() => {
        const query = search.trim().toLocaleLowerCase("vi");
        const minimum = minPrice ? Number(minPrice) : undefined;
        const maximum = maxPrice ? Number(maxPrice) : undefined;
        return [...products.values()]
            .filter((product) => {
                if (filter === "receiving" && product.status !== "receiving_images") return false;
                if (filter === "review" && product.status !== "needs_review") return false;
                if (filter === "unsynced" && product.excelSyncStatus === "synced") return false;
                if (sale !== "all" && product.saleStatus !== sale) return false;
                if (brand && productBrand(product) !== brand) return false;
                if (ram && product.ram !== ram) return false;
                const haystack = [product.productName, product.cpu, product.ram, product.storage]
                    .filter(Boolean).join(" ").toLocaleLowerCase("vi");
                if (query && !haystack.includes(query)) return false;
                if (minimum !== undefined && (product.price ?? 0) < minimum) return false;
                if (maximum !== undefined && (product.price ?? Infinity) > maximum) return false;
                return true;
            })
            .sort((left, right) => {
                const leftActive = left.status === "receiving_images" ? 1 : 0;
                const rightActive = right.status === "receiving_images" ? 1 : 0;
                return rightActive - leftActive || right.postedAt - left.postedAt;
            });
    }, [brand, filter, maxPrice, minPrice, products, ram, sale, search]);

    // Any machine may be the right home for a stray photo, so this ignores the filters
    // the table uses -- only the machine already showing the photos is excluded.
    const moveCandidates = useMemo(
        () => [...products.values()]
            .filter((product) => product.id !== selected?.product.id)
            .sort((left, right) => right.postedAt - left.postedAt),
        [products, selected?.product.id],
    );

    const brandOptions = useMemo(() => [...new Set([...products.values()].map(productBrand).filter(Boolean))].sort(), [products]);
    const ramOptions = useMemo(() => [...new Set([...products.values()].map((product) => product.ram).filter(Boolean))].sort(), [products]);

    const selectGroup = async (group: GroupSummary) => {
        setBusy(true);
        setError(undefined);
        try {
            await api.selectGroup(group.id);
            setActiveGroupId(group.id);
            await loadProducts();
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setBusy(false);
        }
    };

    const openDetail = async (product: ProductRecord) => {
        try {
            setSelected(await api.getProduct(product.id));
        } catch (reason) {
            setError(errorMessage(reason));
        }
    };

    const completeSelected = async () => {
        if (!selected) return;
        setCompleting(true);
        try {
            const completed = await api.completeProduct(selected.product.id);
            setProducts((current) => new Map(current).set(completed.id, completed));
            setSelected({ ...selected, product: completed });
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setCompleting(false);
        }
    };

    /**
     * Photos land on the wrong machine when Zalo interleaves them with descriptions.
     * The moved images leave this gallery, so the open detail is reloaded from the
     * server rather than patched from the products already in memory.
     */
    const moveMedia = async (mediaIds: string[], toProductId: string): Promise<boolean> => {
        if (!selected || !mediaIds.length) return false;
        setMoving(true);
        try {
            const updated = await api.moveMedia(mediaIds, toProductId);
            setProducts((current) => {
                const next = new Map(current);
                for (const product of updated) next.set(product.id, product);
                return next;
            });
            setSelected(await api.getProduct(selected.product.id));
            return true;
        } catch (reason) {
            setError(errorMessage(reason));
            return false;
        } finally {
            setMoving(false);
        }
    };

    const syncExcel = async () => {
        setSyncing(true);
        try {
            await api.syncExcel();
            const status = await api.getStatus();
            setExcel(status.excel);
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setSyncing(false);
        }
    };

    if (loading) return <div className="loading-screen">Đang mở dữ liệu local…</div>;
    if (connection !== "connected") {
        return <QrLogin
            {...qr}
            busy={busy}
            offline={connection === "disconnected" || connection === "reconnecting"}
            onBegin={() => {
                setBusy(true);
                void api.beginQrLogin().catch((reason) => setError(errorMessage(reason))).finally(() => setBusy(false));
            }}
        />;
    }
    if (!activeGroupId) {
        return <GroupPicker groups={groups} busy={busy} onSelect={(group) => void selectGroup(group)} />;
    }

    const group = groups.find((item) => item.id === activeGroupId);
    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="brand brand--inverse"><span className="brand__mark">▦</span><span>Zalo Monitor<small>LOCAL WORKSPACE</small></span></div>
                <div className="connection-pill"><i /> Đã kết nối</div>
                <nav aria-label="Điều hướng chính">
                    <span>⌂ Tổng quan</span><span>☵ Tin nhắn</span><strong>▦ Sản phẩm</strong>
                    <span>♙ Nhóm Zalo</span><span>≡ Bộ lọc</span><span>♢ Cảnh báo</span><span>▤ Nhật ký</span>
                </nav>
                <div className="sidebar__spacer" />
                <p className="sidebar__notice">◈ Chỉ đọc & cục bộ<br /><small>Không gửi dữ liệu về Zalo</small></p>
            </aside>
            <main className="workspace">
                <header className="topbar">
                    <div><h1>Sản phẩm realtime</h1><p>Laptop được map tự động từ nhóm {group?.name ?? activeGroupId}</p></div>
                    <div className="live-pill">● Listener · Đã kết nối</div>
                </header>
                <div className="content">
                    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(undefined)}>×</button></div>}
                    <section className="group-context">
                        <div className="group-context__identity"><span className="avatar">{group ? initials(group.name) : "ZG"}</span><span><strong>{group?.name ?? activeGroupId}</strong><small>{group?.adminIds.length ?? 0} quản trị viên · chỉ đọc</small></span></div>
                        <div><span className="pipeline-pill">● Đang lắng nghe</span><span className="pending-pill">{excel.pending} thay đổi đang chờ</span></div>
                    </section>
                    <ExcelSyncBanner {...excel} syncing={syncing} onSync={() => void syncExcel()} />
                    <section className="filters" aria-label="Bộ lọc sản phẩm">
                        <div className="filter-tabs">
                            {([
                                ["all", "Tất cả"],
                                ["receiving", "Đang nhận ảnh"],
                                ["review", "Cần kiểm tra"],
                                ["unsynced", "Chưa đồng bộ Excel"],
                            ] as Array<[Filter, string]>).map(([value, label]) => (
                                <button key={value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{label}</button>
                            ))}
                        </div>
                        <div className="filter-inputs">
                            <input aria-label="Tìm sản phẩm" placeholder="Tên, CPU, RAM, SSD…" value={search} onChange={(event) => setSearch(event.target.value)} />
                            <input aria-label="Giá tối thiểu" type="number" placeholder="Giá từ" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} />
                            <input aria-label="Giá tối đa" type="number" placeholder="Giá đến" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} />
                            <select aria-label="Lọc theo hãng" value={brand} onChange={(event) => setBrand(event.target.value)}>
                                <option value="">Tất cả hãng</option>
                                {brandOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                            </select>
                            <select aria-label="Lọc theo RAM" value={ram} onChange={(event) => setRam(event.target.value)}>
                                <option value="">Tất cả RAM</option>
                                {ramOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                            </select>
                            <select aria-label="Lọc theo trạng thái bán" value={sale} onChange={(event) => setSale(event.target.value as typeof sale)}>
                                <option value="all">Còn / hết hàng</option>
                                <option value="available">Còn hàng</option>
                                <option value="closed">Đã chốt</option>
                            </select>
                            <label className="markup-field">
                                Hoa hồng
                                <input
                                    aria-label="Phần trăm hoa hồng"
                                    type="number"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={markupPercent}
                                    onChange={(event) => {
                                        const next = Number(event.target.value);
                                        if (!isValidMarkup(next)) return;
                                        setMarkupPercent(next);
                                        saveMarkupPercent(
                                            typeof localStorage === "undefined" ? undefined : localStorage,
                                            next,
                                        );
                                    }}
                                />
                                %
                            </label>
                        </div>
                    </section>
                    <div className="product-layout">
                        <ProductTable products={visibleProducts} selectedId={selected?.product.id} markupPercent={markupPercent} onSelect={(item) => void openDetail(item)} />
                        {selected && <ProductDetailPanel
                            detail={selected}
                            completing={completing}
                            moving={moving}
                            markupPercent={markupPercent}
                            moveCandidates={moveCandidates}
                            onClose={() => setSelected(undefined)}
                            onComplete={() => void completeSelected()}
                            onMoveMedia={moveMedia}
                        />}
                    </div>
                </div>
            </main>
        </div>
    );
}

const initials = (name: string) =>
    name.split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const productBrand = (product: ProductRecord) => {
    if (product.brand) return product.brand;
    const name = product.productName?.trim() ?? "";
    const known = /^(acer|asus|dell|hp|lenovo|msi|apple|macbook|lg|microsoft|samsung|toshiba|fujitsu|gigabyte|huawei)\b/iu.exec(name);
    return known?.[1] ? known[1][0].toUpperCase() + known[1].slice(1).toLowerCase() : "Khác";
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Đã xảy ra lỗi";
