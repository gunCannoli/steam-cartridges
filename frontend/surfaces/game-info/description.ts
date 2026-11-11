/**
 * Truncate game description to around maxLen characters, breaking at the closest sentence boundary.
 * If sentence boundaries exist, picks the one closest to maxLen (can be slightly under or over).
 */
export function truncateDescription(text: string, maxLen: number = 360): string {
    if (!text || text.length <= maxLen) return text;
    // Match sentence ending punctuation (.!?) followed by any closing quote/bracket and whitespace or end of string
    const re = /[.!?]+["'’\)\]}]*(?=[\s\r\n]|$)/g;
    let match: RegExpExecArray | null;
    let bestIndex = -1;
    let bestDiff = Infinity;

    while ((match = re.exec(text)) !== null) {
        const endIndex = match.index + match[0].length;
        const diff = Math.abs(endIndex - maxLen);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIndex = endIndex;
        }
    }

    if (bestIndex > 0) {
        return text.slice(0, bestIndex).trim();
    }

    // Fallback: word boundary closest to maxLen
    const spaceRe = /\s+/g;
    let spaceMatch: RegExpExecArray | null;
    while ((spaceMatch = spaceRe.exec(text)) !== null) {
        const diff = Math.abs(spaceMatch.index - maxLen);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIndex = spaceMatch.index;
        }
    }
    if (bestIndex > 0) {
        return text.slice(0, bestIndex).trim() + "...";
    }

    return text.slice(0, maxLen).trim();
}
