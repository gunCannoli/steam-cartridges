// Port: a PDF's pages as images, for app/manuals (features plan F2c, ADR-0048). The only file that uses pdf.js
// (pdfjs-dist 4.10.38, pinned: 5.4 and 6.3 hang in getDocument in Steam's Chromium 126, verified live 2026-10-01).
// pdf.js and its worker are embedded as text at build time (constSysfsExpr) and loaded from blob: URLs the first time a
// manual opens, so Steam's start-up never evaluates them. Pages are drawn on an OffscreenCanvas and handed out as JPEG
// object URLs. While a document is open pdf.js adds its fonts to the document's FontFaceSet; destroy() removes them
// (verified live 2026-10-01). It never touches Steam.
import { constSysfsExpr } from "@steambrew/client";
import type * as PdfJs from "pdfjs-dist";

const PDFJS_SOURCE = constSysfsExpr("pdf.min.mjs", { basePath: "../../node_modules/pdfjs-dist/build", encoding: "utf8" }).content;
const WORKER_SOURCE = constSysfsExpr("pdf.worker.min.mjs", { basePath: "../../node_modules/pdfjs-dist/build", encoding: "utf8" }).content;

/** JPEG quality of a rendered page. */
const PAGE_QUALITY = 0.85;

/** One open PDF. */
export interface PdfDocument {
    pageCount: number;
    /** Page 1's size in PDF points: the viewer reserves every page's space with it. */
    pageWidth: number;
    pageHeight: number;
    /** Page `n` (1-based) drawn `width` pixels wide, as an object URL (blob:), or null. */
    renderPage(n: number, width: number): Promise<string | null>;
    /** Page 1 alone, fitted inside `width` x `height` at its own ratio (a card cover), as an object URL (blob:), or null. */
    renderCover(width: number, height: number): Promise<string | null>;
    /** Frees the document, its worker-side data and its fonts. */
    destroy(): void;
}

export interface PdfRenderer {
    /** The PDF whose bytes are the base64 `chunks` in order, or null when it does not parse. */
    open(chunks: readonly string[]): Promise<PdfDocument | null>;
}

let library: Promise<typeof PdfJs> | undefined;

function blobUrl(source: string): string {
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

/** pdf.js, evaluated once, with one module worker for every document. */
function load(): Promise<typeof PdfJs> {
    if (!library) {
        library = (async () => {
            const pdfjs = (await import(blobUrl(PDFJS_SOURCE))) as typeof PdfJs;
            pdfjs.GlobalWorkerOptions.workerPort = new Worker(blobUrl(WORKER_SOURCE), { type: "module" });
            return pdfjs;
        })();
        library.catch(() => (library = undefined));
    }
    return library;
}

function bytesOf(chunks: readonly string[]): Uint8Array {
    const parts = chunks.map((chunk) => {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    });
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

export const pdfRenderer: PdfRenderer = {
    async open(chunks) {
        try {
            const pdfjs = await load();
            const doc = await pdfjs.getDocument({ data: bytesOf(chunks), isEvalSupported: false }).promise;
            const first = (await doc.getPage(1)).getViewport({ scale: 1 });
            return {
                pageCount: doc.numPages,
                pageWidth: first.width,
                pageHeight: first.height,
                async renderPage(n, width) {
                    try {
                        const page = await doc.getPage(n);
                        const natural = page.getViewport({ scale: 1 });
                        const viewport = page.getViewport({ scale: width / natural.width });
                        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                        const context = canvas.getContext("2d");
                        if (!context) return null;
                        await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
                        page.cleanup();
                        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: PAGE_QUALITY });
                        return URL.createObjectURL(blob);
                    } catch {
                        return null;
                    }
                },
                async renderCover(width, height) {
                    try {
                        const page = await doc.getPage(1);
                        const natural = page.getViewport({ scale: 1 });
                        // The cover is the page alone, at the page's own ratio, fitted inside `width` x `height`: Steam's image viewer
                        // draws the image at its own size, so any margin on the canvas would show as a border around the page.
                        const viewport = page.getViewport({ scale: Math.min(height / natural.height, width / natural.width) });
                        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                        const context = canvas.getContext("2d");
                        if (!context) return null;
                        await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
                        page.cleanup();
                        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: PAGE_QUALITY });
                        return URL.createObjectURL(blob);
                    } catch {
                        return null;
                    }
                },
                destroy() {
                    void doc.destroy().catch(() => {});
                },
            };
        } catch {
            return null;
        }
    },
};
