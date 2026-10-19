--- What extensions pushed about a shortcut (ADR-0067): <data dir>/provided_games.json. An extension (Epic, Xbox, ...)
--- reports a game's Game Info and media through the extension API; the core keeps them here and its metadata and media
--- services read them as one more source. No network here (tests/architecture.test.ts: a store never requires net).
---
--- { version = 1, games = { ["<shortcut appid>"] = { source, provider, title?, metadata?, media?, at } } }
---   source    the data's source id, shown in the record ("epic", "xbox", ...)
---   provider  the reporting extension's id
---   metadata  a Game Info record (the metadata part's shape)
---   media     community media items with public URLs ({ kind, source, url, thumb?, width?, height?, title? })

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "provided_games.json"
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

function M._reset() state = nil end

local function key(appid) return tostring(math.floor(tonumber(appid) or 0)) end

--- What was pushed for a shortcut, or nil. Disk only.
function M.get(appid) return load().games[key(appid)] end

--- Save (or, with nil, forget) a shortcut's pushed data; writes only when it changed (the time is not compared).
function M.set(appid, rec)
  local s = load()
  local k = key(appid)
  local old = s.games[k]
  if old and rec then
    local a, b = {}, {}
    for f, v in pairs(old) do if f ~= "at" then a[f] = v end end
    for f, v in pairs(rec) do if f ~= "at" then b[f] = v end end
    if json.encode(a) == json.encode(b) then return false end
  elseif not old and not rec then
    return false
  end
  s.games[k] = rec
  save()
  return true
end

--- Every shortcut appid (a string) with pushed data.
function M.keys()
  local out = {}
  for k in pairs(load().games) do out[#out + 1] = k end
  return out
end

return M
