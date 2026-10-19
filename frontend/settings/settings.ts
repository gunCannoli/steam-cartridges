import { useEffect, useState } from 'react';
import { pluginConfig, subscribePluginConfig } from '@steambrew/client';
import { logger } from '../logger';
import { DEFAULT_BUCKETS, validateConfig, type RoutingRule } from '../domain/routing/policy';
import { DEFAULTS, DEFAULT_SERVICES, MEDIA_CACHE_DAYS, type ControllerOverride, type SettingKey, type Settings } from './defaults';

export { DEFAULTS, DEFAULT_SERVICES, MEDIA_CACHE_DAYS };
export type { ControllerOverride, ServicesConfig, SettingKey, Settings } from './defaults';

/** Progress of the background sync (app/ingest.ts), for the panel (plan § 7.0 D3: never an import of app/). */
const VALIDATORS: { [K in SettingKey]: (raw: unknown) => Settings[K] } = {
    buckets: validateConfig,
    defaultFullController: (raw) => raw === true,
    raHardcoreMode: (raw) => raw !== false,
    activityShowAddedToLibrary: (raw) => raw !== false,
    activityShowFirstPlayed: (raw) => raw !== false,
    activityShowAchievements: (raw) => raw !== false,
    communityShowTrailers: (raw) => raw !== false,
    communityShowManuals: (raw) => raw !== false,
    communityShowArtworks: (raw) => raw !== false,
    communityShowExternalLinks: (raw) => raw !== false,
    mediaCacheDays: (raw) =>
        typeof raw === 'number' && Number.isFinite(raw)
            ? Math.min(MEDIA_CACHE_DAYS.max, Math.max(MEDIA_CACHE_DAYS.min, Math.round(raw)))
            : MEDIA_CACHE_DAYS.default,
    disabledFeatures: (raw) => (typeof raw === 'string' ? raw : ''),
    routingRules: (raw) => Array.isArray(raw) ? (raw as RoutingRule[]) : [],
    autoRoutingMode: (raw) => raw !== false,
    services: (raw) => {
        if (!raw || typeof raw !== 'object') return DEFAULT_SERVICES;
        const r = raw as any;
        const emu = r.emulatorsEnabled !== undefined ? r.emulatorsEnabled !== false : r.rpcs3Enabled !== false;
        return {
            steamStoreEnabled: r.steamStoreEnabled !== false,
            screenscraperEnabled: r.screenscraperEnabled !== false,
            igdbEnabled: r.igdbEnabled !== false,
            steamgriddbEnabled: r.steamgriddbEnabled !== false,
            retroachievementsEnabled: r.retroachievementsEnabled !== false,
            emulatorsEnabled: emu,
            rpcs3Enabled: emu,
        };
    },
    controllerOverrides: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, ControllerOverride>) : {}),
};

const current: Settings = {
    buckets: DEFAULT_BUCKETS,
    defaultFullController: false,
    raHardcoreMode: true,
    routingRules: [],
    autoRoutingMode: true,
    services: DEFAULT_SERVICES,
    controllerOverrides: {},
    activityShowAddedToLibrary: true,
    activityShowFirstPlayed: true,
    activityShowAchievements: true,
    communityShowTrailers: true,
    communityShowManuals: true,
    communityShowArtworks: true,
    communityShowExternalLinks: true,
    mediaCacheDays: MEDIA_CACHE_DAYS.default,
    disabledFeatures: '',
};
const listeners = new Set<(key: SettingKey) => void>();

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

async function readStored(): Promise<Record<string, unknown>> {
    const name = pluginName();
    try {
        return (await config.getAll(name)) ?? {};
    } catch {
        const ffi = (Reflect.get(globalThis, 'MILLENNIUM_API') as { ffi?: Ffi } | undefined)?.ffi;
        if (!ffi) throw new Error('No way to read plugin config on this Millennium build.');
        return ((await ffi('core', 'PluginConfig_GetAll')(name)) as Record<string, unknown>) ?? {};
    }
}

async function sync(): Promise<void> {
    const stored = await readStored();
    for (const key of Object.keys(DEFAULTS)) apply(key, stored[key]);
}

async function write(op: (name: string) => Promise<void>): Promise<void> {
    try {
        await op(pluginName());
    } catch (error) {
        if (!String(error).includes('type must be string')) throw error;
    }
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
    return JSON.stringify(valid) === JSON.stringify(DEFAULTS[key])
        ? write((n) => config.delete(n, key))
        : write((n) => config.set(n, key, valid));
}

/** Forget every stored value. */
export async function resetSettings(): Promise<void> {
    for (const key of Object.keys(DEFAULTS)) await write((n) => config.delete(n, key));
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
