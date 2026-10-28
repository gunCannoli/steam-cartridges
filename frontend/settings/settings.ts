import { useEffect, useState } from 'react';
import { pluginConfig, subscribePluginConfig } from '@steambrew/client';
import { logger } from '../logger';
import { backend } from '../ports/backend';
import { hasKeys, mergeStored } from './merge';
import { DEFAULT_BUCKETS, validateConfig, type RoutingRule } from '../domain/routing/policy';
import { DEFAULTS, DEFAULT_SERVICES, MEDIA_CACHE_DAYS, type ControllerOverride, type SettingKey, type Settings } from './defaults';

export { DEFAULTS, DEFAULT_SERVICES, MEDIA_CACHE_DAYS };
export type { ControllerOverride, ServicesConfig, SettingKey, Settings } from './defaults';

/** Progress of the background sync (app/ingest.ts), for the panel (plan § 7.0 D3: never an import of app/). */
const VALIDATORS: { [K in SettingKey]: (raw: unknown) => Settings[K] } = {
    buckets: validateConfig,
    defaultFullController: (raw) => raw === true,
    raHardcoreMode: (raw) => raw !== false,
    activityShowAddedToLibrary: (raw) => raw === true,
    activityShowFirstPlayed: (raw) => raw === true,
    activityShowAchievements: (raw) => raw === true,
    communityShowTrailers: (raw) => raw === true,
    communityShowManuals: (raw) => raw === true,
    communityShowArtworks: (raw) => raw === true,
    communityShowExternalLinks: (raw) => raw === true,
    mediaCacheDays: (raw) =>
        typeof raw === 'number' && Number.isFinite(raw)
            ? Math.min(MEDIA_CACHE_DAYS.max, Math.max(MEDIA_CACHE_DAYS.min, Math.round(raw)))
            : MEDIA_CACHE_DAYS.default,
    disabledFeatures: (raw) => (typeof raw === 'string' ? raw : ''),
    routingRules: (raw) => Array.isArray(raw) ? (raw as RoutingRule[]) : [],
    services: (raw) => {
        if (!raw || typeof raw !== 'object') return DEFAULT_SERVICES;
        const r = raw as any;
        const emu = r.emulatorsEnabled !== undefined ? r.emulatorsEnabled === true : r.rpcs3Enabled === true;
        return {
            steamStoreEnabled: r.steamStoreEnabled === true,
            screenscraperEnabled: r.screenscraperEnabled === true,
            igdbEnabled: r.igdbEnabled === true,
            steamgriddbEnabled: r.steamgriddbEnabled === true,
            retroachievementsEnabled: r.retroachievementsEnabled === true,
            emulatorsEnabled: emu,
            nativePortsEnabled: r.nativePortsEnabled === true,
            rpcs3Enabled: emu,
        };
    },
    controllerOverrides: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, ControllerOverride>) : {}),
    ignoredIssues: (raw) => {
        const out: Record<string, boolean> = {};
        if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === true) out[k] = true;
        return out;
    },
};

const current: Settings = {
    buckets: DEFAULT_BUCKETS,
    defaultFullController: false,
    raHardcoreMode: true,
    routingRules: [],
    services: DEFAULT_SERVICES,
    controllerOverrides: {},
    ignoredIssues: {},
    activityShowAddedToLibrary: false,
    activityShowFirstPlayed: false,
    activityShowAchievements: false,
    communityShowTrailers: false,
    communityShowManuals: false,
    communityShowArtworks: false,
    communityShowExternalLinks: false,
    mediaCacheDays: MEDIA_CACHE_DAYS.default,
    disabledFeatures: '',
};
const listeners = new Set<(key: SettingKey) => void>();
/** The start-up settings-source line is logged once, not after every write (sync runs on each one). */
let sourceLogged = false;

function apply(key: string, value: unknown): void {
    if (!(key in DEFAULTS)) return;
    const k = key as SettingKey;
    let raw = value;
    if (typeof raw === 'string') {
        // Some Millennium builds hand JSON values back as strings; a key whose own value
        // is a plain string (e.g. disabledFeatures) fails to parse as JSON, so keep it as-is.
        try {
            raw = JSON.parse(raw);
        } catch {
            /* raw stays the original string */
        }
    }
    const next = raw === undefined || raw === null ? DEFAULTS[k] : VALIDATORS[k](raw);
    if (JSON.stringify(current[k]) === JSON.stringify(next)) return;
    (current as unknown as Record<string, unknown>)[k] = next;
    for (const listener of listeners) {
        try {
            listener(k);
        } catch (error) {
            logger.warn('Settings listener threw:', error);
        }
    }
}

type ConfigApi = {
    getAll(plugin: string): Promise<Record<string, unknown>>;
    set(plugin: string, key: string, value: unknown): Promise<void>;
    delete(plugin: string, key: string): Promise<void>;
};
type Ffi = (plugin: string, method: string) => (...args: unknown[]) => Promise<unknown>;

/** Our plugin name as Millennium loaded it (`-dev` copy or released). */
function pluginName(): string {
    const loaded = Reflect.get(globalThis, 'PLUGIN_LIST') as Record<string, unknown> | undefined;
    return ['steam-cartridges-dev', 'steam-cartridges'].find((n) => loaded && n in loaded) ?? 'steam-cartridges';
}

const config = pluginConfig as unknown as ConfigApi;

/**
 * The Configuration API's answer, trying Millennium's own FFI when `getAll` throws or answers with nothing (a build that
 * resolves empty instead of rejecting made every setting read as its default on each start, ADR-0090). The first empty
 * answer is returned when nothing has keys: a plugin with no saved setting is a real case.
 */
async function readStored(): Promise<Record<string, unknown>> {
    const name = pluginName();
    let first: Record<string, unknown> = {};
    try {
        const answer = await config.getAll(name);
        if (hasKeys(answer)) return answer;
        first = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
    } catch (error) {
        logger.warn('Configuration API getAll failed; trying the FFI.', error);
    }
    const ffi = (Reflect.get(globalThis, 'MILLENNIUM_API') as { ffi?: Ffi } | undefined)?.ffi;
    if (ffi) {
        try {
            const answer = await ffi('core', 'PluginConfig_GetAll')(name);
            if (hasKeys(answer)) return answer;
        } catch (error) {
            logger.warn('PluginConfig_GetAll failed.', error);
        }
    }
    return first;
}

/** The backend's copy of the settings (settings_store.lua); {} when it cannot be read. */
async function readMirror(): Promise<Record<string, unknown>> {
    try {
        const res = await backend.getSettings();
        return res?.values && typeof res.values === 'object' ? res.values : {};
    } catch (error) {
        logger.warn('Could not read the settings copy from the backend.', error);
        return {};
    }
}

async function writeMirror(change: { values?: Record<string, unknown>; remove?: string[] }): Promise<void> {
    try {
        const res = await backend.saveSettings(change);
        if (res?.error) logger.warn(`Settings copy not saved: ${res.error}`);
    } catch (error) {
        logger.warn('Settings copy not saved.', error);
    }
}

async function sync(): Promise<void> {
    const [stored, mirror] = await Promise.all([readStored(), readMirror()]);
    const merged = mergeStored(Object.keys(DEFAULTS), stored, mirror);
    for (const key of Object.keys(DEFAULTS)) apply(key, merged.values[key]);
    // Once per session: where the settings came from. A config API that answers with nothing is the ADR-0090 case
    // (every setting reads as its default), and it shows here as 0 keys next to the backend copy's count.
    if (!sourceLogged) {
        sourceLogged = true;
        backend.logEvent('settings', `start: config API ${Object.keys(stored).length} keys, backend copy ${Object.keys(mirror).length} keys`);
    }
    // Heal whichever side lost a key (names only in the log, never values).
    // A default the Configuration API does not hold is what it should hold (storing a default deletes the key): not a loss.
    const lost = merged.heal.filter((k) => !(stored[k] === undefined && JSON.stringify(merged.values[k]) === JSON.stringify(DEFAULTS[k as SettingKey])));
    if (lost.length > 0) {
        logger.warn(`Configuration API lacked or differed on ${lost.join(', ')}: restored from the backend copy.`);
        backend.logEvent('settings', `config API lacked ${lost.join(', ')}: restored from backend copy`);
        const name = pluginName();
        for (const key of lost) {
            try {
                await config.set(name, key, merged.values[key]);
            } catch {
                /* the copy still holds it; the next start tries again */
            }
        }
    }
    if (Object.keys(merged.seed).length > 0) await writeMirror({ values: merged.seed });
}

async function write(op: (name: string) => Promise<void>, mirror: { values?: Record<string, unknown>; remove?: string[] }): Promise<void> {
    try {
        await op(pluginName());
    } catch (error) {
        if (!String(error).includes('type must be string')) {
            // The Configuration API refused: the backend copy still keeps the value, so it survives a restart.
            logger.warn('Configuration API write failed; keeping the backend copy.', error);
        }
    }
    await writeMirror(mirror);
    await sync();
}

/** Load stored values once and keep them current. Call once at startup. */
export async function initSettings(): Promise<void> {
    try {
        await sync();
    } catch (error) {
        logger.warn('Could not read plugin config; using defaults.', error);
    }
    try {
        subscribePluginConfig((key, value) => apply(key, value));
    } catch {
        /* our own writes go through write(), which syncs */
    }
}

/** O(1) read from the in-memory copy. */
export function setting<K extends SettingKey>(key: K): Settings[K] {
    return current[key];
}

export function onSettingChange(listener: (key: SettingKey) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Validates, then persists. Storing the default deletes the key. */
export function setSetting<K extends SettingKey>(key: K, value: unknown): Promise<void> {
    const valid = VALIDATORS[key](value);
    const isDefault = JSON.stringify(valid) === JSON.stringify(DEFAULTS[key]);
    const op = isDefault ? write((n) => config.delete(n, key), { values: { [key]: valid } }) : write((n) => config.set(n, key, valid), { values: { [key]: valid } });
    // One line per write, the key only (never the value: it can hold a name or a path), and a warning when the value read
    // back is not the one written: that is what a "settings not saving" report (Millennium #903) looks like in the log.
    // The same lines go to the plugin log users share (ClientLog), where the console lines never reach.
    return op.then(
        () => {
            if (JSON.stringify(current[key]) === JSON.stringify(valid)) {
                logger.info(`Setting saved: ${key}`);
                backend.logEvent('settings', `saved ${key}`);
            } else {
                logger.warn(`Setting did not stick: ${key} (read back a different value than was written)`);
                backend.logEvent('settings', `did not stick: ${key}`);
            }
        },
        (error) => {
            logger.warn(`Setting not saved: ${key}`, error);
            backend.logEvent('settings', `not saved: ${key}`);
            throw error;
        },
    );
}

/** Forget every stored value. */
export async function resetSettings(): Promise<void> {
    for (const key of Object.keys(DEFAULTS)) await write((n) => config.delete(n, key), { remove: [key] });
}

/** React hook over the in-memory copy, for the settings panel. */
export function useSetting<K extends SettingKey>(key: K): [Settings[K], (value: Settings[K]) => void] {
    const [value, setValue] = useState(() => setting(key));
    useEffect(() => onSettingChange((k) => k === key && setValue(setting(key))), [key]);
    return [
        value,
        (next) => {
            setValue(next);
            setSetting(key, next).catch((error) => {
                logger.error(`Could not save ${key}:`, error);
                setValue(setting(key));
            });
        },
    ];
}
