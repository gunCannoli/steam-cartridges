--- Metadata resolution: which Game Info to show for a shortcut? (migration plan M5a).
---
--- A port of frontend/features/game-info/policy.ts `gameInfoPlan` plus
--- features/steam-store/index.ts `loadNative` and web_rpc.lua `GetGameMetadata`,
--- called from one place (record_rpc.lua `EnsureFresh`) instead of being spread
--- across the frontend.
---
--- Needs identity: EnsureFresh(appid, {"identity","metadata"}, ctx) resolves
--- identity first in the same call; {"metadata"} alone reads the saved identity
--- (resolve_identity.saved) without a network call for identity.

local resolve_identity = require("resolve_identity")
local metadata_db      = require("web_metadata_db")
local appdetails       = require("steam_store_appdetails")
local igdb             = require("web_igdb")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  fresh = nil,            -- nil = fresh_policy (M7a): when a local record is stale
  screenscraper_fetch = nil, -- nil = ScreenScraper jeuInfos (screenscraper_media.fetch_jeu) mapped by
                             -- M.screenscraper_to_metadata; fun(appid, title, shortcut_info) -> meta|nil
  igdb_fetch = nil,       -- nil = igdb.fetch_game_metadata
  appdetails_fetch = nil, -- nil = appdetails.fetch
  provided = nil,         -- fun(appid) -> pushed record | nil ; nil = provided_store.get (ADR-0067)
  shortcut_info = nil,    -- nil = registry.shortcut (the shortcuts.vdf entry)
  now = function() return os.time() end,
}

local function igdb_fetch(appid, title, shortcut_info)
  return (M.deps.igdb_fetch or igdb.fetch_game_metadata)(appid, title, shortcut_info)
end

local function appdetails_fetch(steam_appid)
  return (M.deps.appdetails_fetch or appdetails.fetch)(steam_appid)
end

local function shortcut_info(appid)
  if M.deps.shortcut_info then return M.deps.shortcut_info(appid) end
  return require("registry").shortcut(appid)
end

--- ScreenScraper `jeu` record -> our metadata (M5d). Field mapping (decided with the user):
---   synopsis -> description (English first, else the first language available)
---   developpeur -> developers, editeur -> publishers, familles -> franchises, genres -> genres
---   dates -> release_date = the EARLIEST regional date (Steam shows one original release date)
---   joueurs -> single_player (min players is 1) and multiplayer (max players > 1)
--- Co-op, split screen and controller flags are not provided by ScreenScraper (controller support
--- keeps coming from the emulator inference, ADR-0038), so they are left unset.
local function text_of(v)
  if type(v) == "string" then return v end
  if type(v) ~= "table" then return nil end
  if type(v.text) == "string" then return v.text end
  for _, k in ipairs({ "nom", "nomcomplet", "nomfamille", "nomgenre" }) do
    if type(v[k]) == "string" then return v[k] end
  end
  return nil
end

--- A list of {langue|region, text} (or a bare string / {text}): English first, else the first.
local function localized(list)
  if type(list) == "string" then return list end
  if type(list) ~= "table" then return nil end
  if type(list.text) == "string" then return list.text end
  local first
  for _, e in ipairs(list) do
    local t = text_of(e)
    if t and t ~= "" then
      first = first or t
      if type(e) == "table" and (e.langue == "en" or e.region == "us" or e.region == "wor") then return t end
    end
  end
  return first
end

--- Names from an entry that is a single {text} object or a list of entries (each a string,
--- {text}, or {noms = {{langue, text}}}).
local function names_of(v)
  local out, seen = {}, {}
  local function add(t)
    if t and t ~= "" and not seen[t] then seen[t] = true; out[#out + 1] = t end
  end
  if type(v) == "string" then add(v) return out end
  if type(v) ~= "table" then return out end
  if type(v.text) == "string" then add(v.text) return out end
  for _, e in ipairs(v) do
    if type(e) == "table" and type(e.noms) == "table" then add(localized(e.noms)) else add(text_of(e)) end
  end
  return out
end

local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor((y >= 0 and y or y - 399) / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * (m + (m > 2 and -3 or 9)) + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

--- "1991-06-23" | "1991-06" | "1991" -> epoch (UTC); else nil.
local function parse_iso(s)
  s = tostring(s or "")
  local y, m, d = s:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
  if not y then y, m = s:match("^(%d%d%d%d)%-(%d%d)$"); d = "1" end
  if not y then y = s:match("^(%d%d%d%d)$"); m = "1"; d = "1" end
  if not y then return nil end
  return days_from_civil(tonumber(y), tonumber(m), tonumber(d)) * 86400
end

local function earliest_date(dates)
  local best
  local list = type(dates) == "table" and (dates.text and { dates } or dates) or {}
  for _, e in ipairs(list) do
    local t = parse_iso(text_of(e))
    if t and (not best or t < best) then best = t end
  end
  return best or 0
end

function M.screenscraper_to_metadata(jeu, appid, title)
  if type(jeu) ~= "table" then return nil end
  local nums = {}
  for n in tostring(localized(jeu.joueurs) or ""):gmatch("%d+") do nums[#nums + 1] = tonumber(n) end
  local min_p, max_p = nums[1], nums[#nums]
  return {
    appid = appid,
    title = title,
    ss_id = tonumber(jeu.id),
    matched_title = localized(jeu.noms) or text_of(jeu.nom) or title,
    description = localized(jeu.synopsis) or "",
    developers = names_of(jeu.developpeur),
    publishers = names_of(jeu.editeur),
    franchises = names_of(jeu.familles),
    release_date = earliest_date(jeu.dates),
    genres = names_of(jeu.genres),
    categories = {
      single_player = min_p == nil or min_p <= 1,
      multiplayer = max_p ~= nil and max_p > 1,
    },
    custom_override = false,
  }
end

local function default_screenscraper_fetch(appid, title, info)
  -- The same `jeu` the media source (features plan F2) lists its images from.
  local jeu = require("screenscraper_media").jeu_for(appid, title, info)
  if not jeu then return nil end
  return M.screenscraper_to_metadata(jeu, appid, title)
end

local function screenscraper_fetch(appid, title, info)
  local ok, meta = pcall(M.deps.screenscraper_fetch or default_screenscraper_fetch, appid, title, info)
  if ok then return meta end
  return nil -- ADR-0014: a failing provider is silent, the next tier runs
end

local function fresh()
  return M.deps.fresh or require("fresh_policy")
end

--- What an extension pushed for the shortcut (ADR-0067: Epic, Xbox, ... found by steam-cartridges-third-party), or nil.
--- Disk only: the core never asks a store.
local function provided(appid)
  if M.deps.provided then return M.deps.provided(appid) end
  return require("provided_store").get(appid)
end

--- The pushed Game Info, ready to store, or nil.
local function provided_meta(rec)
  if type(rec) ~= "table" or type(rec.metadata) ~= "table" then return nil end
  local meta = {}
  for k, v in pairs(rec.metadata) do meta[k] = v end
  meta.store_source = rec.source -- the record remembers who wrote it (pushed data found later replaces others)
  return meta
end

local function now_ms()
  return math.floor((M.deps.now or os.time)() * 1000)
end

--- Disk only: the local library_metadata.json record as a metadata part, or nil.
function M.local_part(appid)
  local rec = metadata_db.get(appid)
  if not rec then return nil end
  return { status = "ok", data = rec, source = rec.custom_override and "custom" or "local_db", checkedAt = now_ms() }
end

local SHORTCUT_MIN = 0x80000000

--- A user's manual edit (Game Data editor, features plan F1): the whole record is stored with
--- custom_override = true, which no refresh ever replaces (K15, ensure() and fresh_policy).
---@return table|nil part, string|nil err
function M.save_custom(appid, meta)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then return nil, "not a shortcut" end
  if type(meta) ~= "table" or type(meta.title) ~= "string" or meta.title == "" then return nil, "invalid metadata" end
  meta.appid = n
  meta.custom_override = true
  local saved = metadata_db.set(n, meta, true)
  return { status = "ok", data = saved, source = "custom", checkedAt = now_ms() }
end

--- Drop a manual edit so the next ensure() resolves the game from its sources again.
--- Only a custom_override record is removed; anything else is left alone.
---@return boolean|nil removed, string|nil err
function M.clear_custom(appid)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then return nil, "not a shortcut" end
  local rec = metadata_db.get(n)
  if not (rec and rec.custom_override) then return false end
  return metadata_db.delete(n)
end

--- The fallback record exactly as web_rpc.lua GetGameMetadata builds and persists it.
local function fallback_record(appid, title)
  return {
    appid = appid,
    title = title,
    igdb_id = nil,
    matched_title = title,
    description = "",
    developers = {},
    publishers = {},
    franchises = {},
    release_date = 0,
    genres = {},
    categories = {
      single_player = true,
      multiplayer = false,
      coop = false,
      split_screen = false,
      full_controller = true,
    },
    custom_override = false,
  }
end

--- Full resolution: local db -> steam appdetails / storeItem -> igdb -> fallback.
--- Returns a Part (table). ctx = { title=, route={bucket=,via=}, owned=?, storeItem=?,
--- allowWeb=?, noNetwork=? }
function M.ensure(appid, ctx)
  ctx = ctx or {}
  local route = ctx.route or {}
  local title = ctx.title or ""

  local local_rec = metadata_db.get(appid)
  if local_rec and local_rec.custom_override then
    return { status = "ok", data = local_rec, source = "custom", checkedAt = now_ms() }
  end

  if route.via == "pending" then
    if local_rec then return { status = "ok", data = local_rec, source = "local_db", checkedAt = now_ms() } end
    return { status = "pending", checkedAt = now_ms() }
  end

  if route.bucket == "steam-store" then
    -- The frontend passes the identity it knows (an "ok" result with no native match is
    -- never persisted, so the disk alone cannot tell "no match" from "not known yet").
    local identity = ctx.identity or resolve_identity.saved(appid)
    local native = identity and identity.data and identity.data.native

    if native then
      if ctx.storeItem ~= nil then
        return { status = "ok", data = ctx.storeItem, source = "steam-store", checkedAt = now_ms() }
      end
      if ctx.noNetwork then
        -- The view's paint (ADR-0060): a match's Game Info is Steam's own store item, never stored; the
        -- refresh that follows brings it (or asks appdetails).
        return { status = "pending", stale = true, checkedAt = now_ms() }
      end
      local data, err = appdetails_fetch(native.appid)
      if data then
        local meta = appdetails.to_metadata(data, appid)
        return { status = "ok", data = meta, source = "steam-appdetails", checkedAt = now_ms() }
      end
      if local_rec then
        return { status = "error", data = local_rec, message = err, checkedAt = now_ms() }
      end
      return { status = "error", message = err, checkedAt = now_ms() }
    end

    -- Not resolved yet (or failed): local only. "ok" (no match) and "unsupported"
    -- (emulator launcher) fall through to the web tier, as the old ADR-0036 fallback did.
    if not identity or identity.status == "pending" or identity.status == "error" then
      if local_rec then return { status = "ok", data = local_rec, source = "local_db", checkedAt = now_ms() } end
      return { status = "pending", checkedAt = now_ms() }
    end
    -- identity ok, no native match: falls through to the igdb/fallback tier below.
  elseif route.bucket ~= "web-scraping" then
    -- route.bucket == "none"
    if local_rec then return { status = "ok", data = local_rec, source = "local_db", checkedAt = now_ms() } end
    return { status = "unsupported", checkedAt = now_ms() }
  end

  -- web-scraping, or steam-store identity ok without a native match:
  -- the local record while it is fresh, else what an extension pushed (Epic, Xbox: the game's own data, ADR-0067; no
  -- network) -> igdb -> screenscraper -> the fallback record.
  local pushed = provided(appid)
  local pushed_meta = provided_meta(pushed)
  local use_store = pushed_meta ~= nil
  local can_fetch = ((ctx.allowWeb or ctx.allowScreenscraper) and not ctx.noNetwork) or use_store
  if local_rec then
    -- Stale (M7a: 24 h, or ctx.force) records are refreshed when a source may be asked. A custom_override
    -- record never reaches here (K15), so a manual edit is never refreshed. A record its store did not write is due
    -- as soon as the copy is known (the store comes first).
    local due = ctx.force or fresh().is_stale(appid, "metadata", { status = "ok", source = "local_db" }, now_ms())
      or (use_store and local_rec.store_source ~= pushed.source)
    if not (due and can_fetch) then
      -- The view's paint (ADR-0060) shows the record now and flags it when a source would refresh it.
      local stale = (ctx.noNetwork and due and (ctx.allowWeb or ctx.allowScreenscraper)) and true or nil
      return { status = "ok", data = local_rec, source = "local_db", stale = stale, checkedAt = now_ms() }
    end
  elseif not can_fetch then
    return { status = "pending", checkedAt = now_ms() }
  end

  local info = shortcut_info(appid)
  -- IGDB first when the user has it (a plain ScreenScraper account is the easy one, so it fills
  -- in when IGDB is not configured or finds no match), then the fallback record (M5d).
  local meta, source
  if use_store then
    meta, source = pushed_meta, pushed.source
  end
  if not meta and ctx.allowWeb and not ctx.noNetwork then
    meta = igdb_fetch(appid, title, info)
    if meta then source = "igdb" end
  end
  if not meta and ctx.allowScreenscraper and not ctx.noNetwork then
    meta = screenscraper_fetch(appid, title, info)
    if meta then source = "screenscraper" end
  end
  if meta then
    metadata_db.set(appid, meta)
    fresh().touch(appid, "metadata", now_ms())
    return { status = "ok", data = meta, source = source, checkedAt = now_ms() }
  end

  if local_rec then
    -- A refresh that found nothing keeps what we have and comes due again after the short error TTL.
    fresh().touch(appid, "metadata", now_ms(), "error")
    return { status = "ok", data = local_rec, source = "local_db", checkedAt = now_ms() }
  end

  -- A paused source (429, or 5 failures) is not "no match": do not write the fallback record over the
  -- chance of real data; ask again once it is free.
  local net = require("net")
  if (ctx.allowWeb and net.is_paused("igdb")) or (ctx.allowScreenscraper and net.is_paused("screenscraper")) then
    return { status = "pending", message = "paused", checkedAt = now_ms() }
  end

  local fallback = fallback_record(appid, title)
  metadata_db.set(appid, fallback)
  fresh().touch(appid, "metadata", now_ms())
  return { status = "ok", data = fallback, source = "fallback", checkedAt = now_ms() }
end

return M
