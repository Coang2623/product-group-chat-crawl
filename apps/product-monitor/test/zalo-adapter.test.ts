import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ZaloAdapter,
    type ZaloApiFacade,
    type ZaloLoginFacade,
} from "../src/server/zalo/zalo-adapter.js";
import { groupPhoto, groupReaction, groupText } from "./fixtures/zalo-events.js";

class FakeListener {
    readonly handlers = new Map<string, Array<(...events: unknown[]) => void>>();
    start = vi.fn(() => this.emit("connected"));
    stop = vi.fn();
    requestOldMessages = vi.fn();
    requestOldReactions = vi.fn();

    on(event: string, handler: (...events: unknown[]) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    emit(event: string, ...values: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) handler(...values);
    }
}

describe("ZaloAdapter", () => {
    let directory: string;
    let listener: FakeListener;
    let api: ZaloApiFacade;
    let login: ZaloLoginFacade;
    let adapter: ZaloAdapter;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "zalo-adapter-"));
        listener = new FakeListener();
        api = {
            listener,
            getAllGroups: vi.fn().mockResolvedValue({ gridVerMap: { g1: "1", g2: "1" } }),
            getGroupInfo: vi.fn().mockResolvedValue({
                gridInfoMap: {
                    g1: { groupId: "g1", name: "Laptop giá tốt", adminIds: ["admin-1", 22] },
                    g2: {
                        groupId: "g2",
                        name: "Nhóm khác",
                        creatorId: "creator-2",
                        adminIds: ["admin-2"],
                    },
                },
            }),
        };
        login = {
            login: vi.fn().mockResolvedValue(api),
            loginQR: vi.fn().mockImplementation(async (_options, callback) => {
                callback({
                    type: 0,
                    data: { image: "base64-qr" },
                });
                callback({
                    type: 2,
                    data: { display_name: "Admin" },
                });
                callback({
                    type: 4,
                    data: { cookie: [{ key: "zpsid", value: "secret" }], imei: "imei", userAgent: "agent" },
                });
                return api;
            }),
        };
        adapter = new ZaloAdapter({
            login,
            credentialsPath: join(directory, "credentials.json"),
            onDiagnostic: vi.fn(),
        });
        await adapter.beginQrLogin(() => undefined);
        await adapter.selectGroup("g1");
    });

    afterEach(async () => rm(directory, { recursive: true, force: true }));

    it("accepts text only from a selected group admin", () => {
        const onDescription = vi.fn();
        adapter.onDescription(onDescription);

        adapter.handleMessage(groupText());
        adapter.handleMessage(groupText({
            data: { ...groupText().data, msgId: "member-message", uidFrom: "member-1" },
        }));
        adapter.handleMessage(groupText({
            threadId: "g2",
            data: { ...groupText().data, msgId: "other-group", idTo: "g2" },
        }));

        expect(onDescription).toHaveBeenCalledTimes(1);
        expect(onDescription).toHaveBeenCalledWith(expect.objectContaining({
            groupId: "g1",
            groupName: "Laptop giá tốt",
            senderId: "admin-1",
            messageId: "message-1",
        }));
    });

    it("ignores ordinary publisher text that is not product information", () => {
        const onDescription = vi.fn();
        adapter.onDescription(onDescription);

        adapter.handleMessage(groupText({
            data: { ...groupText().data, msgId: "dot", content: "." },
        }));
        adapter.handleMessage(groupText({
            data: { ...groupText().data, msgId: "update", content: "M\u00ecnh update l\u1ea1i" },
        }));

        expect(onDescription).not.toHaveBeenCalled();
    });

    it("normalizes chat.photo href as an image event", () => {
        const onImage = vi.fn();
        adapter.onImage(onImage);

        adapter.handleMessage(groupPhoto());

        expect(onImage).toHaveBeenCalledWith(expect.objectContaining({
            imageUrl: "https://photo.example/original.jpg",
            messageId: "image-1",
        }));
    });

    it("normalizes quoted status text without creating a description", () => {
        const onDescription = vi.fn();
        const onSaleStatus = vi.fn();
        adapter.onDescription(onDescription);
        adapter.onSaleStatus(onSaleStatus);

        adapter.handleMessage(groupText({
            data: {
                ...groupText().data,
                msgId: "status-global",
                cliMsgId: "status-client",
                content: "CÃ³ cá»c",
                quote: {
                    globalMsgId: 0,
                    cliMsgId: "product-client",
                    msg: "Laptop target",
                    ts: "1785320000000",
                },
            },
        }));

        expect(onDescription).not.toHaveBeenCalled();
        expect(onSaleStatus).toHaveBeenCalledWith(expect.objectContaining({
            messageId: "status-global",
            messageAliases: ["status-global", "status-client"],
            targetMessageIds: ["product-client"],
            targetContent: "Laptop target",
            targetSentAt: 1785320000000,
        }));
    });

    it("normalizes reaction target IDs and removals", () => {
        const onReaction = vi.fn();
        adapter.onReaction(onReaction);

        adapter.handleReaction(groupReaction());
        adapter.handleReaction(groupReaction({
            data: {
                ...groupReaction().data,
                ts: "1785330003000",
                content: {
                    rMsg: [{ gMsgID: "image-1", cMsgID: "client-image-1", msgType: 1 }],
                    rIcon: "",
                    rType: 0,
                },
            },
        }));

        expect(onReaction).toHaveBeenNthCalledWith(1, expect.objectContaining({
            targetMessageIds: ["message-1", "client-1"],
            userId: "user-1",
            active: true,
            rType: 5,
        }));
        expect(onReaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ active: false }));
    });

    it("lists normalized groups and persists the selected group", async () => {
        await expect(adapter.listGroups()).resolves.toEqual([
            { id: "g1", name: "Laptop giá tốt", adminIds: ["admin-1", "22"] },
            { id: "g2", name: "Nhóm khác", adminIds: ["admin-2", "creator-2"] },
        ]);
        expect(adapter.getSelectedGroup()?.id).toBe("g1");
    });

    it("wires live and old reaction listeners in read-only mode", async () => {
        const onDescription = vi.fn();
        const onReaction = vi.fn();
        adapter.onDescription(onDescription);
        adapter.onReaction(onReaction);
        await adapter.start();

        listener.emit("old_messages", [], 1);
        listener.emit("message", groupText());
        listener.emit("old_reactions", [groupReaction()]);

        expect(listener.start).toHaveBeenCalledOnce();
        expect(listener.requestOldReactions).toHaveBeenCalledOnce();
        expect(listener.requestOldMessages).toHaveBeenCalledWith(1, null);
        expect(onDescription).toHaveBeenCalledOnce();
        expect(onReaction).toHaveBeenCalledOnce();
        adapter.stop();
        expect(listener.stop).toHaveBeenCalledOnce();
    });

    it("paginates old messages and replays them in chronological order", async () => {
        const events: string[] = [];
        adapter.onDescription((event) => events.push(`description:${event.messageId}`));
        adapter.onImage((event) => events.push(`image:${event.messageId}`));
        await adapter.start();

        listener.emit("old_messages", [groupPhoto(), groupText()], 1);
        expect(listener.requestOldMessages).toHaveBeenLastCalledWith(1, "message-1");
        expect(events).toEqual([]);

        listener.emit("old_messages", [], 1);
        expect(events).toEqual(["description:message-1", "image:image-1"]);
    });

    it("paginates group history from the HTTP endpoint", async () => {
        const events: string[] = [];
        api.getGroupChatHistoryPage = vi.fn()
            .mockResolvedValueOnce({
                lastMsgId: "older-cursor",
                hasMore: 1,
                groupMsgs: [groupPhoto()],
            })
            .mockResolvedValueOnce({
                lastMsgId: "oldest-cursor",
                hasMore: 0,
                groupMsgs: [groupText()],
            });
        adapter.onDescription((event) => events.push(`description:${event.messageId}`));
        adapter.onImage((event) => events.push(`image:${event.messageId}`));

        await adapter.start();
        await vi.waitFor(() => expect(events).toEqual([
            "description:message-1",
            "image:image-1",
        ]));

        expect(api.getGroupChatHistoryPage).toHaveBeenNthCalledWith(
            1,
            "g1",
            "10000000000000000",
        );
        expect(api.getGroupChatHistoryPage).toHaveBeenNthCalledWith(2, "g1", "older-cursor");
        expect(listener.requestOldMessages).not.toHaveBeenCalled();
    });

    it("queues live messages until old-message backfill is complete", async () => {
        const events: string[] = [];
        adapter.onDescription((event) => events.push(event.messageId));
        await adapter.start();

        listener.emit("message", groupText({
            data: { ...groupText().data, msgId: "live-message", ts: "1785330005000" },
        }));
        expect(events).toEqual([]);

        listener.emit("old_messages", [groupText()], 1);
        listener.emit("old_messages", [], 1);
        expect(events).toEqual(["message-1", "live-message"]);
    });

    it("reports unknown attachments without leaking their URLs", async () => {
        const diagnostic = vi.fn();
        adapter = new ZaloAdapter({
            login,
            credentialsPath: join(directory, "credentials-2.json"),
            onDiagnostic: diagnostic,
        });
        await adapter.beginQrLogin(() => undefined);
        await adapter.selectGroup("g1");
        adapter.handleMessage(groupPhoto({
            data: {
                ...groupPhoto().data,
                msgType: "chat.file",
                content: { href: "https://secret.example/file", token: "secret-token" },
            },
        }));

        expect(diagnostic).toHaveBeenCalledWith(
            "unknown_message",
            expect.not.stringContaining("https://secret.example/file"),
        );
        expect(diagnostic).toHaveBeenCalledWith(
            "unknown_message",
            expect.not.stringContaining("secret-token"),
        );
    });

    it("persists QR credentials and can restore the local session", async () => {
        const states: string[] = [];
        adapter = new ZaloAdapter({
            login,
            credentialsPath: join(directory, "credentials-3.json"),
        });

        await adapter.beginQrLogin((event) => states.push(event.state));
        const persisted = JSON.parse(await readFile(join(directory, "credentials-3.json"), "utf8"));
        await expect(adapter.restoreSession()).resolves.toBe(true);

        expect(states).toEqual(["waiting_for_scan", "waiting_for_confirmation", "connected"]);
        expect(persisted).toMatchObject({ imei: "imei", userAgent: "agent" });
        expect(adapter.getConnectionState()).toBe("connected");
    });
});
