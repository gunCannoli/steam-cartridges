// Pure helpers of the media sensors (no imports, so a test can load them alone).

/** What a capture URL is, from its shape alone. */
export function captureKind(url: string): "screenshot" | "thumbnail" | "clip" | "recording" | undefined {
    if (typeof url !== "string") return undefined;
    if (url.includes("/screenshots/thumbnails/")) return "thumbnail";
    if (url.includes("/screenshots/")) return "screenshot";
    if (url.includes("/gamerecordings/clips/")) return "clip";
    if (url.includes("/gamerecordings/")) return "recording";
    return undefined;
}
