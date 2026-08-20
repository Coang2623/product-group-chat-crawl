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

    it.each([
        "GIÁ 5 TRIỆU 9000",
        "BẢNGIÁ 5 TRIỆU",
    ])("rejects the near-miss price %s", (raw) => {
        expect(parseVietnamesePrice(raw)).toBeNull();
    });

    it("does not treat a number on the next line as a price fraction", () => {
        expect(parseVietnamesePrice("GIÁ 5 TRIỆU\n090")).toBe(5_000_000);
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

    it.each([
        ["product name", "CPU CORE I5 8250U - RAM 8GB - SSD 256GB - GIÁ 3 TRIỆU 8"],
        ["CPU", "HP PROBOOK 450G5 - RAM 8GB - SSD 256GB - GIÁ 3 TRIỆU 8"],
        ["RAM", "HP PROBOOK 450G5 - CPU CORE I5 8250U - SSD 256GB - GIÁ 3 TRIỆU 8"],
        ["storage", "HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - GIÁ 3 TRIỆU 8"],
        ["price", "HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - SSD 256GB"],
    ])("rejects text missing required %s", (_field, content) => {
        expect(parseLaptopPost(content)).toEqual({
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

    it("rejects a desktop even when its fields look complete", () => {
        expect(parseLaptopPost("HP PRODESK 400 G5 - CPU CORE I5 8500 - RAM 8GB - SSD 256GB - GIÁ 3 TRIỆU 8"))
            .toEqual({ ok: false, fields: {}, reason: "structure_not_recognized" });
    });

    it("rejects a Precision tower even when its fields look complete", () => {
        expect(parseLaptopPost("DELL PRECISION 3660 TOWER - CPU CORE I7 12700 - RAM 16GB - SSD 512GB - GIÁ 8 TRIỆU"))
            .toEqual({ ok: false, fields: {}, reason: "structure_not_recognized" });
    });

    it.each(["DESKTOP", "TOWER", "AIO", "ALL-IN-ONE"])("rejects a recognised laptop family marked as %s", (marker) => {
        expect(parseLaptopPost(`HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - SSD 256GB - ${marker} - GIÁ 3 TRIỆU 8`))
            .toEqual({ ok: false, fields: {}, reason: "structure_not_recognized" });
    });

    it("canonicalizes a hyphenated Core CPU model", () => {
        expect(parseLaptopPost("HP PROBOOK 450G5 - CPU CORE I5-8250U - RAM 8GB - SSD 256GB - GIÁ 3 TRIỆU 8"))
            .toMatchObject({ ok: true, fields: { cpu: "Core i5 8250U" } });
    });

    it("does not put the product name into notes", () => {
        const result = parseLaptopPost(MACBOOK_AIR_13_3_2018);

        expect(result).toMatchObject({ ok: true, fields: { productName: "MacBook Air 13.3 2018" } });
        if (result.ok) expect(result.fields.notes).toBeUndefined();
    });

    it("keeps a next-line number in notes instead of the price", () => {
        expect(parseLaptopPost("HP PROBOOK 450G5 - CPU CORE I5 8250U - RAM 8GB - SSD 256GB - GIÁ 5 TRIỆU\n090 GHI CHÚ"))
            .toMatchObject({
                ok: true,
                fields: {
                    price: 5_000_000,
                    rawPrice: "GIÁ 5 TRIỆU",
                    notes: "090 GHI CHÚ",
                },
            });
    });

    it("canonicalizes a safely whitelisted ThinkPad family", () => {
        expect(parseLaptopPost("LENOVO THINKPAD T480 - CPU CORE I5 8250U - RAM 8GB - SSD 256GB - GIÁ 5 TRIỆU"))
            .toMatchObject({ ok: true, fields: { productName: "Lenovo ThinkPad T480" } });
    });

    it.each([
        ["ASUS VIVOBOOK X412 :\nCPU RYZEN 5 3500U - RAM 8GB - Ổ SSD 256 - CARD AMD VEGA8 2GB - MÀN 14INCH FHD\nGIÁ : 3 TRIỆU 950", "Ryzen 5 3500U", "SSD 256GB", 3_950_000],
        ["DELL INSPIRON 5459 :\nCPU I5 6200U - RAM 4GB - Ổ SSD 128GB - 14INCH\nGIÁ THU VỀ 1T9", "Core i5 6200U", "SSD 128GB", 1_900_000],
        ["DELL PRECISION 7510 : CORE I7 6820HQ - RAM 8GB - NVME 256 - CARD QUADRO M1000M - GIÁ THU VỀ 3t950", "Core i7 6820HQ", "NVME 256GB", 3_950_000],
    ])("parses current group format", (content, cpu, storage, price) => {
        expect(parseLaptopPost(content)).toMatchObject({ ok: true, fields: { cpu, storage, price } });
    });

    it("keeps a CPU without a generation suffix instead of swallowing the next label", () => {
        // MacBook posts write "CPU CORE I5" with no model number.
        expect(parseLaptopPost(
            "MACBOOK AIR 13.3 2019 :\nCPU CORE I5 - RAM 8GB - SSD 128GB - MÀN 2K RETINA\nGIÁ 5 TRIỆU",
        )).toMatchObject({ ok: true, fields: { cpu: "Core i5", ram: "8GB" } });
    });

    it("drops the separator publishers put after the title", () => {
        expect(parseLaptopPost(
            "DELL LATITUDE 7490 :\nCPU CORE I5 8350U - RAM 8GB - Ổ SSD 256GB\nGIÁ 5 TRIỆU",
        )).toMatchObject({ ok: true, fields: { productName: "Dell Latitude 7490" } });
    });

    it.each([
        ["GIÁ THU VỀ 6", 6_000_000],
        ["GIÁ THU VỀ 12", 12_000_000],
        ["GIÁ THU VỀ 800", 800_000],
        ["Giá thu về 900 cả sạc", 900_000],
    ])("reads a bare price as millions below 100 and thousands above (%s)", (priceText, price) => {
        expect(parseLaptopPost(
            `LENOVO IDEAPAD 120S :\nCHIP INTEL N3350 - RAM 2GB - SSD 32GB\n${priceText}`,
        )).toMatchObject({ ok: true, fields: { price } });
    });

    it.each([
        ["DELL GAMING 7559 :\nCPU I5 6300HQ - RAM 8GB - SSD 128GB - CARD GTX960M - 15.6INCH FHD\nGIÁ 3 TRIỆU", "GTX960M"],
        ["DELL PRECISION 3561 :\nCHIP I7 11850H - RAM 16GB - Ổ SSD 512GB - CARD QUADRO T1200\nGIÁ THU VỀ 9", "QUADRO T1200"],
        ["ASUS TUF :\nCPU I5 10300H - RAM 8GB - SSD 512GB - NVIDIA GTX1650 4G - 15.6 INCH\nGIÁ 10 TRIỆU", "NVIDIA GTX1650 4G"],
    ])("extracts the graphics card from the current group format", (content, gpu) => {
        expect(parseLaptopPost(content)).toMatchObject({ ok: true, fields: { gpu } });
    });

    it.each([
        ["MÀN 15.6 INCH FULLHD", "15.6 INCH FULLHD"],
        ["MÀN 14INCH FHD IPS", "14INCH FHD IPS"],
        // The label is often dropped entirely.
        ["15.6INCH FHD", "15.6INCH FHD"],
        ["13.3 INCH 2K RETINA", "13.3 INCH 2K RETINA"],
    ])("extracts the display with or without its label (%s)", (displayText, display) => {
        expect(parseLaptopPost(
            `HP LAPTOP 15 :\nCPU I5 1135G7 - RAM 8GB - Ổ SSD 256GB - ${displayText}\nGIÁ 5 TRIỆU`,
        )).toMatchObject({ ok: true, fields: { display } });
    });

    it("does not invent a GPU from a label with no model after it", () => {
        const parsed = parseLaptopPost(
            "HP LAPTOP 15 :\nCPU I5 1135G7 - RAM 8GB - Ổ SSD 256GB - MÀN 15.6 FHD\nGIÁ 5 TRIỆU",
        );
        expect(parsed.ok && parsed.fields.gpu).toBeFalsy();
    });

    it("uppercases chip model codes rather than title-casing them", () => {
        expect(parseLaptopPost(
            "LENOVO IDEAPAD 120S :\nCHIP INTEL N3350 - RAM 2GB - SSD 32GB\nGIÁ THU VỀ 800",
        )).toMatchObject({ ok: true, fields: { cpu: "Intel N3350" } });
    });
});
