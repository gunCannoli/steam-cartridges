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
  -- Only tables reach the store: it indexes each item, and an index error kills Millennium's host even under pcall.
  local items = {}
  for _, it in ipairs(type(data.items) == "table" and data.items or {}) do
    if type(it) == "table" then items[#items + 1] = it end
  end
  local added = store.seed(items)
  plog(string.format("seed: %d item(s) received, %d added (%s)", #items, added, tostring(items[1] and items[1].source or "-")))
  return { added = added }
end)

--- A user report (2026-11-13, 0.7.3-beta): with steam-non-steam-playtimes installed, the backend host died with an access
--- violation at every start right after this import answered (the frontend's next line, `[settings] saved trackPlaytime`,
--- never came), so `playtimeMigrated` was never saved and the import ran, and crashed, again at every start. Cause not
--- proven. So the import (1) logs each step (counts only: no names, no paths), (2) checks every value's type before it is
--- indexed (an "attempt to index" error kills Millennium's host even under pcall: knowledgebase, crash trap item 4) and
--- drops names that are not valid UTF-8, and (3) leaves a marker file while it runs, which the frontend clears
--- (FinishPlaytimeImport) once the whole migration is saved. A marker found at the next start means the last attempt never
--- finished: the import is skipped, the migration completes without it, and the log says so.
local MARKER = "playtime_import.pending"
M._marker_path = nil -- test override
local function marker_path() return M._marker_path or require("data_dir").file(MARKER) end

--- True when `s` is valid UTF-8 (no overlong form, no surrogate, nothing above U+10FFFF).
local function valid_utf8(s)
  local i, n = 1, #s
  while i <= n do
    local c = s:byte(i)
    local len, min
    if c < 0x80 then len = 1
    elseif c >= 0xC2 and c <= 0xDF then len, min = 2, 0x80
    elseif c >= 0xE0 and c <= 0xEF then len, min = 3, 0x800
    elseif c >= 0xF0 and c <= 0xF4 then len, min = 4, 0x10000
    else return false end
    if len > 1 then
      if i + len - 1 > n then return false end
      local cp = c % (2 ^ (7 - len))
      for j = i + 1, i + len - 1 do
        local b = s:byte(j)
        if b < 0x80 or b > 0xBF then return false end
        cp = cp * 64 + (b - 0x80)
      end
      if cp < min or cp > 0x10FFFF or (cp >= 0xD800 and cp <= 0xDFFF) then return false end
    end
    i = i + len
  end
  return true
end

--- steam-non-steam-playtimes' folder: the plugin whose plugin.json says name = "non-steam-playtimes", under Millennium's
--- plugins folder (found by name, never by a fixed folder spelling). Second value: what was looked at, for the log.
local function nsp_sessions_path()
  local ok, sp = pcall(millennium.steam_path)
  if not ok or type(sp) ~= "string" or sp == "" then return nil, "not looked for (no Steam path)" end
  local plugins = platform.join(sp, "millennium", "plugins")
  local okfs, fs = pcall(require, "fs")
  if not okfs or type(fs) ~= "table" then return nil, "not looked for (no fs module)" end
  local okl, entries = pcall(fs.list, plugins)
  if not okl or type(entries) ~= "table" then return nil, "not looked for (plugins folder not listed)" end
  local folders = 0
  for _, e in ipairs(entries) do
    local name = type(e) == "table" and e.name or nil
    if type(name) == "string" then
      folders = folders + 1
      local manifest = utils.read_file(platform.join(plugins, name, "plugin.json"))
      if type(manifest) == "string" and #manifest > 1 then
        local okj, m = pcall(json.decode, manifest)
        if okj and type(m) == "table" and m.name == "non-steam-playtimes" then
          return platform.join(plugins, name, "sessions.json"), string.format("found among %d plugin folder(s)", folders)
        end
      end
    end
  end
  return nil, string.format("not among %d plugin folder(s)", folders)
end

--- Totals the way steam-non-steam-playtimes computed them (its playtime.lua get_playtime): minutes = the sum of every
--- session (its started_at = 0 entry holds the hand-set and folded time), last played = the newest real session's end.
--- Third value: entries that were not a session table (skipped, counted for the log).
local function nsp_totals(sessions)
  local minutes, last, odd = 0, 0, 0
  for _, s in ipairs(sessions) do
    if type(s) == "table" then
      local a, b = tonumber(s.started_at) or 0, tonumber(s.ended_at) or 0
      if a ~= a or b ~= b or a == math.huge or b == math.huge then a, b = 0, 0 end -- NaN / inf count nothing
      if b > a then minutes = minutes + (b - a) / 60 end
      if a ~= 0 and b > last then last = b end
    else
      odd = odd + 1
    end
  end
  if minutes > 1e9 then minutes = 1e9 end
  return math.floor(minutes + 0.5), math.floor(last), odd
end

local function step(msg) plog("import: " .. msg) end

--- { } -> { found, games = { { name, minutes, last_played } }, skipped? } ; read only, the plugin's file is never changed.
M.ReadOtherPlaytimes = method("ReadOtherPlaytimes", function(_)
  local mpath = marker_path()
  local pending = utils.read_file(mpath)
  if type(pending) == "string" and #pending > 0 then
    local attempts = tonumber(pending:match("%d+")) or 1
    plog(string.format("import: the previous attempt did not finish (%d attempt(s); the plugin most likely stopped during it): import skipped, play time starts from Steam's own counts", attempts))
    pcall(utils.write_file, mpath, tostring(attempts + 1))
    return { found = false, games = {}, skipped = true }
  end
  pcall(utils.write_file, mpath, "1")
  step("start (marker written)")

  local file, where = nsp_sessions_path()
  step("steam-non-steam-playtimes " .. tostring(where))
  local text = file and utils.read_file(file) or nil
  if type(text) ~= "string" or #text < 2 then
    plog("steam-non-steam-playtimes: no sessions file found")
    return { found = false, games = {} }
  end
  step(string.format("sessions file read: %d bytes, valid utf-8=%s", #text, valid_utf8(text) and "yes" or "no"))
  local ok, data = pcall(json.decode, text)
  if not ok or type(data) ~= "table" then
    plog("steam-non-steam-playtimes: sessions file unreadable")
    return { found = false, games = {} }
  end
  step("sessions file decoded")
  local games, names, not_lists, odd, bad_names, long_names = {}, 0, 0, 0, 0, 0
  for name, sessions in pairs(data) do
    names = names + 1
    if type(name) ~= "string" or not valid_utf8(name) then
      bad_names = bad_names + 1
    elseif type(sessions) ~= "table" then
      not_lists = not_lists + 1
    elseif #name > 512 then
      long_names = long_names + 1
    else
      local minutes, last, o = nsp_totals(sessions)
      odd = odd + o
      if minutes > 0 then games[#games + 1] = { name = name, minutes = minutes, last_played = last } end
    end
  end
  step(string.format("walked %d name(s): %d not a session list, %d session entr(ies) not a table, %d name(s) not valid utf-8, %d over 512 bytes (all skipped)",
    names, not_lists, odd, bad_names, long_names))
  plog(string.format("steam-non-steam-playtimes: sessions file found, %d game(s) with playtime", #games))
  -- Encoded once here, under pcall: a value the host could not send becomes a log line, not a dead host.
  local okenc, encoded = pcall(json.encode, { found = true, games = games })
  step(string.format("reply %s (%d bytes); the next line should be the frontend's", okenc and "encoded" or "could NOT be encoded",
    okenc and type(encoded) == "string" and #encoded or 0))
  if not okenc then return { found = false, games = {} } end
  return { found = true, games = games }
end)

--- { } -> { ok } ; the migration is saved: the marker goes.
M.FinishPlaytimeImport = method("FinishPlaytimeImport", function(_)
  local had = type(utils.read_file(marker_path())) == "string"
  pcall(os.remove, marker_path())
  plog("import: finished, marker " .. (had and "cleared" or "was not there"))
  return { ok = true }
end)

M._nsp_totals = nsp_totals
M._valid_utf8 = valid_utf8

return M
