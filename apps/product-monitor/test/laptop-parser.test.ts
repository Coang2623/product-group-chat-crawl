import { describe, expect, it } from "vitest";
import { parseLaptopPost, parseVietnamesePrice } from "../src/server/parser/laptop-parser.js";
import {
    HP_PROBOOK_450G5,
    HP_ZBOOK_15_G3,
    MACBOOK_AIR_13_3_2018,
    MACBOOK_AIR_13_3_2019,
} from "./fixtures/laptop-posts.js";

describe("parseVietnamesePrice", () => {
    it.each([
        ["GIÁ 5 TRIỆU", 5_000_000],
        ["GIÁ : 3 TRIỆU 8", 3_800_000],
        ["GIÁ THU VỀ 5 TRIỆU 900", 5_900_000],
        ["4 TRIỆU 4", 4_400_000],
    ])("normalizes %s", (raw, expected) => {
        expect(parseVietnamesePrice(raw)).toBe(expected);
    });

    it("returns null when the text does not contain a triệu price", () => {
        expect(parseVietnamesePrice("LIÊN HỆ")).toBeNull();
    });
});

describe("parseLaptopPost", () => {
    it.each([
        ["MacBook Air 2018", MACBOOK_AIR_13_3_2018, {
            productName: "MacBook Air 13.3 2018",
            cpu: "Core i5 8210Y",
            ram: "8GB",
            storage: "SSD 128GB",
            display: "13.3 INCH RETINA",
            price: 5_000_000,
            rawPrice: "GIÁ 5 TRIỆU",
        }],
        ["MacBook Air 2019", MACBOOK_AIR_13_3_2019, {
            productName: "MacBook Air 13.3 2019",
            cpu: "Core i5 8210Y",
            ram: "8GB",
            storage: "SSD 128GB",
            display: "13.3 INCH RETINA",
            price: 6_000_000,
            rawPrice: "GIÁ 6 TRIỆU",
        }],
        ["HP ProBook", HP_PROBOOK_450G5, {
            productName: "HP ProBook 450G5",
            cpu: "Core i5 8250U",
            ram: "8GB",
            storage: "SSD 256GB",
            display: "15.6 INCH FULLHD",
            price: 3_800_000,
            rawPrice: "GIÁ : 3 TRIỆU 8",
        }],
    ])("parses the structured %s post", (_label, content, expected) => {
        expect(parseLaptopPost(content)).toMatchObject({ ok: true, fields: expected });
    });

    it("keeps alternate configuration in notes", () => {
        const result = parseLaptopPost(HP_ZBOOK_15_G3);

        expect(result).toMatchObject({
            ok: true,
            fields: {
                productName: "HP ZBook 15 G3",
                cpu: "Core i7 6820HQ",
                ram: "16GB",
                storage: "SSD 512GB",
                gpu: "Quadro M1000M",
                price: 5_900_000,
                rawPrice: "GIÁ THU VỀ 5 TRIỆU 900",
                notes: expect.stringContaining("RAM 8GB"),
            },
        });
        if (result.ok) expect(result.fields.notes).toContain("VỎ ĐẸP");
    });

    it("rejects text missing a required structured field", () => {
        expect(parseLaptopPost("HP PROBOOK 450G5 - RAM 8GB - GIÁ 3 TRIỆU 8")).toEqual({
            ok: false,
            fields: {},
            reason: "structure_not_recognized",
        });
    });

    it("accepts Vietnamese field labels without diacritics", () => {
        expect(parseLaptopPost("HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - O SSD 256GB - MAN 15.6 INCH - GIA 3 TRIEU 8"))
            .toMatchObject({
                ok: true,
                fields: {
                    storage: "SSD 256GB",
                    display: "15.6 INCH",
                    price: 3_800_000,
                },
            });
    });
});
