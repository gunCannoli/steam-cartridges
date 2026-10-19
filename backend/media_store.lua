--- Community media per shortcut (features plan F2): what media_service resolved, in
--- <data dir>/community_media.json: { version = 1, games = { ["<appid>"] = { items = [...], igdb_id?, ss_id? } } }.
---
--- Small by design: public IGDB URLs and ScreenScraper keys, never image bytes and never a ScreenScraper URL
--- (they carry the account). A store stores; it never fetches (ADR-0044).

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "community_media.json"
local state = nil
M._path = nil -- test override

local function path() return M._path or data_dir.file(FILE) end

local function load()
  if state then return state end
  state = { version = 1, games = {} }
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" and type(data.games) == "table" then state.games = data.games end
  end
  return state
end

local function save()
  local tmp = path() .. ".tmp"
  local ok, err = utils.write_file(tmp, json.encode(load()))
  if not ok then error("could not write " .. tmp .. ": " .. tostring(err)) end
  pcall(os.remove, path())
  if not os.rename(tmp, path()) then
    utils.write_file(path(), json.encode(load()))
    pcall(os.remove, tmp)
  end
end

local function key(appid) return tostring(math.floor(tonumber(appid) or 0)) end

function M._reset() state = nil end

--- The stored media for a shortcut, or nil.
function M.get(appid)
  local data = load().games[key(appid)]
  return type(data) == "table" and data or nil
end

--- Store (replace) a shortcut's media. A disk error costs a refetch later, never a failed EnsureFresh.
function M.set(appid, data)
  load().games[key(appid)] = data
  return pcall(save)
end

function M.delete(appid)
  load().games[key(appid)] = nil
  return pcall(save)
end

return M
