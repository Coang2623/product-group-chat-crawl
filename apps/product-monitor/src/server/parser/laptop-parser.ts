export type ParsedLaptopFields = {
    productName: string;
    cpu: string;
    ram: string;
    storage: string;
    gpu?: string;
    display?: string;
    price: number;
    rawPrice: string;
    notes?: string;
};

export type LaptopParseResult =
    | { ok: true; fields: ParsedLaptopFields }
    | { ok: false; fields: Record<string, never>; reason: "structure_not_recognized" };

const CORE_FIELD_PATTERNS = {
    cpu: /\b(?:CPU\s*)?(?:CORE\s+I([3579])\s*[- ]?\s*([A-Z0-9]+)|(M[123]))\b/i,
    ram: /\bRAM\s*:?\s*(\d+\s*GB)\b/i,
    storage: /\b(?:Ổ\s*)?(SSD|HDD)\s*:?\s*(\d+\s*(?:GB|TB))\b/i,
    gpu: /\b(?:CARD|GPU)\s*:?\s*([^\-–\n]+)/i,
    display: /\b(?:MÀN|MAN)(?:\s+(?:HÌNH|HINH))?\s*:?\s*([^\-–\n]+)/i,
};

const PRICE_LABEL_PATTERN = /(?<![\p{L}\p{N}_])(?:GIÁ|GIA)(?![\p{L}\p{N}_])/iu;
const PRICE_PATTERN = /(?<![\p{L}\p{N}_])(?:GIÁ|GIA)(?![\p{L}\p{N}_])(?:\s+THU\s+VỀ)?\s*:?\s*\d+\s*(?:TRIỆU|TRIEU)(?![\p{L}\p{N}_])(?:\s+\d{1,3})?(?!\s*\d)/iu;
const PRICE_VALUE_PATTERN = /(?<![\p{L}\p{N}_])(\d+)\s*(?:TRIỆU|TRIEU)(?![\p{L}\p{N}_])(?:\s+(\d{1,3}))?(?!\s*\d)/iu;
const LAPTOP_NAME_PATTERN = /^(.*?)(?:\s*[-–]\s*|\s+)(?=(?:CPU\s*)?(?:CORE\s+I[3579]\s*[- ]?\w+|M[123]\b))/i;
const LAPTOP_FAMILY_PATTERN = /\b(?:MACBOOK|PROBOOK|ZBOOK|ELITEBOOK|PAVILION|ENVY|OMEN|SPECTRE|THINKPAD|IDEAPAD|LEGION|THINKBOOK|YOGA|LOQ|LATITUDE|INSPIRON|VOSTRO|PRECISION|XPS|ALIENWARE|VIVOBOOK|ZENBOOK|EXPERTBOOK|ROG|TUF|ASPIRE|SWIFT|TRAVELMATE|NITRO|PREDATOR|CHROMEBOOK|SURFACE\s+LAPTOP|MSI\s+(?:MODERN|KATANA|STEALTH|PRESTIGE|BRAVO|GF|GS)|LAPTOP)\b/i;

export function parseVietnamesePrice(raw: string): number | null {
    if (/(?:GIÁ|GIA)/iu.test(raw) && !PRICE_LABEL_PATTERN.test(raw)) return null;

    const match = raw.match(PRICE_VALUE_PATTERN);
    if (!match) return null;

    const millions = Number(match[1]);
    const fractionalPart = match[2];
    if (!Number.isSafeInteger(millions)) return null;

    const fraction = fractionalPart ? Number(fractionalPart.padEnd(3, "0")) * 1_000 : 0;
    return millions * 1_000_000 + fraction;
}

export function parseLaptopPost(content: string): LaptopParseResult {
    const priceMatch = PRICE_PATTERN.exec(content);
    if (!priceMatch) return unrecognized();

    const price = parseVietnamesePrice(priceMatch[0]);
    const primaryConfiguration = content.slice(0, priceMatch.index);
    const productName = extractProductName(primaryConfiguration);
    const cpu = extractCpu(primaryConfiguration);
    const ram = extractRam(primaryConfiguration);
    const storage = extractStorage(primaryConfiguration);

    if (!productName || !isRecognizedLaptopFamily(productName) || !cpu || !ram || !storage || price === null) return unrecognized();

    const fields: ParsedLaptopFields = {
        productName,
        cpu,
        ram,
        storage,
        price,
        rawPrice: priceMatch[0],
    };
    const gpu = extractGpu(primaryConfiguration);
    const display = extractDisplay(primaryConfiguration);
    const notes = collectNotes(primaryConfiguration, content.slice(priceMatch.index + priceMatch[0].length));

    if (gpu) fields.gpu = gpu;
    if (display) fields.display = display;
    if (notes) fields.notes = notes;

    return { ok: true, fields };
}

function extractProductName(primaryConfiguration: string): string | null {
    const firstLine = primaryConfiguration.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return null;

    const match = firstLine.match(LAPTOP_NAME_PATTERN);
    const candidate = (match?.[1] ?? firstLine).trim();
    if (!candidate || /^(?:CPU\s*)?(?:CORE\s+I[3579]|M[123])\b/i.test(candidate)) return null;

    return formatProductName(candidate);
}

function extractCpu(primaryConfiguration: string): string | null {
    const match = primaryConfiguration.match(CORE_FIELD_PATTERNS.cpu);
    if (!match) return null;

    if (match[3]) return match[3].toUpperCase();
    return `Core i${match[1]} ${match[2].toUpperCase()}`;
}

function extractRam(primaryConfiguration: string): string | null {
    const value = primaryConfiguration.match(CORE_FIELD_PATTERNS.ram)?.[1];
    return value ? normalizeCapacity(value) : null;
}

function extractStorage(primaryConfiguration: string): string | null {
    const match = primaryConfiguration.match(CORE_FIELD_PATTERNS.storage);
    return match ? `${match[1].toUpperCase()} ${normalizeCapacity(match[2])}` : null;
}

function extractGpu(primaryConfiguration: string): string | null {
    const value = primaryConfiguration.match(CORE_FIELD_PATTERNS.gpu)?.[1];
    return value ? formatWords(value) : null;
}

function extractDisplay(primaryConfiguration: string): string | null {
    const value = primaryConfiguration.match(CORE_FIELD_PATTERNS.display)?.[1];
    return value ? collapseWhitespace(value).toUpperCase() : null;
}

function collectNotes(primaryConfiguration: string, contentAfterPrice: string): string | null {
    const primarySegments = primaryConfiguration
        .split(/\r?\n|\s+[-–]\s+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
    const primaryNotes = primarySegments.slice(1).filter((segment) => !isStructuredField(segment));
    const trailingNotes = contentAfterPrice.trim();
    const notes = [...primaryNotes, trailingNotes].filter(Boolean).join("\n");

    return notes || null;
}

function isRecognizedLaptopFamily(productName: string): boolean {
    return LAPTOP_FAMILY_PATTERN.test(productName);
}

function isStructuredField(segment: string): boolean {
    return Object.values(CORE_FIELD_PATTERNS).some((pattern) => pattern.test(segment));
}

function formatProductName(value: string): string {
    return collapseWhitespace(value)
        .split(" ")
        .map((word) => {
            const upper = word.toUpperCase();
            if (upper === "HP") return "HP";
            if (upper === "MACBOOK") return "MacBook";
            if (upper === "PROBOOK") return "ProBook";
            if (upper === "ZBOOK") return "ZBook";
            if (/^\d/.test(word)) return word.toUpperCase();
            return capitalize(word);
        })
        .join(" ");
}

function formatWords(value: string): string {
    return collapseWhitespace(value)
        .split(" ")
        .map((word) => /^\d|^[A-Z]\d|\d[A-Z0-9]*$/i.test(word) ? word.toUpperCase() : capitalize(word))
        .join(" ");
}

function normalizeCapacity(value: string): string {
    return collapseWhitespace(value).replace(/\s+(?=(?:GB|TB)$)/i, "").toUpperCase();
}

function collapseWhitespace(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function unrecognized(): LaptopParseResult {
    return { ok: false, fields: {}, reason: "structure_not_recognized" };
}
