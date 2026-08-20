import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as ZaloLibrary from "zalo-api-final";
import type {
    NormalizedDescriptionEvent,
    NormalizedImageEvent,
    NormalizedReactionEvent,
    NormalizedSaleStatusEvent,
} from "../../shared/domain.js";
import { isProductInformation } from "../parser/product-message-classifier.js";

export type ConnectionState =
    | "signed_out"
    | "waiting_for_scan"
    | "waiting_for_confirmation"
    | "connected"
    | "reconnecting"
    | "disconnected";

export type ZaloGroup = { id: string; name: string; adminIds: string[] };

export type ZaloCredentials = {
    imei: string;
    cookie: unknown[];
    userAgent: string;
    language?: string;
};

const QR_EVENT = {
    generated: 0,
    scanned: 2,
    loginInfo: 4,
} as const;
const GROUP_THREAD_TYPE = 1;
const INITIAL_HISTORY_CURSOR = "10000000000000000";
const DEFAULT_SESSION_RESTORE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** Node/undici codes raised when the host is unreachable rather than rejecting us. */
const TRANSIENT_NETWORK_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

export interface ZaloListenerFacade {
    on(event: string, handler: (...events: unknown[]) => void): void;
    start(): unknown;
    stop(): unknown;
    requestOldMessages(threadType: number, lastMsgId?: string | null): unknown;
    requestOldReactions(threadType: number): unknown;
}

export interface ZaloApiFacade {
    listener: ZaloListenerFacade;
    getGroupChatHistoryPage?(groupId: string, globalMsgId?: string): Promise<{
        lastMsgId: string;
        hasMore: number;
        groupMsgs: unknown[];
    }>;
    getAllGroups(): Promise<{ gridVerMap: Record<string, unknown> }>;
    getGroupInfo(ids: string[]): Promise<{
        gridInfoMap: Record<string, {
            groupId: string;
            name: string;
            creatorId?: unknown;
            adminIds: unknown[];
        }>;
    }>;
}

export interface ZaloLoginFacade {
    login(credentials: ZaloCredentials): Promise<ZaloApiFacade>;
    loginQR(
        options: Record<string, unknown>,
        callback: (event: { type: number; data: unknown }) => unknown,
    ): Promise<ZaloApiFacade>;
}

export interface ZaloSettingStore {
    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;
}

export type ZaloAdapterOptions = {
    credentialsPath: string;
    login?: ZaloLoginFacade;
    settings?: ZaloSettingStore;
    onDiagnostic?: (code: string, sanitizedEvent: string) => void;
    /** Total login attempts before a restore is treated as a genuine sign-out. */
    sessionRestoreAttempts?: number;
    retryDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
};

export interface ZaloProductAdapter {
    getConnectionState(): ConnectionState;
    beginQrLogin(onQr: (event: { image?: string; state: string }) => void): Promise<void>;
    restoreSession(): Promise<boolean>;
    listGroups(): Promise<ZaloGroup[]>;
    selectGroup(groupId: string): Promise<void>;
    start(): Promise<void>;
    stop(): void;
    onDescription(handler: (event: NormalizedDescriptionEvent) => void): void;
    onImage(handler: (event: NormalizedImageEvent) => void): void;
    onReaction(handler: (event: NormalizedReactionEvent) => void): void;
    onSaleStatus?(handler: (event: NormalizedSaleStatusEvent) => void): void;
}

type HistoryBackfill = {
    groupId: string;
    highWater: number;
    saleHighWater: number;
    newestTimestamp: number;
    cursor: string | null;
    historicalMessages: Map<string, unknown>;
    liveMessages: Map<string, unknown>;
};

export class ZaloAdapter implements ZaloProductAdapter {
    private readonly login: ZaloLoginFacade;
    private api: ZaloApiFacade | null = null;
    private state: ConnectionState = "signed_out";
    private selectedGroup: ZaloGroup | null = null;
    private groupCache = new Map<string, ZaloGroup>();
    private listenerBound = false;
    private listenerConnected = false;
    private historyBackfill: HistoryBackfill | null = null;
    private readonly descriptionHandlers = new Set<(event: NormalizedDescriptionEvent) => void>();
    private readonly imageHandlers = new Set<(event: NormalizedImageEvent) => void>();
    private readonly reactionHandlers = new Set<(event: NormalizedReactionEvent) => void>();
    private readonly saleStatusHandlers = new Set<(event: NormalizedSaleStatusEvent) => void>();

    private readonly retryDelayMs: number;
    private readonly delay: (milliseconds: number) => Promise<void>;

    public constructor(private readonly options: ZaloAdapterOptions) {
        this.login = options.login ?? createDefaultLogin();
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.delay = options.sleep
            ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    }

    getConnectionState(): ConnectionState {
        return this.state;
    }

    getSelectedGroup(): ZaloGroup | null {
        return this.selectedGroup;
    }

    async beginQrLogin(onQr: (event: { image?: string; state: string }) => void): Promise<void> {
        let credentials: ZaloCredentials | undefined;
        try {
            this.api = await this.login.loginQR({}, (event) => {
                if (event.type === QR_EVENT.generated) {
                    this.state = "waiting_for_scan";
                    const data = asRecord(event.data);
                    onQr({ image: stringValue(data?.image), state: this.state });
                } else if (event.type === QR_EVENT.scanned) {
                    this.state = "waiting_for_confirmation";
                    onQr({ state: this.state });
                } else if (event.type === QR_EVENT.loginInfo) {
                    credentials = event.data as ZaloCredentials;
                }
            });
            if (!credentials) throw new Error("Zalo QR login completed without credentials");
            await this.persistCredentials(credentials);
            this.state = "connected";
            onQr({ state: this.state });
        } catch (error) {
            this.api = null;
            this.state = "disconnected";
            this.report("qr_login_failed", error);
            throw error;
        }
    }

    async restoreSession(): Promise<boolean> {
        let credentials: ZaloCredentials;
        try {
            credentials = JSON.parse(
                await readFile(this.options.credentialsPath, "utf8"),
            ) as ZaloCredentials;
        } catch (error) {
            // No stored session yet is the normal first-run path, not a failure.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.report("credentials_unreadable", error);
                this.state = "signed_out";
            }
            return false;
        }

        // A network blip must not be mistaken for revoked credentials: re-scanning a QR
        // is a manual step, so only give up when the session is genuinely rejected.
        const attempts = this.options.sessionRestoreAttempts ?? DEFAULT_SESSION_RESTORE_ATTEMPTS;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                this.api = await this.login.login(credentials);
                this.state = "connected";
                const storedGroup = this.options.settings?.getSetting("activeGroupId");
                if (storedGroup) {
                    await this.selectGroup(storedGroup).catch(() => undefined);
                }
                return true;
            } catch (error) {
                const retryable = isTransientNetworkError(error) && attempt < attempts;
                this.report(retryable ? "session_restore_retrying" : "session_restore_failed", {
                    attempt,
                    attempts,
                    retryable,
                    reason: isTransientNetworkError(error) ? "network" : "rejected",
                    error: describeError(error),
                });
                if (!retryable) {
                    // Keep credentials on a network failure; only a rejected session is signed out.
                    this.state = isTransientNetworkError(error) ? "disconnected" : "signed_out";
                    return false;
                }
                await this.delay(this.retryDelayMs * attempt);
            }
        }
        return false;
    }

    async listGroups(): Promise<ZaloGroup[]> {
        const api = this.requireApi();
        const all = await api.getAllGroups();
        const ids = Object.keys(all.gridVerMap);
        if (!ids.length) {
            this.groupCache.clear();
            return [];
        }
        const details = await api.getGroupInfo(ids);
        const groups = Object.values(details.gridInfoMap)
            .map((group) => ({
                id: String(group.groupId),
                name: String(group.name),
                adminIds: [...new Set([
                    ...group.adminIds.map(String),
                    ...(group.creatorId === undefined ? [] : [String(group.creatorId)]),
                ])],
            }))
            .sort((left, right) => left.name.localeCompare(right.name, "vi"));
        this.groupCache = new Map(groups.map((group) => [group.id, group]));
        return groups;
    }

    async selectGroup(groupId: string): Promise<void> {
        if (!this.groupCache.has(groupId)) await this.listGroups();
        const group = this.groupCache.get(groupId);
        if (!group) throw new Error(`Unknown Zalo group: ${groupId}`);
        this.selectedGroup = group;
        this.options.settings?.setSetting("activeGroupId", group.id);
        this.options.settings?.setSetting("activeGroupAdminIds", JSON.stringify(group.adminIds));
        if (this.listenerConnected) this.beginHistoryBackfill();
    }

    async start(): Promise<void> {
        const api = this.requireApi();
        if (!this.listenerBound) {
            api.listener.on("connected", () => {
                this.listenerConnected = true;
                this.state = "connected";
                api.listener.requestOldReactions(GROUP_THREAD_TYPE);
                this.beginHistoryBackfill();
            });
            api.listener.on("message", (message) => this.handleLiveMessage(message));
            api.listener.on("old_messages", (messages, threadType) => {
                if (threadType === undefined || Number(threadType) === GROUP_THREAD_TYPE) {
                    this.handleOldMessages(messages);
                }
            });
            api.listener.on("reaction", (reaction) => this.handleReaction(reaction));
            api.listener.on("old_reactions", (reactions) => {
                if (Array.isArray(reactions)) {
                    for (const reaction of reactions) this.handleReaction(reaction);
                }
            });
            api.listener.on("error", (error) => {
                this.state = "reconnecting";
                this.report("listener_error", error);
            });
            api.listener.on("disconnected", () => {
                this.listenerConnected = false;
                this.state = "reconnecting";
            });
            api.listener.on("closed", () => {
                this.listenerConnected = false;
                this.state = "disconnected";
            });
            this.listenerBound = true;
        }
        await api.listener.start();
    }

    stop(): void {
        this.api?.listener.stop();
        this.listenerConnected = false;
        this.historyBackfill = null;
        this.state = this.api ? "disconnected" : "signed_out";
    }

    onDescription(handler: (event: NormalizedDescriptionEvent) => void): void {
        this.descriptionHandlers.add(handler);
    }

    onImage(handler: (event: NormalizedImageEvent) => void): void {
        this.imageHandlers.add(handler);
    }

    onReaction(handler: (event: NormalizedReactionEvent) => void): void {
        this.reactionHandlers.add(handler);
    }

    onSaleStatus(handler: (event: NormalizedSaleStatusEvent) => void): void {
        this.saleStatusHandlers.add(handler);
    }

    handleMessage(raw: unknown): void {
        const event = asRecord(raw);
        const data = asRecord(event?.data);
        const groupId = stringValue(event?.threadId) ?? stringValue(data?.idTo);
        if (!this.selectedGroup || groupId !== this.selectedGroup.id || !data) return;
        const senderId = stringValue(data.uidFrom);
        if (!senderId || !this.selectedGroup.adminIds.includes(senderId)) return;
        const messageId = stringValue(data.msgId) ?? stringValue(data.cliMsgId);
        const sentAt = numericTimestamp(data.ts);
        if (!messageId || sentAt === null) {
            this.report("invalid_message", raw);
            return;
        }
        const messageType = stringValue(data.msgType);
        if (messageType === "webchat" && typeof data.content === "string") {
            const quote = asRecord(data.quote);
            if (quote) {
                const targetMessageIds = messageAliases(quote, ["globalMsgId", "cliMsgId"]);
                if (targetMessageIds.length) {
                    this.emit(this.saleStatusHandlers, {
                        groupId,
                        groupName: this.selectedGroup.name,
                        senderId,
                        targetSenderName: stringValue(quote.fromD),
                        messageId,
                        messageAliases: messageAliases(data),
                        targetMessageIds,
                        targetContent: stringValue(quote.msg),
                        targetSentAt: numericTimestamp(quote.ts) ?? undefined,
                        content: data.content,
                        sentAt,
                    });
                    return;
                }
            }
            if (!isProductInformation(data.content)) {
                this.report("ignored_non_product_text", raw);
                return;
            }
            this.emit(this.descriptionHandlers, {
                groupId,
                groupName: this.selectedGroup.name,
                senderId,
                senderName: stringValue(data.dName),
                messageId,
                content: data.content,
                sentAt,
                targetMessageIds: messageAliases(data),
            });
            return;
        }
        const content = asRecord(data.content);
        const href = stringValue(content?.href);
        if (messageType === "chat.photo" && href) {
            // Photos and descriptions arrive in no fixed order, so timing alone cannot
            // say which machine a photo belongs to. Report the attachment's structural
            // fields (never the image itself) to find a grouping key that can.
            this.report("photo_envelope", {
                messageId,
                keys: Object.keys(content ?? {}).sort(),
                params: describePhotoParams(content?.params),
                title: typeof content?.title === "string" ? content.title.slice(0, 40) : null,
                childnumber: content?.childnumber ?? null,
            });
            this.emit(this.imageHandlers, {
                groupId,
                senderId,
                messageId,
                imageUrl: href,
                sentAt,
                targetMessageIds: messageAliases(data),
            });
            return;
        }
        this.report("unknown_message", raw);
    }

    private handleLiveMessage(raw: unknown): void {
        const backfill = this.historyBackfill;
        const identity = messageIdentity(raw);
        if (backfill && identity?.groupId === backfill.groupId) {
            backfill.liveMessages.set(identity.messageId, raw);
            return;
        }
        this.handleMessage(raw);
    }

    private beginHistoryBackfill(): void {
        if (!this.listenerConnected || !this.selectedGroup) return;
        const groupId = this.selectedGroup.id;
        const storedHighWater = Number(
            this.options.settings?.getSetting(historyHighWaterKey(groupId)) ?? 0,
        );
        const storedSaleHighWater = Number(
            this.options.settings?.getSetting(saleHistoryHighWaterKey(groupId)) ?? 0,
        );
        this.historyBackfill = {
            groupId,
            highWater: Number.isSafeInteger(storedHighWater) && storedHighWater >= 0
                ? storedHighWater
                : 0,
            saleHighWater: Number.isSafeInteger(storedSaleHighWater) && storedSaleHighWater >= 0
                ? storedSaleHighWater
                : 0,
            newestTimestamp: 0,
            cursor: null,
            historicalMessages: new Map(),
            liveMessages: new Map(),
        };
        const api = this.requireApi();
        if (api.getGroupChatHistoryPage) {
            void this.loadGroupHistory(api, this.historyBackfill);
        } else {
            api.listener.requestOldMessages(GROUP_THREAD_TYPE, null);
        }
    }

    private async loadGroupHistory(api: ZaloApiFacade, backfill: HistoryBackfill): Promise<void> {
        let cursor = INITIAL_HISTORY_CURSOR;
        try {
            while (this.historyBackfill === backfill) {
                const page = await api.getGroupChatHistoryPage?.(backfill.groupId, cursor);
                if (!page || this.historyBackfill !== backfill) return;
                let reachedHighWater = false;
                let reachedSaleHighWater = false;
                for (const message of page.groupMsgs) {
                    const identity = messageIdentity(message);
                    if (!identity || identity.groupId !== backfill.groupId) continue;
                    backfill.newestTimestamp = Math.max(backfill.newestTimestamp, identity.sentAt);
                    if (identity.sentAt <= backfill.highWater) {
                        reachedHighWater = true;
                    }
                    if (identity.sentAt <= backfill.saleHighWater) {
                        reachedSaleHighWater = true;
                    }
                    if (
                        identity.sentAt > backfill.highWater ||
                        (identity.sentAt > backfill.saleHighWater && isQuotedTextMessage(message))
                    ) {
                        backfill.historicalMessages.set(identity.messageId, message);
                    }
                }
                const nextCursor = stringValue(page.lastMsgId);
                if ((reachedHighWater && reachedSaleHighWater) || !page.hasMore || !nextCursor || nextCursor === cursor) break;
                cursor = nextCursor;
            }
        } catch (error) {
            this.report("history_backfill_failed", error);
        } finally {
            if (this.historyBackfill === backfill) this.finishHistoryBackfill();
        }
    }

    private handleOldMessages(raw: unknown): void {
        const backfill = this.historyBackfill;
        if (!backfill || !Array.isArray(raw)) return;
        if (!raw.length) {
            this.finishHistoryBackfill();
            return;
        }

        let oldestBatchMessage: ReturnType<typeof messageIdentity> = null;
        let reachedHighWater = false;
        let reachedSaleHighWater = false;
        for (const message of raw) {
            const identity = messageIdentity(message);
            if (!identity) continue;
            if (!oldestBatchMessage || compareMessageIdentity(identity, oldestBatchMessage) < 0) {
                oldestBatchMessage = identity;
            }
            if (identity.groupId !== backfill.groupId) continue;
            backfill.newestTimestamp = Math.max(backfill.newestTimestamp, identity.sentAt);
            if (identity.sentAt <= backfill.highWater) {
                reachedHighWater = true;
            }
            if (identity.sentAt <= backfill.saleHighWater) reachedSaleHighWater = true;
            if (
                identity.sentAt > backfill.highWater ||
                (identity.sentAt > backfill.saleHighWater && isQuotedTextMessage(message))
            ) backfill.historicalMessages.set(identity.messageId, message);
        }

        const nextCursor = oldestBatchMessage?.messageId ?? null;
        if ((reachedHighWater && reachedSaleHighWater) || !nextCursor || nextCursor === backfill.cursor) {
            this.finishHistoryBackfill();
            return;
        }
        backfill.cursor = nextCursor;
        this.requireApi().listener.requestOldMessages(GROUP_THREAD_TYPE, nextCursor);
    }

    private finishHistoryBackfill(): void {
        const backfill = this.historyBackfill;
        if (!backfill) return;
        this.historyBackfill = null;

        const messages = new Map(backfill.historicalMessages);
        for (const [messageId, message] of backfill.liveMessages) messages.set(messageId, message);
        const chronological = [...messages.values()].sort((left, right) => {
            const leftIdentity = messageIdentity(left);
            const rightIdentity = messageIdentity(right);
            if (!leftIdentity || !rightIdentity) return 0;
            return compareMessageIdentity(leftIdentity, rightIdentity);
        });
        for (const message of chronological) this.handleMessage(message);

        const newest = chronological.reduce<number>((maximum, message) => {
            const identity = messageIdentity(message);
            return identity?.groupId === backfill.groupId
                ? Math.max(maximum, identity.sentAt)
                : maximum;
        }, backfill.newestTimestamp);
        if (newest > backfill.highWater) {
            this.options.settings?.setSetting(historyHighWaterKey(backfill.groupId), String(newest));
        }
        if (newest > backfill.saleHighWater) {
            this.options.settings?.setSetting(saleHistoryHighWaterKey(backfill.groupId), String(newest));
        }
        this.report("history_backfill_completed", {
            groupId: backfill.groupId,
            messageCount: chronological.length,
            highWater: newest,
        });
    }

    handleReaction(raw: unknown): void {
        const event = asRecord(raw);
        const data = asRecord(event?.data);
        const groupId = stringValue(event?.threadId) ?? stringValue(data?.idTo);
        if (!this.selectedGroup || groupId !== this.selectedGroup.id || !data) return;
        // Live reactions (cmd 612) arrive with content already parsed, but the
        // old_reactions replay (cmd 610/611) leaves it as a raw JSON string.
        const content = asRecordOrJson(data.content);
        const messages = Array.isArray(content?.rMsg) ? content.rMsg : [];
        const targetMessageIds = [...new Set(messages.flatMap((message) => {
            const target = asRecord(message);
            return [stringValue(target?.gMsgID), stringValue(target?.cMsgID)]
                .filter((value): value is string => Boolean(value));
        }))];
        const userId = stringValue(data.uidFrom);
        const occurredAt = numericTimestamp(data.ts);
        if (!userId || occurredAt === null || !targetMessageIds.length) {
            // Reaction content is routing metadata, not message text, so it is reported
            // verbatim: redacting it previously made this failure impossible to diagnose.
            this.report("invalid_reaction", {
                reason: !userId ? "missing_user" : occurredAt === null ? "missing_timestamp" : "no_target_messages",
                contentType: typeof data.content,
                contentShape: describeReactionContent(data.content),
                userId,
                occurredAt,
            });
            return;
        }
        const icon = stringValue(content?.rIcon) ?? "";
        const rType = numberValue(content?.rType);
        this.emit(this.reactionHandlers, {
            groupId,
            targetMessageIds,
            userId,
            icon,
            active: Boolean(icon) && (rType === undefined || rType > 0),
            occurredAt,
            rType,
        });
    }

    private requireApi(): ZaloApiFacade {
        if (!this.api) throw new Error("Zalo is not connected");
        return this.api;
    }

    private async persistCredentials(credentials: ZaloCredentials): Promise<void> {
        await mkdir(dirname(this.options.credentialsPath), { recursive: true });
        const temporaryPath = `${this.options.credentialsPath}.tmp`;
        try {
            await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            });
            await rename(temporaryPath, this.options.credentialsPath);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private emit<T>(handlers: Set<(event: T) => void>, event: T): void {
        for (const handler of handlers) {
            try {
                handler(event);
            } catch (error) {
                this.report("event_handler_failed", error);
            }
        }
    }

    private report(code: string, raw: unknown): void {
        try {
            this.options.onDiagnostic?.(code, sanitize(raw));
        } catch {
            // Diagnostics must not interrupt listener ingestion.
        }
    }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

/**
 * Distinguishes "could not reach Zalo" from "Zalo rejected this session". Only the
 * latter means the stored credentials are dead and a QR re-scan is required.
 */
const isTransientNetworkError = (error: unknown): boolean => {
    for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
        const record = current as { code?: unknown; name?: unknown; cause?: unknown };
        const code = typeof record.code === "string" ? record.code : undefined;
        if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
        if (record.name === "AbortError" || record.name === "TimeoutError") return true;
        current = record.cause;
    }
    return error instanceof TypeError && /fetch failed|network/iu.test(error.message);
};

/** Error summary safe for diagnostics: no cookies, tokens, or message text. */
const describeError = (error: unknown): string => {
    if (!(error instanceof Error)) return typeof error;
    const code = (error as Error & { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? `(${code})` : ""}`;
};

/**
 * Zalo packs album metadata into the attachment's `params` JSON. Reports its keys and
 * any grouping-shaped values, which is what an album key would look like.
 */
const describePhotoParams = (value: unknown): unknown => {
    const record = asRecordOrJson(value);
    if (!record) return typeof value === "string" ? value.slice(0, 120) : null;
    const interesting = Object.entries(record)
        .filter(([key]) => /group|album|layout|batch|collection|order|index|total|count/iu.test(key));
    return {
        keys: Object.keys(record).sort(),
        grouping: Object.fromEntries(interesting),
    };
};

/** Names the reaction payload's shape without echoing any message text. */
const describeReactionContent = (value: unknown): string => {
    const record = asRecordOrJson(value);
    if (!record) return typeof value === "string" ? "unparseable_string" : "not_a_record";
    return `keys=${Object.keys(record).sort().join(",") || "none"} rMsg=${
        Array.isArray(record.rMsg) ? `array(${record.rMsg.length})` : typeof record.rMsg
    }`;
};

/** Accepts a record, or a JSON string holding one, and returns null for anything else. */
const asRecordOrJson = (value: unknown): Record<string, unknown> | null => {
    const record = asRecord(value);
    if (record) return record;
    if (typeof value !== "string") return null;
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return null;
    }
};

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" || typeof value === "number" ? String(value) : undefined;

const numberValue = (value: unknown): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

const numericTimestamp = (value: unknown): number | null => {
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
};

type MessageIdentity = { groupId: string; messageId: string; sentAt: number };

const messageIdentity = (raw: unknown): MessageIdentity | null => {
    const event = asRecord(raw);
    const data = asRecord(event?.data);
    if (!data) return null;
    const groupId = stringValue(event?.threadId) ?? stringValue(data.idTo);
    const messageId = stringValue(data.msgId) ?? stringValue(data.cliMsgId);
    const sentAt = numericTimestamp(data.ts);
    return groupId && messageId && sentAt !== null ? { groupId, messageId, sentAt } : null;
};

const compareMessageIdentity = (left: MessageIdentity, right: MessageIdentity): number =>
    left.sentAt - right.sentAt || left.messageId.localeCompare(right.messageId);

const historyHighWaterKey = (groupId: string): string => `zaloHistoryHighWater:${groupId}`;
const saleHistoryHighWaterKey = (groupId: string): string => `zaloSaleHistoryHighWater:${groupId}`;

const messageAliases = (
    data: Record<string, unknown>,
    keys: string[] = ["msgId", "cliMsgId"],
): string[] => [...new Set(keys
    .map((key) => stringValue(data[key]))
    .filter((value): value is string => Boolean(value) && value !== "0"))];

const isQuotedTextMessage = (raw: unknown): boolean => {
    const event = asRecord(raw);
    const data = asRecord(event?.data);
    return data?.msgType === "webchat" && typeof data.content === "string" && Boolean(asRecord(data.quote));
};

const sanitize = (value: unknown): string => {
    const sensitive = /^(content|cookie|token|href|thumb|image|authorization)$/iu;
    try {
        const diagnosticValue = value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                code: numberValue((value as Error & { code?: unknown }).code),
            }
            : value;
        return JSON.stringify(diagnosticValue, (key, nested) => sensitive.test(key) ? "[redacted]" : nested);
    } catch {
        return "[unserializable event]";
    }
};

const createDefaultLogin = (): ZaloLoginFacade => {
    const runtime = ZaloLibrary as unknown as {
        Zalo: new (options: Record<string, unknown>) => ZaloLoginFacade;
    };
    if (typeof runtime.Zalo !== "function") {
        throw new Error("zalo-api-final runtime does not export Zalo");
    }
    return new runtime.Zalo({ selfListen: false, logging: true });
};
