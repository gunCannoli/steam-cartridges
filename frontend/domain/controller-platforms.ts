/**
 * Controller support from where a game was released (ADR-0073). A game released on a console, a handheld or an
 * arcade board is played with a controller there, so its shortcut gets Full Controller Support. The platforms come
 * from the game's metadata: IGDB's platform names and abbreviations, ScreenScraper's system ("PlayStation 4", "PS4").
 * A PC, Mac, Linux, web or phone release says nothing: never "no controller", only "unknown".
 * Pure, `import type` free, so Node runs the unit tests.
 */

/** Platform names (whole words, any case) of controller systems. */
const CONTROLLER_PLATFORMS: readonly RegExp[] = [
    // Sony
    /\bplay ?station\b/i, /\bps(?:x|one|1|2|3|4|5|p)\b/i, /\bps ?vita\b/i, /\bvita\b/i,
    // Microsoft
    /\bxbox\b/i, /\bx(?:360|one)\b/i, /\bseries [xs]\b/i,
    // Nintendo
    /\bnintendo\b/i, /\bswitch\b/i, /\bwii\b/i, /\bwii ?u\b/i, /\bgame ?cube\b/i, /\bngc\b/i, /\bn64\b/i,
    /\b(?:s?nes|famicom|super famicom)\b/i, /\bgame ?boy\b/i, /\bgb[ac]?\b/i, /\b(?:n|3)ds\b/i, /\bvirtual boy\b/i,
    // Sega
    /\bsega\b/i, /\bgenesis\b/i, /\bmega ?drive\b/i, /\bmaster system\b/i, /\bsaturn\b/i, /\bdreamcast\b/i,
    /\bgame gear\b/i, /\b32x\b/i,
    // Others
    /\bneo ?geo\b/i, /\bturbo ?grafx\b/i, /\bpc[ -]?engine\b/i, /\bsupergrafx\b/i, /\batari (?:2600|5200|7800)\b/i,
    /\bjaguar\b/i, /\blynx\b/i, /\b3do\b/i, /\bouya\b/i, /\bstadia\b/i, /\bluna\b/i, /\bintellivision\b/i,
    /\bcolecovision\b/i, /\bvectrex\b/i, /\bwonderswan\b/i, /\barcade\b/i,
];

/** The platform names of a metadata record, whatever shape they arrived in (Lua writes an empty list as `{}`). */
export function platformNames(v: unknown): string[] {
    if (typeof v === 'string') return v ? [v] : [];
    const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : [];
    return list.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** True when one of the platforms is a controller system; undefined when none is (unknown, never false). */
export function controllerFromPlatforms(platforms: unknown): true | undefined {
    for (const name of platformNames(platforms)) {
        if (CONTROLLER_PLATFORMS.some((re) => re.test(name))) return true;
    }
    return undefined;
}
