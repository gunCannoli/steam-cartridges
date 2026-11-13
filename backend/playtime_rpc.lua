--- Playtime of non-Steam games (2026-11-12; playtime_store.lua holds it). The frontend records sessions (a checkpoint while a
--- game runs, then the quit), sets a total by hand (Properties > Cartridge), and on its first run imports what the
--- steam-non-steam-playtimes plugin recorded (its sessions.json, keyed by game name: the frontend maps names to appids).
local core       = require("rpc")
local store      = require("playtime_store")
local platform   = require("platform")
local json       = require("json")
local utils      = require("utils")
local millennium = require("millennium")

local method = core.method
local M = {}

local function plog(msg)
  pcall(function() require("plog").event("playtime", msg) end)
end

local function need(data, field)
  if data[field] == nil then error("missing " .. field) end
  return data[field]
end

--- { } -> { games = { ["<appid>"] = { minutes, two_weeks, last_played, source } } }
M.GetPlaytimes = method("GetPlaytimes", function(_)
  return { games = store.all() }
end)

--- { appid, started, ended } -> { playtime } ; the same `started` again updates that session.
M.RecordPlaySession = method("RecordPlaySession", function(data)
  local view, err = store.session(need(data, "appid"), need(data, "started"), need(data, "ended"))
  if not view then return { error = err } end
  return { playtime = view }
end)

--- { appid, minutes } -> { playtime }
M.SetPlaytime = method("SetPlaytime", function(data)
  local view = store.set_minutes(need(data, "appid"), need(data, "minutes"))
  plog("total set by hand for one game")
  return { playtime = view }
end)

--- { items = { { appid, minutes, last_played, source } } } -> { added }
M.SeedPlaytimes = method("SeedPlaytimes", function(data)
  local items = type(data.items) == "table" and data.items or {}
  local added = store.seed(items)
  if added > 0 then plog(string.format("seeded %d game(s) (%s)", added, tostring(items[1] and items[1].source or "?"))) end
  return { added = added }
end)

--- steam-non-steam-playtimes' folder: the plugin whose plugin.json says name = "non-steam-playtimes", under Millennium's
--- plugins folder (found by name, never by a fixed folder spelling).
local function nsp_sessions_path()
  local ok, sp = pcall(millennium.steam_path)
  if not ok or not sp or sp == "" then return nil end
  local plugins = platform.join(sp, "millennium", "plugins")
  local okfs, fs = pcall(require, "fs")
  if not okfs then return nil end
  local okl, entries = pcall(fs.list, plugins)
  if not okl or type(entries) ~= "table" then return nil end
  for _, e in ipairs(entries) do
    local name = type(e) == "table" and e.name or nil
    if type(name) == "string" then
      local manifest = utils.read_file(platform.join(plugins, name, "plugin.json"))
      if manifest and #manifest > 1 then
        local okj, m = pcall(json.decode, manifest)
        if okj and type(m) == "table" and m.name == "non-steam-playtimes" then
          return platform.join(plugins, name, "sessions.json")
        end
      end
    end
  end
  return nil
end

--- Totals the way steam-non-steam-playtimes computed them (its playtime.lua get_playtime): minutes = the sum of every
--- session (its started_at = 0 entry holds the hand-set and folded time), last played = the newest real session's end.
local function nsp_totals(sessions)
  local minutes, last = 0, 0
  for _, s in ipairs(sessions) do
    local a, b = tonumber(s.started_at) or 0, tonumber(s.ended_at) or 0
    if b > a then minutes = minutes + (b - a) / 60 end
    if a ~= 0 and b > last then last = b end
  end
  return math.floor(minutes + 0.5), last
end

--- { } -> { found, games = { { name, minutes, last_played } } } ; read only, the plugin's file is never changed.
M.ReadOtherPlaytimes = method("ReadOtherPlaytimes", function(_)
  local file = nsp_sessions_path()
  local text = file and utils.read_file(file) or nil
  if not text or #text < 2 then
    plog("steam-non-steam-playtimes: no sessions file found")
    return { found = false, games = {} }
  end
  local ok, data = pcall(json.decode, text)
  if not ok or type(data) ~= "table" then
    plog("steam-non-steam-playtimes: sessions file unreadable")
    return { found = false, games = {} }
  end
  local games = {}
  for name, sessions in pairs(data) do
    if type(name) == "string" and type(sessions) == "table" then
      local minutes, last = nsp_totals(sessions)
      if minutes > 0 then games[#games + 1] = { name = name, minutes = minutes, last_played = last } end
    end
  end
  plog(string.format("steam-non-steam-playtimes: sessions file found, %d game(s) with playtime", #games))
  return { found = true, games = games }
end)

M._nsp_totals = nsp_totals

return M
