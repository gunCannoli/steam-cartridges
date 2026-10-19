--- The record facade: EnsureFresh (resolves stale parts) and GetAllRecords (disk only).
--- Migration plan M4b; M5a adds "metadata" and GetAllRecords; M10 removed GetGameRecord (never called).

local core             = require("rpc")
local resolve_identity  = require("resolve_identity")
local metadata_service  = require("metadata_service")
local art_service       = require("art_service")
local media_service     = require("media_service")
local provided_store    = require("provided_store")
local metadata_db       = require("web_metadata_db")
local steam_store_store = require("steam_store_store")

local method = core.method

-- Achievements modules are loaded on first use: they pull in the trophy and RetroAchievements
-- readers, which the record facade's other parts (and their test suites) do not need.
local function ach() return require("ach_service") end
local function fresh() return require("fresh_policy") end
local function now_ms() return math.floor(os.time() * 1000) end

local RPC = {}

--- The `provided` part (ADR-0067): which source an extension pushed for the shortcut, and its title. Disk only.
local function provided_part(appid)
  local rec = provided_store.get(appid)
  local now = os.time() * 1000
  if type(rec) ~= "table" then return { status = "unsupported", checkedAt = now } end
  return { status = "ok", source = rec.source, data = { source = rec.source, title = rec.title, provider = rec.provider }, checkedAt = now }
end

local function need(data, field)
  if data[field] == nil then error("missing " .. field) end
  return data[field]
end

local SHORTCUT_MIN = 0x80000000

local function is_shortcut(appid)
  local n = tonumber(appid)
  return n ~= nil and n >= SHORTCUT_MIN
end

RPC.EnsureFresh = method("EnsureFresh", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local requested = need(data, "parts")
  local ctx = data.context or {}

  local parts = {}
  for _, name in ipairs(requested) do
    if name == "identity" then
      -- A lookup that failed less than 30 min ago is answered from memory (a saved mapping always wins).
      local recent = not ctx.force and not resolve_identity.saved(appid) and fresh().recent_error(appid, "identity", now_ms())
      if recent then
        parts.identity = recent
      else
        parts.identity = resolve_identity.ensure(appid, ctx)
        if parts.identity.status == "ok" or parts.identity.status == "error" then
          fresh().touch(appid, "identity", now_ms(), parts.identity.status)
        end
        if parts.identity.status == "error" then
          fresh().remember_error(appid, "identity", now_ms(), parts.identity)
        else
          fresh().forget_error(appid, "identity")
        end
      end
      ctx.identity = parts.identity -- later parts of this same call see the fresh identity
    elseif name == "provided" then
      -- What an extension pushed for the shortcut (ADR-0067), disk only.
      parts.provided = provided_part(appid)
    elseif name == "metadata" then
      parts.metadata = metadata_service.ensure(appid, ctx)
      -- The view's paint (ADR-0060): nothing usable on disk yet means the page asks its sources next.
      if ctx.noNetwork and parts.metadata.status == "pending" then parts.metadata.stale = true end
    elseif name == "artwork" then
      -- Only a lookup without a Steam match can fail (SteamGridDB); a failure less than 30 min ago is answered
      -- from memory. A Steam match (a new mapping) always asks again.
      local identity = ctx.identity
      local native = identity and identity.data and identity.data.native
      local recent = not ctx.force and not native and fresh().recent_error(appid, "artwork", now_ms())
      if recent then
        parts.artwork = recent
      else
        parts.artwork = art_service.ensure(appid, ctx)
        if parts.artwork.status == "error" then
          fresh().remember_error(appid, "artwork", now_ms(), parts.artwork)
        else
          fresh().forget_error(appid, "artwork")
        end
      end
    elseif name == "media" then
      -- Community media (features plan F2): a failure less than 30 min ago is answered from memory, as for artwork.
      local recent = not ctx.force and fresh().recent_error(appid, "media", now_ms())
      if recent then
        parts.media = recent
      else
        parts.media = media_service.ensure(appid, ctx)
        if parts.media.status == "error" then
          fresh().remember_error(appid, "media", now_ms(), parts.media)
        else
          fresh().forget_error(appid, "media")
        end
      end
    elseif name == "achievements" then
      -- The native app comes from the identity: this call's fresh one, else the frontend's, else disk.
      -- Only a steam-store route uses a Steam match (a shortcut moved to web-scraping is unmatched here).
      local identity = ctx.identity
      if not identity and (ctx.route or {}).bucket == "steam-store" then identity = resolve_identity.saved(appid) end
      local native = identity and identity.data and identity.data.native
      -- The schema is refreshed at most every 24 h; unlocks are read by their own channels (Flow C).
      local now = now_ms()
      local cached = ach().local_part(appid)
      local due = ctx.force or not cached or fresh().is_stale(appid, "achievements", cached, now)
      -- ADR-0060: with nothing stored, a lookup that found no source or failed is not repeated until it comes
      -- due (24 h / 30 min): every view, ingest run and observer poll used to ask the sources again.
      local remembered = not cached and not ctx.force and fresh().remembered(appid, "achievements", now)
      if cached and not due then
        parts.achievements = cached
      elseif remembered then
        local memo = fresh().recent_error(appid, "achievements", now)
        parts.achievements = memo or { status = remembered.status, checkedAt = remembered.at }
      elseif ctx.noNetwork then
        -- The view's paint (ADR-0060): what is stored, flagged when a refresh is due; never a source.
        parts.achievements = cached or { status = "pending", checkedAt = now }
        parts.achievements.stale = true
      else
        parts.achievements = ach().ensure(appid, {
          native = native and native.appid or nil,
          hardcore = ctx.hardcore ~= false,
          title = ctx.title,
        })
        local st = parts.achievements.status
        if st == "ok" or st == "error" or st == "unsupported" then fresh().touch(appid, "achievements", now_ms(), st) end
        if st == "error" then
          fresh().remember_error(appid, "achievements", now_ms(), parts.achievements)
          -- A failed refresh keeps what is stored (as metadata does), and comes due again after 30 min.
          if cached then parts.achievements = cached end
        else
          fresh().forget_error(appid, "achievements")
        end
      end
    end
    -- Unknown part names are ignored (not an error).
  end

  -- Which sources are paused right now (M7a breakers), so a background run can stop instead of hammering.
  local result = { appid = tonumber(appid), parts = parts }
  local paused = require("net").stats().paused
  if next(paused) ~= nil then result.paused = paused end
  return result
end)

--- Game Data editor (features plan F1): { appid, metadata } stores a manual edit and returns the
--- metadata part (source "custom") for the record; no network, no refresh.
RPC.SaveCustomMetadata = method("SaveCustomMetadata", function(data)
  local part, err = metadata_service.save_custom(need(data, "appid"), need(data, "metadata"))
  if not part then return { error = err } end
  return { part = part }
end)

--- { appid }: drop the manual edit. The caller then runs EnsureFresh(["metadata"]) to get the fetched data.
RPC.ClearCustomMetadata = method("ClearCustomMetadata", function(data)
  local removed, err = metadata_service.clear_custom(need(data, "appid"))
  if removed == nil then return { error = err } end
  return { removed = removed }
end)

--- Every DB record and every saved mapping, disk only. Replaces the frontend's
--- getAllMetadata preload in M5b.
RPC.GetAllRecords = method("GetAllRecords", function(_)
  local records = {}
  local all_meta = metadata_db.get_all()
  for key, rec in pairs(all_meta) do
    records[key] = records[key] or {}
    records[key].metadata = { status = "ok", data = rec, source = rec.custom_override and "custom" or "local_db" }
  end
  for key, mapping in pairs(steam_store_store.get_state().mappings) do
    records[key] = records[key] or {}
    records[key].identity = {
      status = "ok",
      data = { native = { appid = mapping.steam_appid, source = mapping.source } },
      source = "steam-store",
    }
  end
  for _, key in ipairs(provided_store.keys()) do
    local p = provided_part(tonumber(key))
    if p.status == "ok" then
      records[key] = records[key] or {}
      records[key].provided = p
    end
  end
  for key in pairs(records) do
    local achievements = ach().local_part(tonumber(key))
    if achievements then records[key].achievements = achievements end
  end
  -- A shortcut with stored achievements but no metadata and no mapping (ADR-0045: the frontend preloads
  -- every stored part into Steam's progress cache at start-up).
  for _, appid in ipairs(ach().stored_appids()) do
    local key = tostring(appid)
    if not records[key] then
      local achievements = ach().local_part(appid)
      if achievements then records[key] = { achievements = achievements } end
    end
  end
  return { records = records }
end)

--- New unlocks since the last check (Flow C, M6b polls this every 2 s). K1: `new_unlocks` is always a list.
RPC.CheckUnlocks = method("CheckUnlocks", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  return require("achievements_observer").check_unlocks(tonumber(appid), tonumber(data.native) or 0, data.title)
end)

--- Shortcuts in shortcuts.vdf the plugin has not seen before (Flow B). The first call seeds the file
--- with the current library and returns none, so an existing library is never fetched in one storm.
RPC.GetNewShortcuts = method("GetNewShortcuts", function(_)
  return { shortcuts = require("registry").new_shortcuts() }
end)

--- Mark shortcuts as handled: { appids = [...] }.
RPC.MarkKnown = method("MarkKnown", function(data)
  require("registry").mark_known(need(data, "appids"))
  return { ok = true }
end)

--- { appid, key, title?, cacheDays? }: one ScreenScraper image of the media part, as base64 (features plan F2b). The
--- bytes come from disk when kept (cacheDays > 0, ADR-0051), else are downloaded; the answer never carries the URL.
RPC.GetMediaImage = method("GetMediaImage", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local image, err = media_service.image(tonumber(appid), need(data, "key"), data.title, data.cacheDays)
  if not image then return { error = err } end
  return image
end)

RPC.GetManualChunk = method("GetManualChunk", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local chunk, err = media_service.manual_chunk(tonumber(appid), need(data, "key"), data.title, data.index, data.cacheDays)
  if not chunk then return { error = err } end
  return chunk
end)


--- { appid, key }: the stored first-page cover of a manual as base64, or {} (features plan F2c).
RPC.GetManualCover = method("GetManualCover", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local cover, err = media_service.manual_cover(tonumber(appid), need(data, "key"), data.cacheDays)
  if not cover then return { error = err } end
  return cover
end)

--- { appid, key, base64 }: store a manual's rendered first page as its cover.
RPC.SaveManualCover = method("SaveManualCover", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local res, err = media_service.save_manual_cover(tonumber(appid), need(data, "key"), need(data, "base64"), data.cacheDays)
  if not res then return { error = err } end
  return res
end)

--- { days }: delete the downloads of every game not opened in the last `days` days, all of them for 0 (ADR-0051).
RPC.PruneMediaCache = method("PruneMediaCache", function(data)
  return media_service.prune_cache(data.days)
end)

--- { appid, source, target }: manually link or override achievement source.
--- source: "ra" | "steam" | "none"
--- target: RA game id or url, Steam appid or url, or nil
RPC.SetAchievementSource = method("SetAchievementSource", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local source = need(data, "source")
  local target = data.target
  local s_appid = tonumber(appid)

  local store = require("achievements_store")

  if source == "none" then
    store.sync(s_appid, "none", {}, "none")
    fresh().touch(s_appid, "achievements", now_ms())
    return { ok = true, source = "none" }
  elseif source == "ra" then
    if not target or target == "" then return { error = "missing RetroAchievements URL or game id" } end
    local gid_str = tostring(target):match("/game/(%d+)") or tostring(target):match("(%d+)")
    local gid = tonumber(gid_str)
    if not gid or gid <= 0 then return { error = "invalid RetroAchievements game id" } end

    local ra = require("retroachievements")
    local web_cfg = require("web_config")
    local creds = (web_cfg.get_retroachievements_credentials and web_cfg.get_retroachievements_credentials()) or {}
    local schema, unlocks = ra.fetch_game_data(gid, creds.username, creds.token, true, creds.api_key)
    if not schema then
      return { error = "could not fetch game data for RetroAchievements game " .. tostring(gid) }
    end
    local schema_key = "ra_" .. tostring(gid)
    store.save_schema_and_sync(s_appid, schema_key, schema, unlocks or {}, "retroachievements")
    fresh().touch(s_appid, "achievements", now_ms())
    return { ok = true, source = "retroachievements", title = schema.title, total = schema.total, game_id = gid }
  elseif source == "steam" then
    if not target or target == "" then return { error = "missing Steam app id" } end
    local sid_str = tostring(target):match("/app/(%d+)") or tostring(target):match("(%d+)")
    local sid = tonumber(sid_str)
    if not sid or sid <= 0 then return { error = "invalid Steam app id" } end
    local steam_schema = require("steam_schema")
    local schema, err = steam_schema.get_or_fetch(s_appid, sid)
    if not schema then
      return { error = "could not fetch Steam achievement schema: " .. tostring(err) }
    end
    store.sync(s_appid, tostring(sid), {}, "steam")
    fresh().touch(s_appid, "achievements", now_ms())
    return { ok = true, source = "steam", total = schema.total, steam_appid = sid }
  else
    return { error = "unsupported source: " .. tostring(source) }
  end
end)

RPC.ClearAchievementSource = method("ClearAchievementSource", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local s_appid = tonumber(appid)
  local store = require("achievements_store")
  store.sync(s_appid, nil, {}, nil)
  fresh().touch(s_appid, "achievements", now_ms())
  return { ok = true }
end)

--- { query }: Search IGDB for game candidates
RPC.IgdbSearch = method("IgdbSearch", function(data)
  local query = need(data, "query")
  local igdb = require("web_igdb")
  return { candidates = igdb.search(query) }
end)

--- { appid, igdb_id, title }: Link a game to an IGDB game ID and fetch its full metadata
RPC.IgdbLink = method("IgdbLink", function(data)
  local appid = need(data, "appid")
  if not is_shortcut(appid) then return { error = "not a shortcut" } end
  local igdb_id = need(data, "igdb_id")
  local s_appid = tonumber(appid)
  local igdb = require("web_igdb")
  local meta, err = igdb.fetch_by_id(s_appid, igdb_id, data.title)
  if not meta then
    return { error = err or "could not fetch IGDB metadata" }
  end
  metadata_db.set(s_appid, meta, true)
  fresh().touch(s_appid, "metadata", now_ms())
  return { ok = true, metadata = meta }
end)

return RPC
