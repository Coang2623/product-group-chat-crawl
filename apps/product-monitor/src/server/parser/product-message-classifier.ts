const normalize = (content: string): string => content
    .toLocaleLowerCase("vi")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\u0111/gu, "d");

const HARDWARE_SIGNALS = [
    /\b(?:cpu|chip|core|ryzen|intel)\b/u,
    /\bram\b/u,
    /\b(?:ssd|nvme|hdd|bo nho)\b/u,
    /\b(?:man|inch|fhd|fullhd|oled|retina)\b/u,
    /\b(?:card|gpu|gtx|rtx|quadro|radeon)\b/u,
] as const;

/** Keeps malformed product posts reviewable while rejecting ordinary group chatter. */
export const isProductInformation = (content: string): boolean => {
    const normalized = normalize(content);
    const hardwareSignalCount = HARDWARE_SIGNALS.filter((signal) => signal.test(normalized)).length;
    const hasPrice = /\bgia\b/u.test(normalized);
    return (hasPrice && hardwareSignalCount >= 2) || hardwareSignalCount >= 3;
};
