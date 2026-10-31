--- steam-cartridges - native ports: PC ports of console games (Bloodborne PC, ...) that record trophies their own way.
---
--- A port is a definition (data plus small path rules) in a game file, `native_ports_<game>.lua`, listed in FAMILIES.
--- This module is the engine every definition shares: it recognises a shortcut that launches a port, reads the port's
--- unlock files through a named format, adds the platinum, and builds the achievement schema. It reads files only:
--- no store, no network, no Steam (src_native_ports and ach_service persist; ADR-0072).
---
--- Adding a port of a game already here: one more definition in that game's file. Adding a game: a new
--- native_ports_<game>.lua and its name in FAMILIES. A new unlock file layout: one more entry in FORMATS.
--- First ask whether an achievement pack can describe it (achievement_packs.lua, ADR-0081): a user's JSON file compiled
--- into this same definition shape (id "pack_<id>", unlocks read by detection, format "detect"), with no release.
---
--- A definition:
---   id          unique, stable ("bloodborne_awakenchan"): kept in the schema and the store
---   name        what the user reads ("Bloodborne PC")
---   url         the port's home page
---   programs    exe basenames a shortcut may launch, lower case, no extension; a trailing * is a prefix
---   markers     files ("{exe}" = the launched file) that prove the port's folder, relative to it; searched from the exe's folder up two levels,
---               each marker at every level before the next marker
---   controller  true: a controller game (full controller support)
---   store_match false: never matched to a Steam store app automatically (the game is not sold on Steam)
---   game        the trophy list (below), shared by every port of the game
---   unlocks     { format = FORMATS key, files = fun(port) -> { paths } }
---   trophy_pack fun(port) -> path to the dump's trophy00.trp, or nil (icons; trophy_pack_icons)
---
--- A game without grades (Dusklight): trophy ids may be strings, `points` gives each one the same value, and
--- title_id, grade, dlc, hidden and global_pct may be missing.
--- A game: { key, title, title_id, auto_platinum = true|nil, trophies = { { id, grade (P/G/S/B), dlc, hidden,
--- global_pct, name, description }, ... } }. `auto_platinum`: the platinum (grade P) is added once every other
--- trophy outside the DLC is unlocked, as a PlayStation does.
---
--- `port` (what the definitions' functions get): { def, root, read, exists, getenv, list_dirs, expand, json }.

local M = {}

--- The game files. Order matters only when two definitions claim the same exe and folder.
M.FAMILIES = { "native_ports_bloodborne", "native_ports_dusklight" }

--- Injectable for tests. nil = the real dependency.
M.deps = {
  read = nil,        -- fun(path) -> string | nil
  getenv = nil,      -- fun(name) -> string | nil
  list = nil,        -- fun(dir) -> { child folder paths }
  definitions = nil, -- { definition, ... } instead of FAMILIES
}

--- The schema's shape version: a schema stored with another one is built again (src_native_ports).
M.SCHEMA_VERSION = 2

--- PlayStation trophy points by grade (the shadPS4 source's values: PSN's current platinum weight).
M.POINTS = { P = 300, G = 90, S = 30, B = 15 }

-- ------------------------------------------------------------------------------------------------ file access

local function read(p)
  if M.deps.read then return M.deps.read(p) end
  local f = io.open(p, "rb")
  if not f then return nil end
  local c = f:read("*a")
  f:close()
  return c
end

local function exists(p)
  if M.deps.read then return M.deps.read(p) ~= nil end
  local f = io.open(p, "rb")
  if f then f:close() return true end
  return false
end

local function getenv(name) return (M.deps.getenv or require("platform").getenv)(name) end

local function norm(p) return (tostring(p or ""):gsub("\\", "/"):gsub("/+$", "")) end
local function parent(p) return norm(p):match("^(.*)/[^/]+$") end
M.norm, M.parent = norm, parent

--- Child folders of `dir` (full paths).
local function list_dirs(dir)
  if M.deps.list then return M.deps.list(dir) end
  local ok_fs, fs = pcall(require, "fs")
  if not ok_fs or not fs or not fs.is_directory or not fs.is_directory(dir) then return {} end
  local ok, entries = pcall(fs.list, dir)
  local out = {}
  for _, e in ipairs(ok and entries or {}) do
    local p = norm(type(e) == "table" and (e.path or e.name) or e)
    if not p:find("/", 1, true) then p = dir .. "/" .. p end
    if fs.is_directory(p) then out[#out + 1] = p end
  end
  return out
end

--- `~` and %VARS% expanded (Windows' ExpandEnvironmentVariables, and a leading ~ for the user's folder).
local function expand(p)
  p = tostring(p or "")
  if p:sub(1, 1) == "~" then p = (getenv("USERPROFILE") or "") .. p:sub(2) end
  return norm((p:gsub("%%([%w_%(%)]+)%%", function(v) return getenv(v) or ("%" .. v .. "%") end)))
end

--- A JSON file as a table (empty when missing or broken).
local function json_file(path)
  local text = path and read(path)
  if not text then return {} end
  local ok, data = pcall(require("json").decode, text)
  return (ok and type(data) == "table") and data or {}
end

--- Files (not folders) in `dir` whose name ends with `ext` (".json", ".png"; any case): full paths.
local function list_files(dir, ext)
  if M.deps.list_files then return M.deps.list_files(dir, ext) end
  local ok_fs, fs = pcall(require, "fs")
  if not ok_fs or not fs or not fs.is_directory or not fs.is_directory(dir) then return {} end
  local ok, entries = pcall(fs.list, dir)
  local out = {}
  ext = tostring(ext or ""):lower()
  for _, e in ipairs(ok and entries or {}) do
    local p = norm(type(e) == "table" and (e.path or e.name) or e)
    if not p:find("/", 1, true) then p = dir .. "/" .. p end
    if p:lower():sub(-#ext) == ext and not fs.is_directory(p) then out[#out + 1] = p end
  end
  return out
end

local function port_of(def, root)
  return { def = def, root = root, read = read, exists = exists, getenv = getenv, list_dirs = list_dirs,
    expand = expand, json = json_file, parent = parent }
end
M.port_of = port_of

--- File access shared with achievement_packs.lua (one set of test seams: M.deps).
M.io = { read = read, exists = exists, getenv = getenv, list_dirs = list_dirs, list_files = list_files,
  expand = expand }

-- ------------------------------------------------------------------------------------------------ definitions

local loaded = nil

--- Every definition, from the game files (or deps.definitions).
function M.definitions()
  if M.deps.definitions then return M.deps.definitions end
  if not loaded then
    loaded = {}
    for _, family in ipairs(M.FAMILIES) do
      for _, def in ipairs(require(family)) do loaded[#loaded + 1] = def end
    end
  end
  return loaded
end

--- A definition by id.
function M.definition(id)
  for _, def in ipairs(M.definitions()) do
    if def.id == id then return def end
  end
  return nil
end

--- The program of a command line (basename, lower case, no extension) and its folder.
function M.program(cmd)
  local s = tostring(cmd or ""):gsub("^%s+", "")
  local first = s:match('^"([^"]*)"') or s:match("^(.-%.[eE][xX][eE])%s") or s:match("^(.-%.[eE][xX][eE])$") or s:match("^(%S*)")
  first = norm(first)
  local file = first:match("([^/]*)$") or first
  local base = file:gsub("%.%w+$", ""):lower()
  return base, (parent(first) or ""), file
end

--- Whether a definition's `programs` entry names this basename; a trailing `*` is a prefix ("dusklight*" also takes
--- the versioned AppImage "Dusklight-v2.0.3-linux-x86_64.AppImage").
local function program_is(entry, base)
  if entry:sub(-1) == "*" then return base:sub(1, #entry - 1) == entry:sub(1, -2) end
  return entry == base
end

--- The definition owning an exe basename, or nil (no file is read). For the emulator lists.
function M.for_program(base)
  base = tostring(base or ""):lower()
  for _, def in ipairs(M.definitions()) do
    for _, p in ipairs(def.programs or {}) do
      if program_is(p, base) then return def end
    end
  end
  return nil
end

--- The port a shortcut launches: a `port` (see the top), or nil. `only` limits the search to these definitions.
function M.find(exe, _launch_options, only)
  local base, dir, file = M.program(exe)
  if dir == "" then return nil end
  local dirs = {}
  for _ = 1, 3 do
    dirs[#dirs + 1] = dir
    dir = parent(dir)
    if not dir then break end
  end
  for _, def in ipairs(only or M.definitions()) do
    local runs = false
    for _, p in ipairs(def.programs or {}) do
      if program_is(p, base) then runs = true break end
    end
    if runs then
      for _, marker in ipairs(def.markers or {}) do
        for _, d in ipairs(dirs) do
          -- "{exe}": the launched file itself proves the port (a single-file build, an AppImage)
          local rel = marker == "{exe}" and file or marker
          if exists(d .. "/" .. rel) then return port_of(def, d) end
        end
      end
    end
  end
  return nil
end

--- Every supported port and how many of the given shortcuts launch it: [{ id, name, detected }]. The shortcuts are registry entries
--- ({ exe, launch_options }); a port is detected by its program and the marker files next to it (`find`), as the sources do.
function M.status(entries)
  local out = {}
  for _, def in ipairs(M.definitions()) do
    local n = 0
    for _, e in ipairs(entries or {}) do
      if M.find(e.exe, e.launch_options, { def }) then n = n + 1 end
    end
    out[#out + 1] = { id = tostring(def.id), name = def.name or tostring(def.id), detected = n }
  end
  return out
end

--- The port of the definition a stored schema names (`schema.native_port`), for this shortcut, or nil. An
--- achievement pack's id starts with "pack_" (achievement_packs.lua); a built-in's is matched by its markers.
--- The observer and the reset use it, so they read and clear what the game actually uses, never a first match.
function M.port_by_id(def_id, exe, launch_options, appid)
  if type(def_id) ~= "string" then return nil end
  if def_id:match("^pack_") then
    local packs = require("achievement_packs")
    local def = packs.by_id(def_id)
    if not def or not (packs.matches(def, exe) or (appid and packs.assigned(appid) == def.pack.id)) then return nil end
    local _, dir = M.program(exe)
    return port_of(def, dir)
  end
  local def = M.definition(def_id)
  return def and M.find(exe, launch_options, { def }) or nil
end

-- ------------------------------------------------------------------------------------------------ unlocks

--- Unlock file layouts: parse(text) -> { [id string] = unlock time }, clear(text) -> new text, count cleared.
M.FORMATS = {
  --- "<trophy id> <unix seconds>" per line; the earliest time per trophy wins; other lines are skipped.
  id_time_log = {
    parse = function(text)
      local out = {}
      for line in tostring(text or ""):gmatch("[^\r\n]+") do
        local id, when = line:match("^%s*(%d+)%s+(%d+)")
        id, when = tonumber(id), tonumber(when)
        if id and when then
          local key = tostring(id)
          if not out[key] or when < out[key] then out[key] = when end
        end
      end
      return out
    end,
    clear = function(text)
      local n = 0
      for _ in tostring(text or ""):gmatch("[^\r\n]+") do n = n + 1 end
      return "", n
    end,
  },
  --- One JSON object, `"<key>": { "unlocked": bool, ... }` per achievement (Dusklight), no unlock time: an unlock
  --- is stamped when first seen. Clearing flips `unlocked` to false and leaves the rest of the file as it was.
  key_flags_json = {
    parse = function(text)
      local out = {}
      local ok, data = pcall(require("json").decode, tostring(text or ""))
      if not (ok and type(data) == "table") then return out end
      local now = os.time()
      for key, entry in pairs(data) do
        if type(entry) == "table" and entry.unlocked == true then out[tostring(key)] = now end
      end
      return out
    end,
    clear = function(text)
      local n = 0
      local out = tostring(text or ""):gsub('("unlocked"%s*:%s*)true', function(head) n = n + 1 return head .. "false" end)
      return out, n
    end,
  },
}

--- The port's unlock files: { { path, format } } (each may not exist yet). An achievement pack's format is
--- "detect": its files are read by unlock_detect.lua, which finds the pack's ids in any layout (ADR-0081).
function M.unlock_files(port)
  local u = port and port.def.unlocks
  local format = u and (u.detect and "detect" or u.format)
  if not u or not (format == "detect" or M.FORMATS[format]) then return {} end
  local out = {}
  for _, p in ipairs(u.files(port) or {}) do out[#out + 1] = { path = norm(p), format = format } end
  return out
end

--- One file's text with its unlocks cleared, and how many: the format's own clear, or detection for a pack.
function M.clear(port, format, text)
  if format == "detect" then return require("unlock_detect").clear(text, port.def.detect_list) end
  local f = M.FORMATS[format or ""]
  if not f then return nil, "unsupported file" end
  return f.clear(text)
end

--- The ids a game knows, as a set of id strings.
local function known_ids(game)
  local set = {}
  for _, t in ipairs(game.trophies) do set[tostring(t.id)] = true end
  return set
end

--- The platinum, when the game awards it and every other non-DLC trophy is in: { id, time } or nil.
function M.platinum(game, unlocks)
  if not game.auto_platinum then return nil end
  local plat, last = nil, 0
  for _, t in ipairs(game.trophies) do
    if t.grade == "P" then
      plat = tostring(t.id)
    elseif not t.dlc then
      local u = unlocks[tostring(t.id)]
      if not u then return nil end
      last = math.max(last, u.unlocked_time or 0)
    end
  end
  if not plat or unlocks[plat] then return nil end
  return plat, last
end

--- Unlocks read from one file's text: id string -> { unlocked_time }, only ids the game knows.
function M.parse(port, format, text)
  local known = known_ids(port.def.game)
  local out = {}
  local found
  if format == "detect" then
    -- No time in the file (0): the unlock is stamped when first seen, as key_flags_json does.
    found = require("unlock_detect").read(text, port.def.detect_list)
    local now = os.time()
    for id, when in pairs(found) do found[id] = (when and when > 0) and when or now end
  else
    local f = M.FORMATS[format]
    found = f and f.parse(text) or {}
  end
  for id, when in pairs(found) do
    if known[id] then out[id] = { unlocked_time = when } end
  end
  return out
end

--- Every unlock in the port's files, the platinum included: id string -> { unlocked_time }.
function M.read_unlocks(port)
  local out = {}
  for _, f in ipairs(M.unlock_files(port)) do
    for id, info in pairs(M.parse(port, f.format, read(f.path))) do
      if not out[id] or info.unlocked_time < out[id].unlocked_time then out[id] = info end
    end
  end
  local plat, when = M.platinum(port.def.game, out)
  if plat then out[plat] = { unlocked_time = when } end
  return out
end

-- ------------------------------------------------------------------------------------------------ schema

--- The schema key in achievements.json: one per game, shared by its ports; an achievement pack's is its own id
--- ("pack_<id>").
function M.schema_key(port)
  if port.def.pack then return port.def.id end
  return "native_port_" .. tostring(port.def.game.key)
end

--- The achievement schema of the port's game; `icons` = { [trophy id number] = data URL } or nil.
function M.schema(port, icons, title)
  local game, list, n = port.def.game, {}, 0
  for _, t in ipairs(game.trophies) do
    local icon = icons and icons[t.id] or ""
    if icon ~= "" then n = n + 1 end
    list[#list + 1] = {
      id = tostring(t.id),
      name = t.name,
      description = t.description,
      -- No `icon_locked`: nothing reads it, and a data: URL there doubled the schema's size.
      icon = icon,
      points = game.points or M.POINTS[t.grade],
      global_pct = t.global_pct,
      ttype = t.grade,
      hidden = t.hidden == true,
      dlc = t.dlc == true,
    }
  end
  return {
    native_port = port.def.id,
    schema_version = M.SCHEMA_VERSION,
    -- An achievement pack's revision (a hash of its file): another one rebuilds the schema (src_native_ports).
    pack_rev = port.def.pack and port.def.pack.revision or nil,
    title_id = game.title_id,
    native_appid = 0,
    title = title or game.title,
    total = #list,
    icons = n,
    fetched_at = os.time(),
    achievements = list,
  }
end

--- The trophy ids of the port's game (numbers), for the icons.
function M.trophy_ids(port)
  local out = {}
  for _, t in ipairs(port.def.game.trophies) do out[#out + 1] = t.id end
  return out
end

return M
