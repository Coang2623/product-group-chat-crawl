import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as ZaloLibrary from "zalo-api-final";
import type {
    NormalizedDescriptionEvent,
    NormalizedImageEvent,
    NormalizedReactionEvent,
} from "../../shared/domain.js";

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

export interface ZaloListenerFacade {
    on(event: string, handler: (event: unknown) => void): void;
    start(): unknown;
    stop(): unknown;
    requestOldReactions(threadType: number): unknown;
}

export interface ZaloApiFacade {
    listener: ZaloListenerFacade;
    getAllGroups(): Promise<{ gridVerMap: Record<string, unknown> }>;
    getGroupInfo(ids: string[]): Promise<{
        gridInfoMap: Record<string, { groupId: string; name: string; adminIds: unknown[] }>;
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
}

export class ZaloAdapter implements ZaloProductAdapter {
    private readonly login: ZaloLoginFacade;
    private api: ZaloApiFacade | null = null;
    private state: ConnectionState = "signed_out";
    private selectedGroup: ZaloGroup | null = null;
    private groupCache = new Map<string, ZaloGroup>();
    private listenerBound = false;
    private readonly descriptionHandlers = new Set<(event: NormalizedDescriptionEvent) => void>();
    private readonly imageHandlers = new Set<(event: NormalizedImageEvent) => void>();
    private readonly reactionHandlers = new Set<(event: NormalizedReactionEvent) => void>();

    public constructor(private readonly options: ZaloAdapterOptions) {
        this.login = options.login ?? createDefaultLogin();
    }

    getConnectionState(): ConnectionState {
        return this.state;
    }

    getSelectedGroup(): ZaloGroup | null {
        return this.selectedGroup;
    }

    async beginQrLogin(onQr: (event: { image?: string; state: string }) => void): Promise<void> {
        let callbackChain = Promise.resolve();
        const login = this.login.loginQR({}, (event) => {
            callbackChain = callbackChain.then(async () => {
            if (event.type === QR_EVENT.generated) {
                this.state = "waiting_for_scan";
                const data = asRecord(event.data);
                onQr({ image: stringValue(data?.image), state: this.state });
            } else if (event.type === QR_EVENT.scanned) {
                this.state = "waiting_for_confirmation";
                onQr({ state: this.state });
            } else if (event.type === QR_EVENT.loginInfo) {
                const credentials = event.data as ZaloCredentials;
                await this.persistCredentials(credentials);
            }
            });
            return callbackChain;
        });
        this.api = await login;
        await callbackChain;
        this.state = "connected";
        onQr({ state: this.state });
    }

    async restoreSession(): Promise<boolean> {
        try {
            const credentials = JSON.parse(
                await readFile(this.options.credentialsPath, "utf8"),
            ) as ZaloCredentials;
            this.api = await this.login.login(credentials);
            this.state = "connected";
            const storedGroup = this.options.settings?.getSetting("activeGroupId");
            if (storedGroup) {
                await this.selectGroup(storedGroup).catch(() => undefined);
            }
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.report("session_restore_failed", error);
                this.state = "disconnected";
            }
            return false;
        }
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
                adminIds: group.adminIds.map(String),
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
    }

    async start(): Promise<void> {
        const api = this.requireApi();
        if (!this.listenerBound) {
            api.listener.on("message", (message) => this.handleMessage(message));
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
            this.listenerBound = true;
        }
        await api.listener.start();
        api.listener.requestOldReactions(GROUP_THREAD_TYPE);
        this.state = "connected";
    }

    stop(): void {
        this.api?.listener.stop();
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
            this.emit(this.descriptionHandlers, {
                groupId,
                groupName: this.selectedGroup.name,
                senderId,
                senderName: stringValue(data.dName),
                messageId,
                content: data.content,
                sentAt,
            });
            return;
        }
        const content = asRecord(data.content);
        const href = stringValue(content?.href);
        if (messageType === "chat.photo" && href) {
            this.emit(this.imageHandlers, {
                groupId,
                senderId,
                messageId,
                imageUrl: href,
                sentAt,
            });
            return;
        }
        this.report("unknown_message", raw);
    }

    handleReaction(raw: unknown): void {
        const event = asRecord(raw);
        const data = asRecord(event?.data);
        const groupId = stringValue(event?.threadId) ?? stringValue(data?.idTo);
        if (!this.selectedGroup || groupId !== this.selectedGroup.id || !data) return;
        const content = asRecord(data.content);
        const messages = Array.isArray(content?.rMsg) ? content.rMsg : [];
        const targetMessageIds = [...new Set(messages.flatMap((message) => {
            const target = asRecord(message);
            return [stringValue(target?.gMsgID), stringValue(target?.cMsgID)]
                .filter((value): value is string => Boolean(value));
        }))];
        const userId = stringValue(data.uidFrom);
        const occurredAt = numericTimestamp(data.ts);
        if (!userId || occurredAt === null || !targetMessageIds.length) {
            this.report("invalid_reaction", raw);
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

const sanitize = (value: unknown): string => {
    const sensitive = /^(content|cookie|token|href|thumb|image|authorization)$/iu;
    try {
        return JSON.stringify(value, (key, nested) => sensitive.test(key) ? "[redacted]" : nested);
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
