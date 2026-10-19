--- RPC handlers for the Steam Store bucket. Names are prefixed `SteamStore` so
--- they cannot collide with generic globals; main.lua registers them.
---
--- Only calls for steam-store games reach here (the frontend gates on the
--- bucket, ADR-0032), so the network is never touched for anything else.

local fs          = require("fs")
local steam_paths = require("steam_paths")
local core        = require("rpc")
local store       = require("steam_store_store")
local throttle    = require("steam_store_throttle")

local method = core.method

-- Loaded on first use (icon plan): the artwork resolver and the icon file store pull in modules
-- the other Steam Store handlers (and their test suite) do not need.
local function art() return require("art_service") end
local function icon_file() return require("shortcut_icon") end

local RPC = {}

local function need(data, field)
  if data[field] == nil then error("missing " .. field) end
  return data[field]
end

RPC.SteamStoreGetState = method("SteamStoreGetState", function(_)
  return store.get_state()
end)

--- `exists(name)` for files in <user>/config/grid, or nil when paths are unknown.
local function grid_exists()
  local paths = steam_paths.resolve()
  if not paths or not paths.user_root then return nil end
  local grid = fs.join(paths.user_root, "config", "grid")
  return function(name) return fs.exists(fs.join(grid, name)) == true end
end

RPC.SteamStoreGetMapping = method("SteamStoreGetMapping", function(data)
  local appid = need(data, "appid")
  local exists = grid_exists()
  if exists then pcall(store.prune_missing_slots, appid, exists) end
  local entry = store.get(appid)
  return { mapping = entry.mapping, rejected = entry.rejected, applied = entry.applied }
end)

RPC.SteamStoreSetMapping = method("SteamStoreSetMapping", function(data)
  local mapping, err = store.set_mapping(need(data, "appid"), need(data, "steam_appid"), data.name, "manual")
  if not mapping then return { error = err } end
  return { mapping = mapping }
end)

--- reject=true remembers the appid so it is never auto-applied again. Returns
--- the slots the frontend must clear (only those this plugin wrote), and
--- `icon_restore`: the icon path to put back, only while the shortcut still shows
--- the icon this plugin set (icon plan; an icon the user chose is left alone).
RPC.SteamStoreClearMapping = method("SteamStoreClearMapping", function(data)
  local appid = need(data, "appid")
  local out = store.clear(appid, data.reject and true or false)
  local icon = out.icon
  out.icon = nil
  if icon and not icon.released then
    local current = art().current_icon(appid)
    if current ~= nil and art().same_path(current, icon.path) then out.icon_restore = icon.previous or "" end
  end
  return out
end)

RPC.SteamStoreRejectSuggestion = method("SteamStoreRejectSuggestion", function(data)
  store.reject(need(data, "appid"), need(data, "steam_appid"))
  return { ok = true }
end)

--- Read-only search for the manual link picker: { term } -> { candidates = { {steam_appid,name} } }.
RPC.SteamStoreSearchCandidates = method("SteamStoreSearchCandidates", function(data)
  return require("steam_store_search").candidates(need(data, "term"))
end)

RPC.SteamStoreRecordArtwork = method("SteamStoreRecordArtwork", function(data)
  if data.source == "steamgriddb" then
    -- M5c: SteamGridDB fills a shortcut with no Steam match; there is no mapping to check.
    local ok, err = store.record_sgdb_artwork(need(data, "appid"), data.slots or {}, data.tried or {})
    if not ok then return { error = err } end
    return { ok = true }
  end
  local ok, err = store.record_artwork(need(data, "appid"), need(data, "steam_appid"), data.slots or {}, nil, data.failed or {})
  if not ok then return { error = err } end
  return { ok = true }
end)

--- Icon plan: store our copy of the chosen icon ({ appid, url, source, steam_appid? }) and
--- return its path and `previous`, the shortcuts.vdf value it replaces (put back on Clear).
--- Refused unless the icon is still eligible, so a late view never overrides the user's choice.
RPC.SteamStoreSaveIcon = method("SteamStoreSaveIcon", function(data)
  local appid = need(data, "appid")
  local source = data.source == "steamgriddb" and "steamgriddb" or "steam-cdn"
  local ok, previous = art().icon_eligible(appid, source, data.steam_appid)
  if not ok then return { error = "not eligible" } end
  local path, err = icon_file().save(appid, need(data, "url"), data.base64)
  if not path then return { error = err } end
  return { path = path, previous = previous }
end)

--- Icon plan: remember the icon the artwork surface just set (steam_store.json applied_icon).
--- `{ error = "no mapping" | "mapped" }` = the shortcut's match changed meanwhile (undo the write).
RPC.SteamStoreRecordIcon = method("SteamStoreRecordIcon", function(data)
  local ok, err = store.record_icon(need(data, "appid"), {
    path = need(data, "path"), previous = data.previous, source = data.source, steam_appid = data.steam_appid,
  })
  if not ok then return { error = err } end
  return { ok = true }
end)

return RPC
