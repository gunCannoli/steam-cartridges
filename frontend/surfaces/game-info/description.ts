/**
 * Shorten a game description to at most maxLen characters. It ends at the last sentence end that fits, when that keeps at
 * least half of maxLen; otherwise it ends at the last word that fits and adds "...". Never longer than maxLen (plus the dots).
 */
export function truncateDescription(text: string, maxLen: number = 360): string {
    if (!text || text.length <= maxLen) return text;
    // Sentence ending punctuation (.!?) followed by any closing quote/bracket and whitespace or end of string
    const re = /[.!?]+["'’)\]}]*(?=[\s]|$)/g;
    let match: RegExpExecArray | null;
    let sentenceEnd = -1;
    while ((match = re.exec(text)) !== null) {
        const endIndex = match.index + match[0].length;
        if (endIndex <= maxLen) sentenceEnd = endIndex;
        else break;
    }
    if (sentenceEnd >= maxLen / 2) return text.slice(0, sentenceEnd).trim();

    // Word boundary at or before maxLen
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.search(/\s+\S*$/);
    const base = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:-]+$/, "");
    return base + "...";
}
