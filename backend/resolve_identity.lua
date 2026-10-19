--- Identity resolution: is this shortcut a Steam game? (migration plan M4b).
---
--- A port of frontend/features/steam-store/index.ts `resolveMapping` plus the
--- SteamStoreSaveKnownMatch/SteamStoreSearch RPC bodies, called from one place
--- (record_rpc.lua `EnsureFresh`) instead of up to three frontend round trips.
---
--- Only route bucket "steam-store" is ever resolved; every other route is
--- "unsupported" without a disk write or a network call (ADR-0036).

local emulators   = require("steam_store_emulators")
local normalize   = require("steam_store_normalize")
local search      = require("steam_store_search")
local store       = require("steam_store_store")
local throttle    = require("steam_store_throttle")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  http_get = nil,    -- nil = steam_store_throttle.http_get (search.search's default)
  is_emulator = nil, -- nil = launches_emulator(appid), moved here from steam_store_rpc.lua
  provided = nil,    -- nil = provided_store.get(appid): what an extension pushed (ADR-0067), for its title
  now = function() return os.time() end,
}

--- Is this shortcut launched through a known emulator? False when unknown.
--- Moved from steam_store_rpc.lua (M4b); steam_store_rpc requires it from here.
function M.launches_emulator(appid)
  local ok, result = pcall(function()
    local entry = require("registry").shortcut(appid)
    return entry ~= nil and emulators.is_emulator(entry.exe)
  end)
  return ok and result == true
end

local function is_emulator(appid)
  if M.deps.is_emulator then return M.deps.is_emulator(appid) end
  return M.launches_emulator(appid)
end

local function now_ms()
  return math.floor((M.deps.now or os.time)() * 1000)
end

--- Disk only: the saved mapping as an identity part, or nil. Never touches the network.
function M.saved(appid)
  local entry = store.get(appid)
  if not entry.mapping then return nil end
  return {
    status = "ok",
    data = { native = { appid = entry.mapping.steam_appid, source = entry.mapping.source } },
    source = "steam-store",
    checkedAt = now_ms(),
  }
end

--- The unique owned candidate whose normalized name matches the (normalized)
--- title, skipping rejected ids. Two candidates with the same normalized name
--- is no match (mirrors frontend/features/steam-store/resolve.ts matchKnownIndex).
local function match_owned(appid, title, owned)
  local norm_title = normalize.normalize(title)
  if norm_title == "" then return nil end
  local matches = {}
  for _, cand in ipairs(owned or {}) do
    if normalize.normalize(cand.name) == norm_title and not store.is_rejected(appid, cand.appid) then
      matches[#matches + 1] = cand
    end
  end
  if #matches == 1 then return matches[1] end
  return nil
end

--- The titles to match, best first: the shortcut's name, then the title an extension pushed for it (ADR-0067: an Epic or
--- Xbox copy's store title) when that differs after normalizing. An Xbox shortcut can carry the package's own name ("worldoftanks_blitz") while the catalog
--- names the game ("World of Tanks Blitz"); Steam's search finds only the second.
local function titles_of(appid, ctx)
  local out, seen = {}, {}
  local function add(t)
    t = type(t) == "string" and t or ""
    local norm = normalize.normalize(t)
    if norm ~= "" and not seen[norm] then seen[norm] = true; out[#out + 1] = t end
  end
  add(ctx.title)
  local ok, pushed = pcall(M.deps.provided or function(id) return require("provided_store").get(id) end, appid)
  if ok and type(pushed) == "table" then add(pushed.title) end
  return out
end

--- Full resolution: saved mapping -> owned candidates -> store search, for each title (titles_of). Returns a Part.
--- ctx = { title = string, owned = { {appid=, name=}, ... } | nil, route = { bucket=, via= }, store = Part? }
function M.ensure(appid, ctx)
  ctx = ctx or {}
  local route = ctx.route or {}

  if route.bucket ~= "steam-store" then
    return { status = "unsupported", checkedAt = now_ms() }
  end

  local existing = M.saved(appid)
  if existing then return existing end

  if is_emulator(appid) then
    return { status = "unsupported", checkedAt = now_ms() }
  end

  local titles = titles_of(appid, ctx)
  if #titles == 0 then
    return { status = "pending", checkedAt = now_ms() }
  end

  for _, title in ipairs(titles) do
    local owned = match_owned(appid, title, ctx.owned)
    if owned then
      local mapping, err = store.set_mapping(appid, owned.appid, owned.name, "owned")
      if mapping then
        return {
          status = "ok",
          data = { native = { appid = mapping.steam_appid, source = mapping.source } },
          source = "owned",
          checkedAt = now_ms(),
        }
      end
      if err ~= "rejected" then
        return { status = "error", message = err, checkedAt = now_ms() }
      end
    end
  end

  local http_get = M.deps.http_get or throttle.http_get
  for _, title in ipairs(titles) do
    local result = search.search(title, http_get, store)

    if result.error then
      return { status = "error", message = result.error, checkedAt = now_ms() }
    end

    if result.exact then
      local mapping = store.set_mapping(appid, result.exact.appid, result.exact.name, "search")
      if mapping then
        store.remove_suggestion(appid, result.exact.appid)
        return {
          status = "ok",
          data = { native = { appid = mapping.steam_appid, source = mapping.source } },
          source = "search",
          checkedAt = now_ms(),
        }
      end
      -- exact hit already rejected: the next title may still match another game.
    elseif result.suggestions and #result.suggestions > 0 then
      store.add_suggestions(appid, result.suggestions)
    end
  end

  -- suggestions only, a rejected or negative hit, or no hit at all: ok without a native match.
  return { status = "ok", data = {}, source = "search", checkedAt = now_ms() }
end

return M
