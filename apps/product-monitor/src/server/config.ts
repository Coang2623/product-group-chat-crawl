import { join } from "node:path";

export type AppConfig = {
    dataDirectory: string;
    databasePath: string;
    workbookPath: string;
    mediaRoot: string;
};

export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
    const dataDirectory = env.PRODUCT_MONITOR_DATA_DIR ?? "data";

    return {
        dataDirectory,
        databasePath: join(dataDirectory, "products.sqlite"),
        workbookPath: join(dataDirectory, "zalo-products.xlsx"),
        mediaRoot: join(dataDirectory, "media"),
    };
};
