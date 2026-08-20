import { describe, expect, it } from "vitest";
import {
    commission,
    isValidMarkup,
    loadMarkupPercent,
    sellingPrice,
    specsForCopywriting,
} from "../src/client/selling.js";
import { fixtureProduct } from "./helpers.js";

describe("selling price", () => {
    it("adds the markup and rounds up to the nearest 100k", () => {
        // 5,900,000 + 10% = 6,490,000 -> quoted as 6,500,000.
        expect(sellingPrice(5_900_000, 10)).toBe(6_500_000);
    });

    it("never quotes below the price the shop must receive", () => {
        for (const base of [800_000, 1_750_000, 4_400_000, 14_500_000]) {
            expect(sellingPrice(base, 7)!).toBeGreaterThanOrEqual(base);
        }
    });

    it("returns the base price when the markup is zero", () => {
        expect(sellingPrice(6_000_000, 0)).toBe(6_000_000);
    });

    it("reports the commission as the gap over the base price", () => {
        expect(commission(5_900_000, 10)).toBe(600_000);
    });

    it("has no price to quote when the parser found none", () => {
        expect(sellingPrice(undefined, 10)).toBeUndefined();
        expect(commission(undefined, 10)).toBeUndefined();
    });

    it.each([-1, 101, Number.NaN, Infinity])("rejects an out-of-range markup (%s)", (percent) => {
        expect(isValidMarkup(percent)).toBe(false);
        expect(sellingPrice(5_000_000, percent)).toBeUndefined();
    });

    it("falls back to the default markup when none is stored", () => {
        expect(loadMarkupPercent(undefined)).toBe(10);
        expect(loadMarkupPercent({ getItem: () => "not a number" })).toBe(10);
        expect(loadMarkupPercent({ getItem: () => "15" })).toBe(15);
    });
});

describe("specs for copywriting", () => {
    const product = fixtureProduct({
        productName: "HP ZBook 15 G3",
        cpu: "Core i7 6820HQ",
        ram: "16GB",
        storage: "SSD 512GB",
        gpu: "QUADRO M1000M",
        display: "15.6 INCH FULLHD",
        price: 5_900_000,
        imageCount: 5,
        rawContent: "HP ZBOOK 15 G3 :\nCPU CORE I7 6820HQ - RAM 16GB\nGIÁ THU VỀ 5 TRIỆU 900",
    });

    it("lists the specs and quotes the selling price", () => {
        const text = specsForCopywriting(product, 10);

        expect(text).toContain("- Tên máy: HP ZBook 15 G3");
        expect(text).toContain("- CPU: Core i7 6820HQ");
        expect(text).toContain("- Card/GPU: QUADRO M1000M");
        expect(text).toContain("- Màn hình: 15.6 INCH FULLHD");
        expect(text).toContain("- Giá bán: 6.500.000 ₫");
    });

    it("never leaks the shop's cost price to the copywriter", () => {
        const text = specsForCopywriting(product, 10);

        expect(text).not.toContain("5.900.000");
        expect(text).not.toContain("thu về");
    });

    it("omits specs the parser could not determine", () => {
        const sparse = fixtureProduct({ productName: "Dell Latitude", gpu: undefined, display: undefined });

        const text = specsForCopywriting(sparse, 10);

        expect(text).not.toContain("Card/GPU");
        expect(text).not.toContain("Màn hình");
    });

    it("includes the original post so nothing has to be guessed", () => {
        expect(specsForCopywriting(product, 10)).toContain("HP ZBOOK 15 G3 :");
    });
});
