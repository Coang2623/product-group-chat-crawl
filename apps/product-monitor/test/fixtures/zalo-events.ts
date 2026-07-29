export const groupText = (overrides: Record<string, unknown> = {}) => ({
    threadId: "g1",
    type: 1,
    isSelf: false,
    data: {
        msgId: "message-1",
        cliMsgId: "client-1",
        msgType: "webchat",
        uidFrom: "admin-1",
        idTo: "g1",
        dName: "Admin",
        ts: "1785330000000",
        content: "HP PROBOOK 450G5 - CORE I5 8250U - RAM 8GB - SSD 256GB - GIÁ 3 TRIỆU 8",
    },
    ...overrides,
});

export const groupPhoto = (overrides: Record<string, unknown> = {}) => ({
    threadId: "g1",
    type: 1,
    isSelf: false,
    data: {
        msgId: "image-1",
        cliMsgId: "client-image-1",
        msgType: "chat.photo",
        uidFrom: "admin-1",
        idTo: "g1",
        dName: "Admin",
        ts: "1785330001000",
        content: {
            href: "https://photo.example/original.jpg",
            thumb: "https://photo.example/thumb.jpg",
        },
    },
    ...overrides,
});

export const groupReaction = (overrides: Record<string, unknown> = {}) => ({
    threadId: "g1",
    isGroup: true,
    data: {
        msgId: "reaction-1",
        uidFrom: "user-1",
        idTo: "g1",
        ts: "1785330002000",
        content: {
            rMsg: [{ gMsgID: "message-1", cMsgID: "client-1", msgType: 1 }],
            rIcon: "/-heart",
            rType: 5,
        },
    },
    ...overrides,
});
