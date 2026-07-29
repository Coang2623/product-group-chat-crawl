import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type AppConfig = {
    dataDirectory: string;
    databasePath: string;
    workbookPath: string;
    mediaRoot: string;
    credentialsPath: string;
    host: string;
    port: number;
};

export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
    const configuredDataDirectory = env.PRODUCT_MONITOR_DATA_DIR;
    const dataDirectory = configuredDataDirectory ?? "data";

    if (configuredDataDirectory) {
        if (!isAbsolute(configuredDataDirectory)) {
            throw new Error("PRODUCT_MONITOR_DATA_DIR must be an absolute path");
        }

        const repositoryRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
        const customDataDirectory = resolve(configuredDataDirectory);
        const pathFromRepository = relative(repositoryRoot, customDataDirectory);
        const isInsideRepository =
            pathFromRepository === "" ||
            (!pathFromRepository.startsWith(`..${sep}`) && pathFromRepository !== ".." && !isAbsolute(pathFromRepository));

        if (isInsideRepository) {
            throw new Error("PRODUCT_MONITOR_DATA_DIR must be outside the repository");
        }
    }

    const port = Number(env.PRODUCT_MONITOR_PORT ?? 4173);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("PRODUCT_MONITOR_PORT must be an integer from 1 to 65535");
    }

    return {
        dataDirectory,
        databasePath: join(dataDirectory, "products.sqlite"),
        workbookPath: join(dataDirectory, "zalo-products.xlsx"),
        mediaRoot: join(dataDirectory, "media"),
        credentialsPath: join(dataDirectory, "zalo-credentials.json"),
        host: env.PRODUCT_MONITOR_HOST?.trim() || "127.0.0.1",
        port,
    };
};
