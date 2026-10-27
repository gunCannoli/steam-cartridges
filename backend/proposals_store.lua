--- What Library Setup's Detect found for each game, kept beside the live links, never as them (ADR-0086, plan Q8): a Yes
--- makes it the game's link (library_service.validate), a No drops it and remembers the rejection, so Detect and Refresh
--- never propose the same game again.
---
--- <data dir>/proposals.json:
---   { [appid] = { proposal = { title, platform, year, steam_appid, steam_name, steam_kind, igdb_id, igdb_name,
---                              ra_game_id, ra_title, signals } | false,
---                 rejected = { ["steam:<id>"] = true, ["igdb:<id>"] = true, ["ra:<id>"] = true },
---                 at = unix s } }
--- `proposal = false`: Detect ran and found nothing to propose (a manual link).
---
--- A store: disk only, never the network.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "proposals.json"
M._path = nil -- test override

local state = nil

local function path() return M._path or data_dir.file(FILE) end
local function key(appid) return tostring(math.floor(tonumber(appid) or 0)) end

function M._reset() state = nil end

local function load()
  if state then return state end
  state = {}
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then state = data end
  end
  return state
end

local function save()
  return utils.write_file(path(), json.encode(load()))
end

local function entry(appid)
  local s, k = load(), key(appid)
  if type(s[k]) ~= "table" then s[k] = { rejected = {} } end
  if type(s[k].rejected) ~= "table" then s[k].rejected = {} end
  return s[k]
end

--- The stored proposal: a table, false (Detect found nothing), or nil (Detect has not run for it).
function M.proposal(appid)
  local e = load()[key(appid)]
  if type(e) ~= "table" then return nil end
  return e.proposal
end

function M.set_proposal(appid, proposal, now)
  local e = entry(appid)
  e.proposal = proposal or false
  e.at = now or os.time()
  return save()
end

--- "steam:<id>", "igdb:<id>", "ra:<id>"
function M.reject(appid, what)
  entry(appid).rejected[what] = true
  return save()
end

function M.is_rejected(appid, what)
  local e = load()[key(appid)]
  return type(e) == "table" and type(e.rejected) == "table" and e.rejected[what] == true
end

--- Drop the proposal, keep the rejections (after a Yes, or a No).
function M.clear_proposal(appid)
  local e = load()[key(appid)]
  if type(e) == "table" then e.proposal = nil; save() end
end

--- Every appid with a proposal or a rejection (prune_removed).
function M.keys()
  local out = {}
  for k in pairs(load()) do out[#out + 1] = k end
  return out
end

function M.forget(appid)
  load()[key(appid)] = nil
  return save()
end

return M
