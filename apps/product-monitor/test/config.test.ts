import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
    it("uses workspace-local durable paths", () => {
        const config = loadConfig({ PRODUCT_MONITOR_DATA_DIR: "W:/tmp/zalo-products" });
        expect(config.databasePath).toMatch(/products\.sqlite$/);
        expect(config.workbookPath).toMatch(/zalo-products\.xlsx$/);
        expect(config.mediaRoot).toMatch(/media$/);
    });

    it("rejects a custom relative data directory", () => {
        expect(() => loadConfig({ PRODUCT_MONITOR_DATA_DIR: "runtime-data" })).toThrow(/absolute/);
    });

    it("rejects a custom data directory inside the repository", () => {
        expect(() => loadConfig({ PRODUCT_MONITOR_DATA_DIR: resolve(".", "runtime-data") })).toThrow(
            /outside the repository/,
        );
    });
});
