import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { GroupMessage, type TGroupMessage } from "../models/index.js";
import { apiFactory } from "../utils.js";

export type GetGroupChatHistoryPageResponse = {
    lastMsgId: string;
    hasMore: number;
    groupMsgs: GroupMessage[];
};

export const getGroupChatHistoryPageFactory = apiFactory<GetGroupChatHistoryPageResponse>()(
    (api, ctx, utils) => {
        const serviceURL = utils.makeURL(
            `${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecent`,
        );

        return async function getGroupChatHistoryPage(
            groupId: string,
            globalMsgId: string = "10000000000000000",
        ) {
            const params = utils.encodeAES(JSON.stringify({
                groupId,
                globalMsgId,
                count: 50,
                msgIds: [],
                imei: ctx.imei,
                src: 1,
            }));
            if (!params) throw new ZaloApiError("Failed to encrypt history request");
            const response = await utils.request(utils.makeURL(serviceURL, { params, nretry: 0 }), {
                method: "GET",
            });
            return utils.resolve(response, (result) => {
                let data = result.data as unknown as GetGroupChatHistoryPageResponse | string;
                if (typeof data === "string") {
                    data = JSON.parse(data) as GetGroupChatHistoryPageResponse;
                }
                data.groupMsgs = data.groupMsgs.map(
                    (message) => new GroupMessage(ctx.uid, message as unknown as TGroupMessage),
                );
                return data;
            });
        };
    },
);
