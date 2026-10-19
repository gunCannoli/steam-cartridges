--- Which shortcuts has the plugin already seen? (migration plan M7a, Flow B).
---
--- <data dir>/known_shortcuts.json: { version = 1, appids = [ ... ] }. `new_shortcuts()` is the
--- shortcuts in shortcuts.vdf that are not in the file. **First run** (no file): every current
--- shortcut is written as known and nothing is returned, so an existing library (handled by the old
--- background sync) is never fetched in one storm. The backend has no timer; the frontend drives the
--- loop and calls `mark_known` after each shortcut is handled.

local json        = require("json")
local utils       = require("utils")
local data_dir    = require("data_dir")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")

local M = {}

local FILE = "known_shortcuts.json"
M._path = nil -- test override
--- Injectable for tests: fun() -> { { appid, name, exe }, ... }. nil = shortcuts.vdf.
M.deps = { entries = nil }

local function path() return M._path or data_dir.file(FILE) end

local function current_entries()
  if M.deps.entries then return M.deps.entries() end
  local ok, list = pcall(function()
    local paths = steam_paths.resolve()
    if not paths or not paths.shortcuts then return {} end
    return shortcuts.parse(paths.shortcuts) or {}
  end)
  return ok and list or {}
end

--- The shortcuts.vdf entry of one shortcut ({ appid, name, exe, launch_options, icon, ... }), or nil
--- (no readable shortcuts.vdf, or no such shortcut). The one lookup every service uses (M10: it was
--- four copies, in ach_service, art_service, resolve_identity and web_rpc).
function M.shortcut(appid)
  local n = tonumber(appid)
  if not n then return nil end
  return shortcuts.by_appid(current_entries())[n]
end

--- appid (unsigned) -> true, or nil when there is no usable file (first run).
local function read_known()
  local text = utils.read_file(path())
  if not text or #text == 0 then return nil end
  local ok, data = pcall(json.decode, text)
  if not ok or type(data) ~= "table" or type(data.appids) ~= "table" then return nil end
  local set = {}
  for _, id in ipairs(data.appids) do set[tonumber(id)] = true end
  return set
end

local function write_known(set)
  local ids = {}
  for id in pairs(set) do ids[#ids + 1] = id end
  table.sort(ids)
  local ok, err = utils.write_file(path(), json.encode({ version = 1, appids = ids }))
  if not ok then error("could not write " .. path() .. ": " .. tostring(err)) end
end

local function unsigned(id)
  local n = tonumber(id) or 0
  if n < 0 then n = n + 4294967296 end
  return n
end

--- [{ appid, name, exe }] not seen before. Seeds the file (returning []) on the first run.
function M.new_shortcuts()
  local entries = current_entries()
  local known = read_known()
  if not known then
    local seed = {}
    for _, e in ipairs(entries) do seed[unsigned(e.appid)] = true end
    write_known(seed)
    return {}
  end
  local out = {}
  for _, e in ipairs(entries) do
    local id = unsigned(e.appid)
    if not known[id] then out[#out + 1] = { appid = id, name = e.name or "", exe = e.exe or "" } end
  end
  return out
end

--- Add appids to the known set.
function M.mark_known(appids)
  local known = read_known() or {}
  for _, id in ipairs(appids or {}) do known[unsigned(id)] = true end
  write_known(known)
end

return M
