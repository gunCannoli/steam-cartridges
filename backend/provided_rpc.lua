--- Extensions push a game's data (ADR-0067): the frontend's extension API (`reportGame`, `reportAchievementSet`,
--- `forgetGame`) calls these. Store-agnostic: the core never asks a store; it keeps what an extension found.
---   ProvideGame          { appid, source, provider, title?, metadata?, media? }        -> { ok, changed }
---   ForgetProvidedGame   { appid }                                                      -> { ok }
---   ProvideAchievements  { appid, source, provider, key, schema = { achievements }, unlocks = { [id] = unix }, native? }
---                        -> { ok, part, new = { ids } }

local core      = require("rpc")
local provided  = require("provided_store")
local ach_store = require("achievements_store")

local method = core.method

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  steam_fetch = nil, -- fun(native) -> schema | nil ; nil = steam_schema.fetch
  native = nil,      -- fun(appid) -> native appid | nil ; nil = the saved Steam mapping
  now = nil,         -- fun() -> unix seconds
}

local function now() return (M.deps.now or os.time)() end

local SHORTCUT_MIN = 0x80000000

local function shortcut(appid)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then return nil end
  return math.floor(n)
end

local function text(v) return type(v) == "string" and v ~= "" and v or nil end

--- Media items an extension may push: public URLs only (a ScreenScraper-style `key` is the core's own).
local function clean_media(list, source)
  local out = {}
  for _, it in ipairs(type(list) == "table" and list or {}) do
    if type(it) == "table" and (text(it.url) or text(it.youtube)) then
      out[#out + 1] = {
        kind = (it.kind == "video" or it.kind == "artwork") and it.kind or "screenshot",
        source = source,
        url = text(it.url), thumb = text(it.thumb), youtube = text(it.youtube), title = text(it.title),
        width = tonumber(it.width), height = tonumber(it.height),
      }
    end
  end
  return out
end

--- { appid, source, provider, title?, metadata?, media? }: keep what an extension found for a shortcut.
function M.provide_game(data)
  local appid = shortcut(data.appid)
  local source = text(data.source)
  if not appid or not source then return { error = "need a shortcut appid and a source" } end
  local meta = type(data.metadata) == "table" and data.metadata or nil
  if meta then
    meta.appid = appid
    meta.store_source = source -- the record remembers who wrote it (metadata_service: provided data replaces others)
  end
  local changed = provided.set(appid, {
    source = source,
    provider = text(data.provider) or source,
    title = text(data.title),
    metadata = meta,
    media = data.media ~= nil and clean_media(data.media, source) or nil,
    at = now(),
  })
  return { ok = true, changed = changed }
end

function M.forget_game(data)
  local appid = shortcut(data.appid)
  if not appid then return { error = "need a shortcut appid" } end
  provided.set(appid, nil)
  return { ok = true }
end

--- Every id of `items` is in Steam's list (pure).
local function covered_by(items, steam)
  if type(steam) ~= "table" or type(steam.achievements) ~= "table" or #items == 0 then return false end
  local ids = {}
  for _, a in ipairs(steam.achievements) do ids[tostring(a.id)] = true end
  for _, a in ipairs(items) do
    if not ids[tostring(a.id)] then return false end
  end
  return true
end

local function saved_native(appid)
  if M.deps.native then return M.deps.native(appid) end
  local ok, mapping = pcall(function()
    local saved = require("resolve_identity").saved(appid)
    return saved and saved.data and saved.data.native and saved.data.native.appid
  end)
  return ok and tonumber(mapping) or nil
end

--- Steam's list for a native app: stored, else fetched and stored.
local function steam_list(native)
  local s = ach_store.get_schema(native)
  if s then return s end
  local fetched = (M.deps.steam_fetch or require("steam_schema").fetch)(native)
  if fetched then ach_store.save_schema(native, fetched) end
  return fetched
end

--- { appid, source, provider, key, schema = { achievements }, unlocks = { [id] = unix }, native? }: the player's
--- achievements as the extension found them (the extension is the truth: the unlocks are replaced). Steam's own list
--- (names and icons in the user's language) is kept when the shortcut's Steam match covers every id (ADR-0056 rule).
function M.provide_achievements(data)
  local appid = shortcut(data.appid)
  local source = text(data.source)
  local key = text(data.key)
  local items = type(data.schema) == "table" and type(data.schema.achievements) == "table" and data.schema.achievements or nil
  if not appid or not source or not key or not items or #items == 0 then
    return { error = "need a shortcut appid, a source, a key and a non-empty list" }
  end
  local before = (ach_store.get_state(appid) or {}).unlocks or {}
  local unlocks = {}
  for id, at in pairs(type(data.unlocks) == "table" and data.unlocks or {}) do
    local t = type(at) == "table" and at.unlocked_time or at
    unlocks[tostring(id)] = { unlocked_time = tonumber(t) or 0 }
  end
  local schema_id = source .. "_" .. key
  local schema = {
    native_appid = 0, total = #items, achievements = items, source = source, fetched_at = now(),
    title = text(data.schema.title),
  }
  local native = tonumber(data.native) or saved_native(appid)
  if native and native > 0 then
    local ok, steam = pcall(steam_list, native)
    if ok and covered_by(items, steam) then schema_id, schema = native, steam end
  end
  ach_store.save_schema_and_sync(appid, schema_id, schema, unlocks, source)
  local new = {}
  for id in pairs(unlocks) do
    if not before[id] then new[#new + 1] = id end
  end
  table.sort(new)
  return { ok = true, part = require("ach_service").local_part(appid), new = new }
end

M.ProvideGame = method("ProvideGame", M.provide_game)
M.ForgetProvidedGame = method("ForgetProvidedGame", M.forget_game)
M.ProvideAchievements = method("ProvideAchievements", M.provide_achievements)

return M
