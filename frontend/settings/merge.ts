// Where a setting's value comes from at start-up (ADR-0090): the backend's copy (settings_store.lua) first, because every
// change is written to it and a Configuration API that loses or ignores writes cannot make it stale; Millennium's
// Configuration API for a key the copy does not have yet (an install from before the copy existed). Pure, so Node runs the tests.

export interface Merged {
    /** key -> the value to apply (a key neither source has is left out: the default). */
    values: Record<string, unknown>;
    /** Keys the Configuration API lacks or holds differently: written back to it. */
    heal: string[];
    /** Keys only the Configuration API had: written to the backend copy (first start after the update). */
    seed: Record<string, unknown>;
}

/** JSON with sorted keys: the same value from two stores compares equal whatever order each wrote its keys in (a mismatch healed every sync). */
function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'undefined';
}

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

export function mergeStored(keys: readonly string[], stored: Record<string, unknown>, mirror: Record<string, unknown>): Merged {
    const out: Merged = { values: {}, heal: [], seed: {} };
    for (const key of keys) {
        if (has(mirror, key)) {
            out.values[key] = mirror[key];
            if (canonical(stored[key]) !== canonical(mirror[key])) out.heal.push(key);
        } else if (has(stored, key)) {
            out.values[key] = stored[key];
            out.seed[key] = stored[key];
        }
    }
    return out;
}

/** A Configuration API answer that holds at least one key (an empty or missing answer is the failure this guards against). */
export function hasKeys(answer: unknown): answer is Record<string, unknown> {
    return !!answer && typeof answer === 'object' && Object.keys(answer as object).length > 0;
}
