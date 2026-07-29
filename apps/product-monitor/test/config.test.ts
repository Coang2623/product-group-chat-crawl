import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
    it("uses workspace-local durable paths", () => {
        const config = loadConfig({ PRODUCT_MONITOR_DATA_DIR: "W:/tmp/zalo-products" });
        expect(config.databasePath).toMatch(/products\.sqlite$/);
        expect(config.workbookPath).toMatch(/zalo-products\.xlsx$/);
        expect(config.mediaRoot).toMatch(/media$/);
    });
});
