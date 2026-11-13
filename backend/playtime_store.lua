--- How long each non-Steam game was played (2026-11-12; the steam-non-steam-playtimes plugin's job, taken over):
--- <data dir>/playtime.json, its own file so a metadata refresh, a revert or a re-scrape can never touch it. The frontend
--- gets each game's entry as `metadata.playtime` and shows it in Steam's own Play Time and Last Played stats.
---
--- { version = 1, games = { ["<shortcut appid>"] = { base = minutes, sessions = { { s, e }, ... }, last = unix, source } } }
---   base      minutes not held as sessions: imported, set by hand, seeded from Steam's own count, or sessions folded in
---   sessions  recent sessions (unix seconds), kept 14 days for "last two weeks", then folded into base
---   last      the end of the newest session (0: never seen played)
---   source    "tracked" | "manual" | "imported" | "steam" (how base was first set)
--- Loaded lazily on the first call, never in on_load (knowledgebase: a decode error raised there kills the Lua host).

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "playtime.json"
local TWO_WEEKS = 14 * 24 * 60 * 60
local state = nil
M._path = nil -- test override
M._now = nil  -- test override: fun() -> unix seconds

local function now() return M._now and M._now() or os.time() end
local function path() return M._path or data_dir.file(FILE) end

local function load()
  if state then return state end
  state = { version = 1, games = {} }
  local text = utils.read_file(path())
  if text and #text > 1 then
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

--- Fold sessions older than two weeks into base (the newest one always stays, it carries `last`).
local function fold(g)
  local cut = now() - TWO_WEEKS
  local keep, newest = {}, nil
  for _, s in ipairs(g.sessions or {}) do
    if not newest or (s[2] or 0) > (newest[2] or 0) then newest = s end
  end
  for _, s in ipairs(g.sessions or {}) do
    if (s[2] or 0) >= cut or s == newest then keep[#keep + 1] = s
    else g.base = (g.base or 0) + math.max(0, (s[2] or 0) - (s[1] or 0)) / 60 end
  end
  g.sessions = keep
end

--- A game's entry as the frontend reads it: { minutes, two_weeks, last_played, source }, or nil.
local function view(g)
  if type(g) ~= "table" then return nil end
  local cut = now() - TWO_WEEKS
  local minutes, two = g.base or 0, 0
  for _, s in ipairs(g.sessions or {}) do
    local m = math.max(0, (s[2] or 0) - (s[1] or 0)) / 60
    minutes = minutes + m
    if (s[1] or 0) >= cut then two = two + m end
  end
  return { minutes = math.floor(minutes + 0.5), two_weeks = math.floor(two + 0.5), last_played = g.last or 0, source = g.source }
end
M.view = view

--- Every game's entry, keyed by appid (string).
function M.all()
  local out = {}
  for k, g in pairs(load().games) do out[k] = view(g) end
  return out
end

function M.get(appid) return view(load().games[key(appid)]) end

--- Record a session: the same `started` again updates its end (a periodic checkpoint while the game runs, then the quit).
function M.session(appid, started, ended)
  started, ended = math.floor(tonumber(started) or 0), math.floor(tonumber(ended) or 0)
  if started <= 0 or ended < started then return nil, "bad session" end
  local s = load()
  local k = key(appid)
  local g = s.games[k] or { base = 0, sessions = {}, last = 0, source = "tracked" }
  s.games[k] = g
  g.sessions = g.sessions or {}
  local found = false
  for _, x in ipairs(g.sessions) do
    if x[1] == started then x[2] = math.max(x[2] or 0, ended); found = true end
  end
  if not found then g.sessions[#g.sessions + 1] = { started, ended } end
  g.last = math.max(g.last or 0, ended)
  fold(g)
  save()
  return view(g)
end

--- Set the total by hand (Properties > Cartridge). Recent sessions stay when they fit under the new total (so "last two
--- weeks" stays true); otherwise the total becomes base alone, as steam-non-steam-playtimes did.
function M.set_minutes(appid, minutes)
  minutes = math.max(0, math.floor(tonumber(minutes) or 0))
  local s = load()
  local k = key(appid)
  local g = s.games[k] or { base = 0, sessions = {}, last = 0 }
  local held = 0
  for _, x in ipairs(g.sessions or {}) do held = held + math.max(0, (x[2] or 0) - (x[1] or 0)) / 60 end
  if minutes >= held then g.base = minutes - held else g.base, g.sessions = minutes, {} end
  g.source = "manual"
  s.games[k] = g
  save()
  return view(g)
end

--- Seed games we have nothing for (imported from steam-non-steam-playtimes, or Steam's own count): { { appid, minutes,
--- last_played, source } }. A game we already track is left alone. Returns how many were added.
function M.seed(items)
  local s = load()
  local added = 0
  for _, it in ipairs(items or {}) do
    local k = key(it.appid)
    local m = tonumber(it.minutes) or 0
    if k ~= "0" and s.games[k] == nil and m > 0 then
      s.games[k] = { base = m, sessions = {}, last = math.floor(tonumber(it.last_played) or 0), source = it.source or "imported" }
      added = added + 1
    end
  end
  if added > 0 then save() end
  return added
end

return M
