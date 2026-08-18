import { describe, expect, it } from "vitest";
import { isProductInformation } from "../src/server/parser/product-message-classifier.js";

describe("isProductInformation", () => {
    it.each([
        "DELL 5410: CPU I5 10310U - RAM 8GB - SSD 256GB - GI\u00c1 4 TRI\u1ec6U 5",
        "MACBOOK AIR M1 - RAM 8GB - B\u1ed8 NH\u1eda 256GB - M\u00c0N RETINA - GI\u00c1 9T5",
        "HP WORKSTATION - CORE I7 - RAM 16GB - NVME 512GB - QUADRO T1000",
    ])("accepts product information: %s", (content) => {
        expect(isProductInformation(content)).toBe(true);
    });

    it.each([
        ".",
        "M\u00ecnh update l\u1ea1i",
        "C\u00f3 c\u1ecdc",
        "\u0110\u00e3 b\u00e1n",
        "Ch\u1ed1t kh\u00e1ch n\u00e0y",
    ])("rejects non-product group text: %s", (content) => {
        expect(isProductInformation(content)).toBe(false);
    });
});
