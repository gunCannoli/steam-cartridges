--- Downloaded media kept on disk (ADR-0051): a shortcut's ScreenScraper images, its manual's PDF and the manual's
--- first-page cover, in <data dir>/media_cache/<appid>/<name>, so a Steam restart does not download them again.
--- A game's folder lives as long as the game is opened: `touch` records each page open in opened.json, and `prune(days)`
--- deletes the folder of every game not opened in the last `days` days (0 = keep nothing on disk). The user picks the
--- days (setting "Keep downloaded media", 0-30, default 7); every write and read is gated on it by the caller.
--- File names are media keys, never a URL: ScreenScraper URLs carry the account (ADR-0046). A store stores; it never
--- fetches (ADR-0044).

local fs       = require("fs")
local json     = require("json")
local data_dir = require("data_dir")

local M = {}

M.deps = {} -- test overrides: { dir = "<folder>", now = function() return seconds end }

M.MAX_DAYS = 30
M.DEFAULT_DAYS = 7
--- A page open is written to opened.json at most this often per game (seconds): a page opens many times a day.
M.TOUCH_EVERY = 3600

local DAY = 86400
local INDEX = "opened.json"

local function now() return (M.deps.now or os.time)() end

local function root()
  return M.deps.dir or (data_dir.path() .. "/media_cache")
end

local function ensure_dir(d)
  if not fs.is_directory(d) then fs.create_directories(d) end
  return d
end

local function appid_of(appid)
  local n = math.floor(tonumber(appid) or 0)
  return n > 0 and tostring(n) or nil
end

--- `days` as the setting allows it: a whole number 0..MAX_DAYS; anything else is 0 (nothing on disk).
function M.days(days)
  local n = tonumber(days)
  if not n or n ~= n then return 0 end
  n = math.floor(n)
  if n < 0 then return 0 end
  if n > M.MAX_DAYS then return M.MAX_DAYS end
  return n
end

--- A file name from a media key, reversible so two keys never share a file: [%w-] kept, anything else _xx (hex).
function M.safe_name(name)
  return (tostring(name):gsub("[^%w%-]", function(c) return string.format("_%02x", c:byte()) end))
end

local function read(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local body = f:read("*a")
  f:close()
  return body
end

local function write(path, body)
  local tmp = path .. ".tmp"
  local f = io.open(tmp, "wb")
  if not f then return nil, "could not write" end
  local ok = f:write(body)
  f:close()
  if not ok then pcall(os.remove, tmp) return nil, "could not write" end
  pcall(os.remove, path)
  if not os.rename(tmp, path) then pcall(os.remove, tmp) return nil, "could not rename" end
  return true
end

local index = nil

local function load_index()
  if index then return index end
  index = {}
  local text = read(root() .. "/" .. INDEX)
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then
      for k, v in pairs(data) do
        if type(k) == "string" and type(v) == "number" then index[k] = v end
      end
    end
  end
  return index
end

local function save_index()
  ensure_dir(root())
  return write(root() .. "/" .. INDEX, json.encode(load_index()))
end

function M._reset() index = nil end

--- Record that a game's page opened now (keeps its folder through the next prune). Cheap: writes at most once an hour.
function M.touch(appid)
  local id = appid_of(appid)
  if not id then return false end
  local idx = load_index()
  local t = now()
  if idx[id] and t - idx[id] < M.TOUCH_EVERY then return true end
  idx[id] = t
  return save_index() == true
end

--- The bytes stored as `name` for a game, or nil.
function M.get(appid, name)
  local id = appid_of(appid)
  if not id then return nil end
  local body = read(root() .. "/" .. id .. "/" .. M.safe_name(name))
  return body and #body > 0 and body or nil
end

--- Store `body` as `name` for a game (replacing it), and count it as an open. Returns true, or nil and an error:
--- a disk error only costs a download later.
function M.set(appid, name, body)
  local id = appid_of(appid)
  if not id then return nil, "bad appid" end
  if type(body) ~= "string" or #body == 0 then return nil, "empty" end
  local ok, err = pcall(function()
    local d = ensure_dir(root() .. "/" .. id)
    local done, werr = write(d .. "/" .. M.safe_name(name), body)
    if not done then error(werr) end
  end)
  if not ok then return nil, tostring(err) end
  M.touch(id)
  return true
end

--- Delete the folder of every game not opened in the last `days` days (all of them for 0), and the pre-ADR-0051
--- manual_covers/ folder. Returns { removed = <folders>, kept = <folders> }.
function M.prune(days)
  days = M.days(days)
  local idx = load_index()
  local t = now()
  local removed, kept = 0, 0
  local legacy = data_dir.path() .. "/manual_covers"
  if not M.deps.dir and fs.is_directory(legacy) then pcall(fs.remove_all, legacy) end
  local dir = root()
  if fs.is_directory(dir) then
    for _, entry in ipairs(fs.list(dir) or {}) do
      local id = entry.is_directory and tostring(entry.name):match("^%d+$")
      if id then
        local opened = idx[id]
        if days == 0 or not opened or t - opened > days * DAY then
          pcall(fs.remove_all, dir .. "/" .. id)
          removed = removed + 1
        else
          kept = kept + 1
        end
      end
    end
  end
  -- Forget opens older than the longest window: the index stays small.
  local changed = false
  for id, opened in pairs(idx) do
    if t - opened > M.MAX_DAYS * DAY then idx[id] = nil; changed = true end
  end
  if changed then pcall(save_index) end
  return { removed = removed, kept = kept }
end

return M
