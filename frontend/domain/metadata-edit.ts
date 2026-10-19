// domain/metadata-edit: the pure rules of the Game Data editor (features plan F1).
// The form works on a MetadataDraft (strings only, what the inputs hold); applyDraft() turns a draft
// back into the GameMetadata the backend stores. No Steam, no I/O, `import type` from kernel/ only.
import type { GameCategories, GameMetadata } from "../kernel/record";

export type FieldKind = "text" | "textarea" | "list" | "date";
export type TextFieldKey = "title" | "description" | "developers" | "publishers" | "franchises" | "genres" | "release_date" | "original_release_date";

export interface EditableField {
    key: TextFieldKey;
    label: string;
    kind: FieldKind;
}

/** The fields Steam's Game Info shows (surfaces/game-info/metadata.ts enrichGameDetails), in form order. */
export const EDITABLE_FIELDS: readonly EditableField[] = [
    { key: "title", label: "Title", kind: "text" },
    { key: "description", label: "Description", kind: "textarea" },
    { key: "developers", label: "Developers", kind: "list" },
    { key: "publishers", label: "Publishers", kind: "list" },
    { key: "franchises", label: "Franchises", kind: "list" },
    { key: "genres", label: "Genres", kind: "list" },
    { key: "release_date", label: "Release date", kind: "date" },
    { key: "original_release_date", label: "First release", kind: "date" },
];

export type PlayerFlag = "single_player" | "multiplayer" | "coop" | "split_screen";

/** The player badges. `id` is Steam's category id (surfaces/game-info/category-policy.ts PORTABLE_CATEGORY_IDS). */
export const PLAYER_FLAGS: readonly { flag: PlayerFlag; label: string; id: number }[] = [
    { flag: "single_player", label: "Single-player", id: 2 },
    { flag: "multiplayer", label: "Multi-player", id: 1 },
    { flag: "coop", label: "Co-op", id: 9 },
    { flag: "split_screen", label: "Shared/Split screen", id: 24 },
];

export interface MetadataDraft {
    title: string;
    description: string;
    /** Lists are one text each, entries separated by ";". */
    developers: string;
    publishers: string;
    franchises: string;
    genres: string;
    /** "YYYY-MM-DD" or "". */
    release_date: string;
    original_release_date: string;
    players: Record<PlayerFlag, boolean>;
}

/** What draftOf/diff need of a stored record. */
export type MetadataLike = Partial<GameMetadata> & { title: string };

/** A list field as stored: the backend writes an empty list as `{}` (web_metadata_db.lua format_json). */
export function listOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** "a; b;; a" -> ["a", "b"]. */
export function splitList(text: string): string[] {
    const out: string[] = [];
    for (const part of text.split(/[;\n]/)) {
        const v = part.trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Unix seconds -> "YYYY-MM-DD" (UTC); 0 or missing -> "". Civil-from-days arithmetic, so no Date object. */
export function formatDate(seconds: number | undefined): string {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
    const z = Math.floor(seconds / 86400) + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return `${pad(yoe + era * 400 + (month <= 2 ? 1 : 0), 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** "YYYY-MM-DD" -> unix seconds (UTC); "" -> 0; anything else (or a date that does not exist) -> undefined. */
export function parseDate(text: string): number | undefined {
    const t = text.trim();
    if (t === "") return 0;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!m) return undefined;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(ms) || formatDate(ms / 1000) !== t) return undefined;
    return ms / 1000;
}

/** The player flags as Steam's Game Info will show them: the category ids win when present (category-policy.ts). */
export function playerFlagsOf(meta: Pick<GameMetadata, "categories" | "store_category_ids">): Record<PlayerFlag, boolean> {
    const ids = Array.isArray(meta.store_category_ids) ? meta.store_category_ids : undefined;
    const out = {} as Record<PlayerFlag, boolean>;
    for (const { flag, id } of PLAYER_FLAGS) out[flag] = ids ? ids.includes(id) : meta.categories?.[flag] === true;
    return out;
}

export function draftOf(meta: MetadataLike): MetadataDraft {
    return {
        title: meta.title,
        description: meta.description ?? "",
        developers: listOf(meta.developers).join("; "),
        publishers: listOf(meta.publishers).join("; "),
        franchises: listOf(meta.franchises).join("; "),
        genres: listOf(meta.genres).join("; "),
        release_date: formatDate(meta.release_date),
        original_release_date: formatDate(meta.original_release_date),
        players: playerFlagsOf(meta),
    };
}

/** Human-readable problems that block Save; empty when the draft is valid. */
export function validate(draft: MetadataDraft): string[] {
    const errors: string[] = [];
    if (draft.title.trim() === "") errors.push("Title is required.");
    if (parseDate(draft.release_date) === undefined) errors.push("Release date must look like 2024-05-31.");
    if (parseDate(draft.original_release_date) === undefined) errors.push("First release must look like 2024-05-31.");
    return errors;
}

/** The keys of every field whose draft value differs from `original` (drives the Save button). */
export function diff(original: MetadataLike, draft: MetadataDraft): string[] {
    const before = draftOf(original);
    const changed: string[] = [];
    for (const { key } of EDITABLE_FIELDS) {
        if (before[key] !== draft[key]) changed.push(key);
    }
    for (const { flag } of PLAYER_FLAGS) {
        if (before.players[flag] !== draft.players[flag]) changed.push(flag);
    }
    return changed;
}

/**
 * The metadata to store for a valid draft: `original` with the edited fields replaced. Fields the form does
 * not show (source, steam_appid, controller flags, igdb_id, ...) are kept as they are. Throws on an invalid draft.
 *
 * Player badges: when `original` carries `store_category_ids` those win in Game Info, so a flag the user
 * changed is added to or removed from that list too (other ids, controller ones included, stay).
 */
export function applyDraft(original: GameMetadata, draft: MetadataDraft): GameMetadata {
    const errors = validate(draft);
    if (errors.length > 0) throw new Error(errors.join(" "));

    const next: GameMetadata = {
        ...original,
        title: draft.title.trim(),
        description: draft.description.trim(),
        developers: splitList(draft.developers),
        publishers: splitList(draft.publishers),
        franchises: splitList(draft.franchises),
        genres: splitList(draft.genres),
        release_date: parseDate(draft.release_date) ?? 0,
    };
    const first = parseDate(draft.original_release_date) ?? 0;
    if (first > 0) next.original_release_date = first;
    else delete next.original_release_date;

    const before = playerFlagsOf(original);
    const categories: GameCategories = { ...(original.categories ?? {}) };
    let ids = Array.isArray(original.store_category_ids) ? [...original.store_category_ids] : undefined;
    for (const { flag, id } of PLAYER_FLAGS) {
        categories[flag] = draft.players[flag];
        if (ids && before[flag] !== draft.players[flag]) {
            ids = draft.players[flag] ? [...ids, id] : ids.filter((x) => x !== id);
        }
    }
    next.categories = categories;
    if (ids) next.store_category_ids = [...new Set(ids)].sort((a, b) => a - b);
    return next;
}
