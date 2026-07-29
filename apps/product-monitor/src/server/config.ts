import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type AppConfig = {
    dataDirectory: string;
    databasePath: string;
    workbookPath: string;
    mediaRoot: string;
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

    return {
        dataDirectory,
        databasePath: join(dataDirectory, "products.sqlite"),
        workbookPath: join(dataDirectory, "zalo-products.xlsx"),
        mediaRoot: join(dataDirectory, "media"),
    };
};
