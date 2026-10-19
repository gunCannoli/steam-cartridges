--- RetroAchievements lookups kept across Steam starts (ADR-0060): a ROM's hash by its file, and a hash's GameID.
---
--- Hashing a ROM (rom_hash.lua, up to a few seconds for a large zip) and the GameID is a network call; both used to be
--- remembered in memory only, so every Steam start paid them again for every RetroAchievements game, while the
--- backend (one call at a time) held every other call.
---
--- <data dir>/ra_cache.json:
---   { version = 1,
---     hashes = { [rom path] = { size = n, mtime = n, md5 = "..." } },   -- valid while the file's size and mtime match
---     games  = { [md5] = { id = n | false, at = unix s } } }            -- false = RetroAchievements has no game for
---                                                                          it; asked again after MISS_TTL
--- A network failure is never stored: only a definite answer is.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

M.MISS_TTL = 7 * 24 * 3600

local FILE = "ra_cache.json"
M._path = nil -- test override
--- Injectable for tests. nil = the real dependency.
M.deps = {
  stat = nil, -- fun(path) -> size, mtime | nil ; nil = fs.file_size / fs.last_write_time
  now = function() return os.time() end,
}

local state = nil

local function path() return M._path or data_dir.file(FILE) end

function M._reset() state = nil end

local function load()
  if state then return state end
  state = { version = 1, hashes = {}, games = {} }
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then
      if type(data.hashes) == "table" then state.hashes = data.hashes end
      if type(data.games) == "table" then state.games = data.games end
    end
  end
  return state
end

local function save()
  local tmp = path() .. ".tmp"
  local body = json.encode(load())
  local ok = utils.write_file(tmp, body)
  if not ok then return false end
  pcall(os.remove, path())
  if not os.rename(tmp, path()) then
    utils.write_file(path(), body)
    pcall(os.remove, tmp)
  end
  return true
end

--- The file's size and mtime, or nil when either cannot be read (then nothing is cached for it).
local function stat(rom_path)
  if M.deps.stat then return M.deps.stat(rom_path) end
  local ok, size, mtime = pcall(function()
    local fs = require("fs")
    return fs.file_size(rom_path), fs.last_write_time(rom_path)
  end)
  if not ok or type(size) ~= "number" or type(mtime) ~= "number" then return nil end
  return size, mtime
end

--- The stored hash of this ROM while the file is unchanged, else nil.
function M.md5_for(rom_path)
  if type(rom_path) ~= "string" then return nil end
  local size, mtime = stat(rom_path)
  if not size then return nil end
  local entry = load().hashes[rom_path]
  if type(entry) == "table" and entry.size == size and entry.mtime == mtime and type(entry.md5) == "string" then
    return entry.md5
  end
  return nil
end

--- Remember a ROM's hash (keyed by the file's current size and mtime). Bookkeeping only: never fails the caller.
function M.put_md5(rom_path, md5)
  if type(rom_path) ~= "string" or type(md5) ~= "string" or #md5 == 0 then return end
  local size, mtime = stat(rom_path)
  if not size then return end
  load().hashes[rom_path] = { size = size, mtime = mtime, md5 = md5 }
  pcall(save)
end

--- What RetroAchievements answered for this hash: `true, id` (a game), `true, nil` (no game, within MISS_TTL),
--- or `false` (not asked yet, or the miss came due).
function M.game_for(md5)
  if type(md5) ~= "string" then return false end
  local entry = load().games[md5]
  if type(entry) ~= "table" then return false end
  if type(entry.id) == "number" and entry.id > 0 then return true, entry.id end
  if entry.id == false and (M.deps.now() - (tonumber(entry.at) or 0)) < M.MISS_TTL then return true, nil end
  return false
end

--- Remember a definite answer: a GameID, or nil for "RetroAchievements has no game for this hash".
function M.put_game(md5, id)
  if type(md5) ~= "string" or #md5 == 0 then return end
  local n = tonumber(id)
  load().games[md5] = { id = (n and n > 0) and n or false, at = M.deps.now() }
  pcall(save)
end

return M
