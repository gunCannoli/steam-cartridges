--- A second copy of the plugin's settings (ADR-0090): <data dir>/settings.json, { values = { <key> = <json value> } }.
---
--- The frontend keeps its settings in Millennium's Configuration API (config.json). A beta user's settings, rules and
--- Auto Mode were all lost on every restart: the panel showed the saved value (an in-memory copy) but the next start read
--- defaults. The backend's own files are known to persist, so every setting is mirrored here and the frontend falls back to
--- this copy when the Configuration API gives nothing back (frontend/settings/settings.ts). The backend never interprets a
--- value: the frontend validates what it reads.
---
--- A store: disk only, never the network.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "settings.json"
M._path = nil -- test override

local state = nil

local function path() return M._path or data_dir.file(FILE) end

function M._reset() state = nil end

local function load()
  if state then return state end
  state = { values = {} }
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" and type(data.values) == "table" then state.values = data.values end
  end
  return state
end

local function save()
  return utils.write_file(path(), json.encode(load()))
end

--- A key the frontend may store: letters, digits and underscores.
local function valid_key(key)
  return type(key) == "string" and #key > 0 and #key <= 64 and key:match("^[%w_]+$") ~= nil
end

--- Every stored value, by key.
function M.get_all()
  return load().values
end

--- Stores `values` (key -> value) and removes `remove` (list of keys) in one write. Returns how many keys changed.
function M.apply(values, remove)
  local s, changed = load(), 0
  for key, value in pairs(type(values) == "table" and values or {}) do
    if valid_key(key) and value ~= nil then
      s.values[key] = value
      changed = changed + 1
    end
  end
  for _, key in ipairs(type(remove) == "table" and remove or {}) do
    if valid_key(key) and s.values[key] ~= nil then
      s.values[key] = nil
      changed = changed + 1
    end
  end
  if changed > 0 then save() end
  return changed
end

return M
