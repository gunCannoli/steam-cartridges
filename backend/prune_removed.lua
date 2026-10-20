--- steam-cartridges - forget shortcuts that left the library (ADR-0078).
---
--- Stores keep a shortcut's records after the user removes it from Steam (Game Info, freshness, media, pushed data, an
--- achievements entry). This drops them once the shortcut has been gone for GRACE_DAYS: a shortcut removed and added
--- back (same exe and name, so the same appid) keeps everything within that time.
---
--- Never deleted: the user's own Game Info edits (custom_override), an achievements entry holding unlocks (progress),
--- and steam_store.json (user state by its own rule: Steam links, rejected suggestions, written artwork).
--- Never run blind: with no readable shortcuts.vdf, or one listing no shortcut, nothing is pruned or marked.
---
--- <data dir>/missing_shortcuts.json: { version = 1, missing = { ["<appid>"] = unix seconds first seen missing } }.

local json   = require("json")
local logger = require("logger")

local M = {}

M.GRACE_DAYS = 7

--- Injectable for tests. nil = the real dependency.
M.deps = {
  current = nil, -- fun() -> { [appid string] = true } | nil ; nil = shortcuts.vdf
  now = nil,     -- fun() -> unix seconds
  path = nil,    -- the state file
}

local function state_path() return M.deps.path or require("data_dir").file("missing_shortcuts.json") end

local function read_state()
  local f = io.open(state_path(), "rb")
  if not f then return { version = 1, missing = {} } end
  local ok, data = pcall(json.decode, f:read("*a") or "")
  f:close()
  if ok and type(data) == "table" and type(data.missing) == "table" then return data end
  return { version = 1, missing = {} }
end

local function write_state(state)
  local f = io.open(state_path(), "wb")
  if not f then return end
  f:write(json.encode(state))
  f:close()
end

--- The appids (strings) shortcuts.vdf lists now, or nil when it cannot be read.
local function current_shortcuts()
  if M.deps.current then return M.deps.current() end
  local ok, list = pcall(function()
    local paths = require("steam_paths").resolve()
    if not paths or not paths.shortcuts then return nil end
    return require("shortcuts").parse(paths.shortcuts)
  end)
  if not ok or type(list) ~= "table" then return nil end
  local set = {}
  for _, e in ipairs(list) do
    if e.appid then set[tostring(math.floor(tonumber(e.appid) or 0))] = true end
  end
  return set
end

--- The stores, each: keys() -> { appid strings }, forget(appid) -> removed?
local function stores()
  local metadata_db = require("web_metadata_db")
  local achievements = require("achievements_store")
  local fresh = require("fresh_policy")
  local media = require("media_store")
  local provided = require("provided_store")
  return {
    { name = "metadata", keys = function()
        local out = {}
        for k in pairs(metadata_db.get_all() or {}) do out[#out + 1] = tostring(k) end
        return out
      end,
      forget = function(k)
        local rec = metadata_db.get(k)
        if rec and rec.custom_override then return false end -- the user's own edit
        return metadata_db.delete(k)
      end },
    { name = "achievements", keys = achievements.shortcut_keys, forget = achievements.forget },
    { name = "freshness", keys = fresh.keys, forget = function(k) fresh.forget(k); return true end },
    { name = "media", keys = media.keys, forget = function(k) media.delete(k); return true end },
    { name = "provided", keys = provided.keys, forget = function(k) provided.delete(k); return true end },
  }
end

--- One pass. Returns { skipped = why } or { marked = n, restored = n, forgotten = n }.
function M.run()
  local current = current_shortcuts()
  if not current or next(current) == nil then return { skipped = "no shortcuts.vdf, or no shortcut in it" } end
  local now = (M.deps.now or os.time)()
  local state = read_state()
  local list = stores()
  local stored = {}
  for _, store in ipairs(list) do
    local ok, keys = pcall(store.keys)
    for _, k in ipairs(ok and type(keys) == "table" and keys or {}) do stored[tostring(k)] = true end
  end

  local result = { marked = 0, restored = 0, forgotten = 0 }
  for k in pairs(state.missing) do
    if current[k] then
      state.missing[k] = nil
      result.restored = result.restored + 1
    end
  end
  for k in pairs(stored) do
    if not current[k] and tonumber(k) and tonumber(k) > 0 then
      local since = tonumber(state.missing[k])
      if not since then
        state.missing[k] = now
        result.marked = result.marked + 1
      elseif now - since >= M.GRACE_DAYS * 86400 then
        for _, store in ipairs(list) do pcall(store.forget, k) end
        state.missing[k] = nil
        result.forgotten = result.forgotten + 1
      end
    end
  end
  write_state(state)
  if result.marked + result.forgotten > 0 then
    logger:info(string.format("Removed shortcuts: %d newly missing, %d forgotten after %d days, %d back",
      result.marked, result.forgotten, M.GRACE_DAYS, result.restored))
  end
  return result
end

return M
