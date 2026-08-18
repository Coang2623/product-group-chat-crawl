import { GroupMessage } from "../models/index.js";
export type GetGroupChatHistoryPageResponse = {
    lastMsgId: string;
    hasMore: number;
    groupMsgs: GroupMessage[];
};
export declare const getGroupChatHistoryPageFactory: (ctx: import("../context.js").ContextBase, api: import("../zalo.js").API) => (groupId: string, globalMsgId?: string) => Promise<GetGroupChatHistoryPageResponse>;
