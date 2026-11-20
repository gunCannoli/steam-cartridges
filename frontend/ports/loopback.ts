// Steam's loopback image server, asked directly (network I/O stays in ports/, ADR-0044).

/**
 * Ask Steam's loopback server for an image itself, bypassing the browser's cache: an <img> of a file deleted by hand can still
 * be drawn from the cache, so the image element alone cannot see the deletion. Resolves with the HTTP status, or `undefined`
 * when the request could not be made (the caller then falls back to the image element).
 */
export async function loopbackStatus(url: string, timeoutMs = 4000): Promise<number | undefined> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        clearTimeout(timer);
        controller.abort(); // the headers are enough; do not download a 4K image
        return response.status;
    } catch {
        return undefined;
    }
}
