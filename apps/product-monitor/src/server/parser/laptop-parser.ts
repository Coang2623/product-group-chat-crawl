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
const PRICE_PATTERN = /(?<![\p{L}\p{N}_])(?:GIÁ|GIA)(?![\p{L}\p{N}_])(?:[ \t]+THU[ \t]+VỀ)?[ \t]*:?[ \t]*\d+[ \t]*(?:TRIỆU|TRIEU)(?![\p{L}\p{N}_])(?:[ \t]+\d{1,3})?(?![ \t]*\d)/iu;
const PRICE_VALUE_PATTERN = /(?<![\p{L}\p{N}_])(\d+)[ \t]*(?:TRIỆU|TRIEU)(?![\p{L}\p{N}_])(?:[ \t]+(\d{1,3}))?(?![ \t]*\d)/iu;
const LAPTOP_NAME_PATTERN = /^(.*?)(?:\s*[-–]\s*|\s+)(?=(?:CPU\s*)?(?:CORE\s+I[3579]\s*[- ]?\w+|M[123]\b))/i;
const LAPTOP_FAMILY_PATTERN = /\b(?:MACBOOK|PROBOOK|ZBOOK|ELITEBOOK|THINKPAD|IDEAPAD|THINKBOOK|YOGA|LATITUDE|VIVOBOOK|ZENBOOK|SWIFT|TRAVELMATE|SURFACE[ \t]+LAPTOP|CHROMEBOOK|LAPTOP)\b/i;
const DESKTOP_MARKER_PATTERN = /\b(?:DESKTOP|TOWER|AIO|ALL[ -]?IN[ -]?ONE)\b/i;
const CANONICAL_PRODUCT_WORDS: Record<string, string> = {
    HP: "HP",
    MACBOOK: "MacBook",
    PROBOOK: "ProBook",
    ZBOOK: "ZBook",
    ELITEBOOK: "EliteBook",
    THINKPAD: "ThinkPad",
    IDEAPAD: "IdeaPad",
    THINKBOOK: "ThinkBook",
    VIVOBOOK: "VivoBook",
    ZENBOOK: "ZenBook",
    TRAVELMATE: "TravelMate",
    CHROMEBOOK: "Chromebook",
};

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
    const legacy = parseLegacyLaptopPost(content);
    if (legacy.ok) return legacy;
    return parseModernLaptopPost(content);
}

const parseLegacyLaptopPost = (content: string): LaptopParseResult => {
    if (DESKTOP_MARKER_PATTERN.test(content)) return unrecognized();

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

/** Parser for the current group's Unicode text and shorthand sales format. */
const parseModernLaptopPost = (content: string): LaptopParseResult => {
    const normalized = normalizeModern(content);
    if (/\b(?:desktop|tower|aio|all[ -]?in[ -]?one|prodesk|optiplex|bo may cay|may cay|bo may van phong)\b/iu.test(normalized)) return unrecognized();

    const priceMatch = normalized.match(/\bgia(?:\s+thu\s+ve|\s+ca\s+bo)?\b\s*[:;]?\s*(?:(\d+)\s*(trieu|t)\s*(\d{1,3})?|([0-9]{3,4})(?!\d))/iu);
    if (!priceMatch) return unrecognized();
    const primary = normalized.slice(0, priceMatch.index);
    const firstLine = primary.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    const candidateName = firstLine?.split(/\s*:\s*/u)[0].replace(/\s*[-–]\s*$/u, "");
    const productName = candidateName && !/^(?:cpu|chip|core|ram|ssd|nvme|hdd)\b/iu.test(candidateName)
        ? formatModernProductName(candidateName)
        : null;
    const cpuMatch = primary.match(/(?:cpu|chip)?\s*(?:(?:core)\s*)?(i[3579](?:\s*[- ]?\w+)?|ryzen\s*[3579]\s*\w+|m[123](?:\s*(?:pro|max))?|intel\s+(?:ultra\s+\d+\s+\w+|n\d+\w*))/iu);
    const ramMatch = primary.match(/\bram(?:\s+ddr\d*)?\s*:?[ \t]*(\d+)\s*(?:gb|g)\b/iu);
    let storageMatches: RegExpMatchArray[] = [...primary.matchAll(/\b(ssd|nvme|hdd)\s*:?[ \t]*(\d+)\s*(gb|tb|b|g)?\b/giu)];
    if (!storageMatches.length) {
        storageMatches = [...primary.matchAll(/\b(?:o|bo nho)\s*:?[ \t]*(\d+)\s*(gb|tb|b|g)\b/giu)].map((match) => {
            const synthetic = [match[0], "ssd", match[1], match[2]] as RegExpMatchArray;
            return synthetic;
        });
    }
    if (!productName || !cpuMatch || !ramMatch || !storageMatches.length) return unrecognized();

    const millions = priceMatch[1] ? Number(priceMatch[1]) : 0;
    const fraction = priceMatch[3] ? Number(priceMatch[3].padEnd(3, "0")) : 0;
    const price = priceMatch[4] ? Number(priceMatch[4]) * 1_000 : millions * 1_000_000 + fraction * 1_000;
    if (!Number.isSafeInteger(price) || price <= 0) return unrecognized();
    const storage = storageMatches.map((match) => `${match[1].toUpperCase()} ${match[2]}${(match[3] ?? "GB").replace(/^(?:b|g)$/iu, "GB").toUpperCase()}`).join(" + ");
    const cpuRaw = cpuMatch[1].replace(/\s+/g, " ").replace(/\s*-\s*/g, " ").trim()
        .replace(/[a-z]$/iu, (suffix) => suffix.toUpperCase());
    const cpu = /^(?:i[3579])/iu.test(cpuRaw)
        ? `Core ${cpuRaw.replace(/^i([3579])/iu, (_value, series: string) => `i${series}`)}`
        : capitalizeModern(cpuRaw).replace(/[a-z]$/iu, (suffix) => suffix.toUpperCase());

    return {
        ok: true,
        fields: {
            productName,
            cpu,
            ram: `${ramMatch[1]}GB`,
            storage,
            price,
            rawPrice: priceMatch[0],
        },
    };
};

const normalizeModern = (content: string): string => content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/giu, "d")
    .replace(/\s+/gu, " ");

const formatModernProductName = (value: string): string => value
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => {
        const upper = word.toUpperCase();
        if (/^(?:DELL|HP|ASUS|ACER|MSI|LENOVO|MACBOOK|PROBOOK|VIVOBOOK|THINKPAD|IDEAPAD|PRECISION|PAVILION|INSPIRON|LATITUDE|ZENBOOK|SURFACE)$/u.test(upper)) return upper === "MACBOOK" ? "MacBook" : capitalizeModern(word);
        return /^\d|^[A-Z]+\d|\d[A-Z]/u.test(word) ? upper : capitalizeModern(word);
    })
    .join(" ");

const capitalizeModern = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

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
            if (CANONICAL_PRODUCT_WORDS[upper]) return CANONICAL_PRODUCT_WORDS[upper];
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
