local fs = require("fs")
local utils = require("utils")
local logger = require("logger")
local data_dir = require("data_dir")

local config = {}

local cached_key = nil

--- Read key from file if it exists
local function read_key_file(path)
  if not fs.is_file(path) then return nil end
  local content = utils.read_file(path)
  if not content then return nil end
  local key = content:gsub("%s", "")
  if #key > 0 then return key end
  return nil
end

local cached_env = nil

--- Parse .env file for all key=value pairs
local function parse_env_all(path)
  if not fs.is_file(path) then return nil end
  local content = utils.read_file(path)
  if not content then return nil end
  local map = {}
  for line in content:gmatch("[^\r\n]+") do
    local k, v = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
    if k and v then
      local val = v:gsub("^[\"']", ""):gsub("[\"']$", ""):gsub("%s", "")
      map[k:lower()] = val
    end
  end
  return map
end

-- LEGACY, removed in P4 (ADR-0011): the cwd-relative search the old artwork
-- plugin used. Still read after the data folder so nothing breaks before
-- migrate.run() has copied the credentials across.
config.legacy_env_candidates = {
  ".env",
  "../.env",
  "../../.env",
  "../../../.env",
}

--- First legacy .env that parses to a non-empty map (used by migrate too).
---@return table|nil
function config.find_legacy_env()
  for _, path in ipairs(config.legacy_env_candidates) do
    local m = parse_env_all(path)
    if m and next(m) then return m end
  end
  return nil
end

--- Read the legacy cwd-relative sgdb_key.txt (used by migrate).
---@return string|nil
function config.find_legacy_key()
  return read_key_file("sgdb_key.txt")
end

--- A setting whose value is a secret (a key, a password, a token): written to the `.env` as a token of the secure store (secret_store.lua, ADR-0099).
--- A user name or a client id is not secret and stays readable.
local function is_secret_key(key)
  local k = tostring(key):lower()
  for _, word in ipairs({ "secret", "pass", "pw", "api", "token", "key" }) do
    if k:find(word, 1, true) then return true end
  end
  return false
end

--- A `.env` as parsed, with each protected value opened. A value that cannot be opened (another Windows user, another PC) is left out and named once
--- in the log: the user adds it again.
local function reveal_all(map)
  local out = {}
  local store = require("secret_store")
  for k, v in pairs(map) do
    if store.is_token(v) then
      local plain, err = store.reveal(v)
      if plain then
        out[k] = plain
      else
        logger:warn("A saved value (" .. tostring(k) .. ") could not be opened: " .. tostring(err) .. ". Add it again in Settings.")
      end
    else
      out[k] = v
    end
  end
  return out
end

local function get_env_map()
  if cached_env then return cached_env end
  local legacy = config.find_legacy_env() or {}
  local stored = reveal_all(parse_env_all(data_dir.file(".env")) or {})
  local merged = {}
  for k, v in pairs(legacy) do merged[k] = v end
  for k, v in pairs(stored) do merged[k] = v end
  if next(merged) then
    cached_env = merged
    return merged
  end
  return {}
end

--- Test hook: drop cached credentials.
function config._reset()
  cached_key = nil
  cached_env = nil
end

--- Resolve SteamGridDB API key from sgdb_key.txt or .env
---@return string|nil key
function config.get_api_key()
  if cached_key then return cached_key end

  local key = read_key_file(data_dir.file("sgdb_key.txt"))
  if not key then key = read_key_file("sgdb_key.txt") end -- LEGACY, removed in P4
  if key then
    cached_key = key
    return key
  end

  local env_map = get_env_map()
  local k = env_map["steamgriddb_api"]
  if k and #k > 0 then
    cached_key = k
    return k
  end

  return nil
end

--- Resolve Twitch Client ID & Secret for IGDB API
---@return table|nil { client_id = string, client_secret = string }
function config.get_twitch_credentials()
  local env_map = get_env_map()
  local id = env_map["twitch_client_id"]
  local sec = env_map["twitch_client_secret"]
  if id and #id > 0 and sec and #sec > 0 then
    return { client_id = id, client_secret = sec }
  end
  return nil
end

--- Resolve RetroAchievements credentials from .env if provided
---@return table|nil { token = string, api_key = string, username = string|nil }
function config.get_retroachievements_credentials()
  local env_map = get_env_map()
  local api = env_map["retroachievements_api"] or env_map["ra_api_key"] or env_map["ra_key"]
  local user = env_map["retroachievements_user"] or env_map["ra_username"] or env_map["ra_user"]
  if not user or #user == 0 then
    user = env_map["xbox_gamertag"]
  end
  if api and #api > 0 then
    return { token = api, api_key = api, username = (user and #user > 0) and user or nil }
  end
  return nil
end


--- ScreenScraper: the player's account (Settings -> Metadata -> Add service, saved as screenscraper_user /
--- screenscraper_pass) and the plugin's developer id (screenscraper_dev.lua, shipped; screenscraper_dev_user /
--- screenscraper_dev_pw in .env override it). nil without a player account: every player brings their own, so requests
--- count against their ScreenScraper quota, not one shared anonymous one.
---@return table|nil { user = string, pass = string, dev_user = string, dev_pw = string }
function config.get_screenscraper_credentials()
  local env_map = get_env_map()
  local u = env_map["screenscraper_user"]
  local p = env_map["screenscraper_pass"]
  if not u or #u == 0 or not p or #p == 0 then return nil end
  local dev_user, dev_pw = env_map["screenscraper_dev_user"], env_map["screenscraper_dev_pw"]
  if not dev_user or #dev_user == 0 or not dev_pw or #dev_pw == 0 then
    local ok, dev = pcall(function() return require("screenscraper_dev").get() end)
    dev_user, dev_pw = ok and dev.id or "", ok and dev.password or ""
  end
  return { user = u, pass = p, dev_user = dev_user, dev_pw = dev_pw }
end

--- Turns every plain secret in `map` into its token (secret_store). A value no store can take stays plain text; returns how many were
--- protected and how many were left plain.
function config._protect_map(map)
  local store = require("secret_store")
  local protected, plain = 0, 0
  for k, v in pairs(map) do
    if is_secret_key(k) and not store.is_token(v) then
      local token, err = store.protect(k, v)
      if token then
        map[k] = token
        protected = protected + 1
      else
        plain = plain + 1
        logger:warn("Could not protect " .. tostring(k) .. " (" .. tostring(err) .. "): it stays plain text.")
      end
    end
  end
  return protected, plain
end

--- At start-up: the keys an earlier version saved as plain text are protected now, once (ADR-0099), and the old SteamGridDB key file is folded
--- into the `.env`. Returns { store, protected, plain } for the log.
function config.protect_existing()
  local store = require("secret_store")
  local env_path = data_dir.file(".env")
  local current = parse_env_all(env_path) or {}
  -- The legacy sgdb_key.txt held the SteamGridDB key as plain text in its own file.
  local key_path = data_dir.file("sgdb_key.txt")
  local legacy_key = read_key_file(key_path)
  if legacy_key and not current["steamgriddb_api"] then current["steamgriddb_api"] = legacy_key end
  local protected, plain = config._protect_map(current)
  local already = 0
  for k, v in pairs(current) do if is_secret_key(k) and store.is_token(v) then already = already + 1 end end
  already = already - protected -- the ones protected just now are not "already"
  if protected > 0 or legacy_key then
    local lines = {}
    for k, v in pairs(current) do table.insert(lines, k .. "=" .. v) end
    table.sort(lines)
    local ok = utils.write_file(env_path, table.concat(lines, "\n") .. "\n")
    if ok ~= false then pcall(function() require("host_tools").private_file(env_path) end) end
    if ok ~= false and legacy_key then
      pcall(fs.remove, key_path)
    end
    cached_env, cached_key = nil, nil
    pcall(function() require("plog").forget_known() end)
  end
  return { store = store.store(), protected = protected, plain = plain, already = already }
end

--- Save key-value pairs into data_dir .env. Key names only in the log, never values.
function config.save_credentials(map)
  if type(map) ~= "table" then return false end
  local env_path = data_dir.file(".env")
  local current = parse_env_all(env_path) or {} -- protected values stay as the tokens they are
  local saved, cleared = {}, {}
  for k, v in pairs(map) do
    local key = tostring(k):lower():gsub("%s", "")
    local val = tostring(v or ""):gsub("^%s+", ""):gsub("%s+$", "")
    if #val > 0 then
      current[key] = val
      saved[#saved + 1] = key
    else
      current[key] = nil
      cleared[#cleared + 1] = key
    end
  end
  config._protect_map(current)
  local lines = {}
  for k, v in pairs(current) do
    table.insert(lines, k .. "=" .. v)
  end
  table.sort(lines)
  local ok = utils.write_file(env_path, table.concat(lines, "\n") .. "\n")
  if ok ~= false then pcall(function() require("host_tools").private_file(env_path) end) end -- chmod 600 on Linux; a no-op on Windows
  -- Drop the cache instead of setting it to `current`: `current` is the data folder's .env alone, and the next read
  -- must merge the legacy .env again (it may hold the only ScreenScraper account, so GetStatus said none after a save).
  cached_env = nil
  cached_key = nil -- the SteamGridDB key may have changed (re-read on next use)
  pcall(function() require("plog").forget_known() end) -- the log scrubs the saved values: pick up the new ones
  pcall(function()
    local plog = require("plog")
    if ok == false then
      plog.write("ERROR", "[credentials] could not write " .. env_path)
    else
      table.sort(saved)
      table.sort(cleared)
      local parts = {}
      if #saved > 0 then parts[#parts + 1] = "saved: " .. table.concat(saved, ", ") end
      if #cleared > 0 then parts[#parts + 1] = "cleared: " .. table.concat(cleared, ", ") end
      if #parts > 0 then plog.event("credentials", table.concat(parts, "; ") .. " (" .. require("secret_store").store() .. ")") end
    end
  end)
  return ok ~= false
end

--- Set or update the API key locally
---@param new_key string
---@return boolean success
function config.set_api_key(new_key)
  local k = tostring(new_key or ""):gsub("%s", "")
  if k == "" then
    cached_key = nil
    local key_path = data_dir.file("sgdb_key.txt")
    if fs.is_file(key_path) then
      fs.remove(key_path)
    end
    logger:info("SteamGridDB API key cleared.")
    return true
  end

  local ok, err = utils.write_file(data_dir.file("sgdb_key.txt"), k)
  if ok then
    cached_key = k
    logger:info("SteamGridDB API key saved to the data folder.")
    return true
  else
    logger:warn("Could not save sgdb_key.txt: " .. tostring(err))
    return false
  end
end

return config

