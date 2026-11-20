--- steam-cartridges - Vita3K Local PlayStation Vita Trophy Provider.
---
--- Trophies for games launched through Vita3K, read from the emulator's own files (no sign-in, no network, same on
--- Windows and Linux). Layout (PlayniteAchievements' Vita3K provider, MIT, and Vita3K's own source):
---   data root      <Vita3K folder>/portable/fs            when a `portable` folder sits next to the exe
---                  config.yml `pref-path`                 else, when set
---                  %APPDATA%/Vita3K/Vita3K                else (Linux: ~/.local/share/Vita3K/Vita3K, Flatpak too)
---   definitions    ux0/user/<id>/trophy/conf/<NPWR>/TROPCONF.SFM + TROPnnn.PNG  (Vita3K copies them out of the game's
---                  TROPHY.TRP on its first boot: a game never booted has none, and says so)
---   progress       ux0/user/<id>/trophy/data/<NPWR>/TROPUSR.DAT  (Vita3K's OWN 1648-byte little-endian record, not
---                  Sony's: magic 0x12D5819A, unlocked bitset 4 x u32 at +4, trophy count u32 at +0x28, unlock times
---                  128 x u64 (Unix seconds) at +0x70)
---   NPWR of a game ux0/app/<PCSxnnnnn>/sce_sys/trophy/<NPWR>/
--- The title id (PCSx#####) is read from the shortcut's command line (Vita3K's `-r <title id>`).

local utils       = require("utils")
local fs          = require("fs")
local logger      = require("logger")
local platform    = require("platform")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")
local store       = require("achievements_store")

local M = {}

--- Injectable dependencies for testing.
M.deps = {
  steam_paths = nil,
  shortcuts = nil,
  store = nil,
  default_roots = nil, -- fun() -> { data root, ... } ; nil = the per-user Vita3K folders found through platform.lua
}

local MAGIC, FILE_SIZE, MAX_TROPHIES = 0x12D5819A, 0x670, 128

local function is_file(p)
  if not p or p == "" then return false end
  local f = io.open(p, "rb")
  if f then f:close() return true end
  return false
end

local function is_dir(p)
  if not p or p == "" then return false end
  local ok, res = pcall(fs.is_directory, p)
  return ok and res == true
end

local function list(dir)
  local ok, entries = pcall(fs.list, dir)
  local out = {}
  if not ok or type(entries) ~= "table" then return out end
  for _, e in ipairs(entries) do
    local name = type(e) == "table" and (e.name or e.path) or tostring(e)
    name = tostring(name):gsub("\\", "/"):match("([^/]+)$")
    if name then out[#out + 1] = name end
  end
  table.sort(out)
  return out
end

local function slashes(p) return (tostring(p or ""):gsub("\\", "/"):gsub("/+$", "")) end

--- Distinct unlocks in a table that lists each one under its plain and zero-padded id.
local function count_unlocks(t)
  local seen, c = {}, 0
  for _, v in pairs(t or {}) do
    if not seen[v] then seen[v] = true c = c + 1 end
  end
  return c
end

--- A file:// address that is right on Windows ("C:/x") and Linux ("/home/x").
local function file_url(p)
  p = slashes(p)
  if p:sub(1, 1) == "/" then return "file://" .. p end
  return "file:///" .. p
end

-- ---------- pure readers ----------

local function u32le(data, pos) -- pos is 1-based
  local a, b, c, d = data:byte(pos, pos + 3)
  if not d then return nil end
  return ((d * 256 + c) * 256 + b) * 256 + a
end

--- Unlocked trophies of Vita3K's TROPUSR.DAT: id string ("0" and "000") -> { unlocked_time }, or nil and why.
--- A time Vita3K did not record is 0 there; the unlock then carries the current time (never invented as an old date).
function M.parse_tropusr(data, now)
  if type(data) ~= "string" or #data ~= FILE_SIZE then
    return nil, "unexpected file size " .. tostring(type(data) == "string" and #data or 0)
  end
  if u32le(data, 1) ~= MAGIC then return nil, "unexpected file magic" end
  local count = u32le(data, 0x28 + 1)
  if not count or count > MAX_TROPHIES then return nil, "trophy count out of range" end
  local out = {}
  for id = 0, count - 1 do
    local word = u32le(data, 0x04 + math.floor(id / 32) * 4 + 1)
    if word and math.floor(word / 2 ^ (id % 32)) % 2 == 1 then
      local at = 0x70 + id * 8 + 1
      local lo, hi = u32le(data, at), u32le(data, at + 4)
      local secs = (lo or 0) + (hi or 0) * 4294967296
      if secs <= 0 or secs > 4102444800 then secs = now or os.time() end
      local t = { unlocked_time = secs }
      out[tostring(id)] = t
      out[string.format("%03d", id)] = t
    end
  end
  return out
end

--- A top-level `key: value` of Vita3K's config.yml (yaml-cpp writes plain lines, values optionally quoted).
function M.config_value(text, key)
  for line in tostring(text or ""):gmatch("[^\r\n]+") do
    if not line:match("^%s") and line:sub(1, 1) ~= "#" then
      local k, v = line:match("^([^:]+):%s*(.-)%s*$")
      if k == key then
        v = v:gsub("^['\"]", ""):gsub("['\"]$", "")
        return v ~= "" and v or nil
      end
    end
  end
  return nil
end

--- The PS Vita title id in a command line (Vita3K's `-r PCSE00001`), upper case, or nil.
function M.title_id(cmd)
  local s = tostring(cmd or "")
  local id = s:match("%f[%w]([Pp][Cc][Ss][A-Za-z]%d%d%d%d%d)%f[%W]")
  return id and id:upper() or nil
end

-- ---------- finding the files ----------

local function tokens(exe, launch_options)
  local full = slashes(tostring(exe or "") .. " " .. tostring(launch_options or ""))
  local out = {}
  for q in full:gmatch('"([^"]+)"') do out[#out + 1] = q end
  for t in full:gmatch("%S+") do out[#out + 1] = (t:gsub('"', "")) end
  return out
end

local function default_roots()
  if M.deps.default_roots then return M.deps.default_roots() end
  return platform.locate({ "Vita3K/Vita3K" }, is_dir)
end

--- Candidate emulated-filesystem roots for a command, best first (a folder that holds ux0).
function M.data_roots(exe, launch_options)
  local out, seen = {}, {}
  local function add(p)
    p = slashes(p)
    if p ~= "" and not seen[p] and is_dir(p .. "/ux0") then seen[p] = true out[#out + 1] = p end
  end
  for _, tok in ipairs(tokens(exe, launch_options)) do
    if tok:lower():find("vita3k", 1, true) then
      local dir = tok:match("^(.*)/[^/]+$") or tok
      if is_dir(dir .. "/portable") then
        add(dir .. "/portable/fs")
      else
        local cfg = utils.read_file(dir .. "/config.yml")
        local pref = cfg and M.config_value(cfg, "pref-path")
        if pref then add(pref) end
      end
    end
  end
  for _, p in ipairs(default_roots()) do add(p) end
  return out
end

--- The user folder name: config.yml's user-id when it exists, else the first folder with a user.xml (Vita3K's own fallback).
local function user_ids(root)
  local users = root .. "/ux0/user"
  local out = {}
  for _, name in ipairs(list(users)) do
    if is_file(users .. "/" .. name .. "/user.xml") then out[#out + 1] = name end
  end
  return out
end

--- The trophy files of a game: { title_id, npcommid, conf_dir, data_path, data_root, user } or nil.
--- Needs "vita3k" in the command and a title id; the game must have been booted once (its conf folder exists).
function M.find_trophy_dir(exe, launch_options)
  local cmd = tostring(exe or "") .. " " .. tostring(launch_options or "")
  if not cmd:lower():find("vita3k", 1, true) then return nil end
  local tid = M.title_id(cmd)
  if not tid then return nil end
  for _, root in ipairs(M.data_roots(exe, launch_options)) do
    local npwrs = {}
    for _, name in ipairs(list(root .. "/ux0/app/" .. tid .. "/sce_sys/trophy")) do
      if name:match("^NPWR%d+_%d+$") then npwrs[#npwrs + 1] = name end
    end
    for _, user in ipairs(user_ids(root)) do
      for _, npwr in ipairs(npwrs) do
        local conf = root .. "/ux0/user/" .. user .. "/trophy/conf/" .. npwr
        if is_file(conf .. "/TROPCONF.SFM") then
          return {
            title_id = tid, npcommid = npwr, conf_dir = conf, data_root = root, user = user,
            data_path = root .. "/ux0/user/" .. user .. "/trophy/data/" .. npwr .. "/TROPUSR.DAT",
          }
        end
      end
    end
  end
  return nil
end

--- Main entry point for Vita3K shortcuts: reads the definitions and the player's progress and saves both.
function M.get_or_fetch(shortcut_appid)
  local s_appid = tonumber(shortcut_appid) or 0
  if s_appid <= 0 then return nil, "invalid shortcut_appid" end

  local store_mod = M.deps.store or store
  local paths = (M.deps.steam_paths or steam_paths).resolve()
  if not paths or not paths.shortcuts then return nil, "missing shortcuts path" end
  local sc
  for _, entry in ipairs((M.deps.shortcuts or shortcuts).parse(paths.shortcuts) or {}) do
    if entry.appid == s_appid then sc = entry break end
  end
  if not sc then return nil, "shortcut not found" end

  local found = M.find_trophy_dir(sc.exe, sc.launch_options)
  if not found then return nil, "vita3k trophy files not found (boot the game once in Vita3K)" end

  local sfm = utils.read_file(found.conf_dir .. "/TROPCONF.SFM")
  if not sfm then return nil, "cannot read TROPCONF.SFM" end
  local parsed, err = require("ps3_trophies").parse_tropconf(sfm, found.conf_dir)
  if not parsed then return nil, err end
  for _, a in ipairs(parsed.achievements) do
    a.icon = file_url(found.conf_dir .. "/TROP" .. a.id .. ".PNG")
    a.icon_locked = a.icon
  end

  local unlocks, usr_err = {}, nil
  if is_file(found.data_path) then
    unlocks, usr_err = M.parse_tropusr(utils.read_file(found.data_path) or "")
    if not unlocks then
      -- A foreign or half-written file: say so and keep what is already saved, never wipe it.
      logger:info(string.format("[vita3k] progress file ignored (%s)", tostring(usr_err)))
      local st = store_mod.get_state(s_appid)
      unlocks = st and st.unlocks or {}
    end
  end

  local schema = {
    vita_title_id = found.title_id,
    vita_npcommid = found.npcommid,
    native_appid = 0,
    title = sc.name or sc.appname or found.title_id,
    total = parsed.total,
    fetched_at = os.time(),
    achievements = parsed.achievements,
  }
  store_mod.save_schema_and_sync(s_appid, "vita_" .. found.npcommid, schema, unlocks, "vita3k")

  local state = store_mod.get_state(s_appid) or {}
  state.schema, state.unlocks = schema, unlocks
  logger:info(string.format("[vita3k] loaded set for shortcut %d: %d trophies, %d unlocked", s_appid, schema.total,
    count_unlocks(unlocks)))
  return state
end

return M
