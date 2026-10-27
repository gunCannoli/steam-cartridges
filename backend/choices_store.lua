--- What the user answered for each game in Library Setup (ADR-0086, plan decision 7): the game is validated, skipped,
--- or was already in the library before setup existed. The answer is final: no refresh changes it.
---
--- <data dir>/game_choices.json:
---   { [appid] = { kind = "validated" | "existing" | "skipped", platform = id | nil, steam_appid = n | nil,
---                 igdb_id = n | nil, ss_id = n | nil, ra_game_id = n | nil, achievements = source | "none" | nil,
---                 at = unix s } }
--- "existing": a game that had data before Library Setup (repair 3); fetched as before. "skipped": never fetched.
---
--- A store: disk only, never the network.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "game_choices.json"
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

--- The choice of one game, or nil (not answered yet).
function M.get(appid)
  local c = load()[key(appid)]
  return type(c) == "table" and c or nil
end

function M.set(appid, choice, now)
  choice.at = choice.at or now or os.time()
  load()[key(appid)] = choice
  return save()
end

function M.forget(appid)
  load()[key(appid)] = nil
  return save()
end

--- May the plugin fetch for this game on its own? A validated or an existing game, never a skipped or unanswered one.
function M.may_fetch(appid)
  local c = M.get(appid)
  return c ~= nil and (c.kind == "validated" or c.kind == "existing")
end

--- Mark many games "existing" at once (repair 3); a game already answered keeps its answer. Returns how many changed.
function M.mark_existing(appids, now)
  local s, n = load(), 0
  for _, appid in ipairs(appids) do
    local k = key(appid)
    if s[k] == nil then
      s[k] = { kind = "existing", at = now or os.time() }
      n = n + 1
    end
  end
  if n > 0 then save() end
  return n
end

--- Every choice, keyed by appid string.
function M.all()
  return load()
end

return M
