// Port: fetch an image over HTTP for app/artwork (the four slots and the icon). Read-only network I/O; it
// never touches Steam. The backend cannot do this: Millennium's Lua http.get cuts a binary body at
// its first NUL byte (icon plan § 11).

/** Bytes of one image URL as base64, or null. SteamGridDB's CDN blocks cross-origin fetches: retry through wsrv.nl. */
export async function fetchImage(url: string, forcePng = false): Promise<{ base64: string; ext: string } | null> {
    const attempt = async (target: string): Promise<Blob | null> => {
        try {
            const resp = await fetch(target);
            if (!resp.ok) return null;
            const blob = await resp.blob();
            return blob.size >= 100 ? blob : null;
        } catch {
            return null;
        }
    };
    let blob = await attempt(url);
    if (!blob && url.includes('steamgriddb.com')) blob = await attempt('https://wsrv.nl/?url=' + url.replace(/^https?:\/\//, '') + (forcePng ? '&output=png' : ''));
    if (!blob) return null;
    const found = blob;
    const base64 = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result ? result.substring(result.indexOf(',') + 1) : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(found);
    });
    if (!base64) return null;
    if (forcePng) return { base64, ext: 'png' };
    const lower = url.toLowerCase();
    const ext = found.type === 'image/jpeg' || lower.includes('.jpg') || lower.includes('.jpeg') ? 'jpg' : found.type === 'image/x-icon' || lower.includes('.ico') ? 'ico' : 'png';
    return { base64, ext };
}

/**
 * An object URL (blob:) for image bytes the backend sent as base64 (features plan F2b), or null. The bytes stay in
 * memory until releaseObjectUrl; nothing is written to disk and the URL names no host (a ScreenScraper URL carries the
 * account, so it never reaches Steam's DOM).
 */
export function objectUrl(base64: string, ext: string): string | null {
    try {
        const clean = base64.trim().replace(/\s+/g, '');
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const type = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'application/octet-stream';
        return URL.createObjectURL(new Blob([bytes], { type }));
    } catch {
        return null;
    }
}

/** The bytes behind an object URL (blob:) as base64, or null. */
export async function objectUrlToBase64(url: string): Promise<string | null> {
    try {
        const blob = await (await fetch(url)).blob();
        return await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result as string;
                resolve(result ? result.substring(result.indexOf(',') + 1) : null);
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

/** Free an object URL made by objectUrl (the media bin calls it on eviction). */
export function releaseObjectUrl(url: string): void {
    try {
        URL.revokeObjectURL(url);
    } catch {
        /* already released */
    }
}
