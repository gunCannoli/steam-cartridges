--- steam-cartridges - resetting a shortcut's achievements, and the files they come back from (ADR-0054).
---
--- A reset always clears the plugin's own unlocks (achievements_store) and marks the game's logs as
--- read, so lines written before the reset never unlock again. On request it also clears the
--- files the observer reads the unlocks back from, each backed up first:
---   rpcs3      RPCS3's TROPUSR.DAT
---   shadps4    shadPS4's trophy XML save files
--- RetroAchievements unlocks live on the user's account; its API cannot reset them, so the source
--- is listed with `resettable = false` and a note.

local logger   = require("logger")
local utils    = require("utils")
local store    = require("achievements_store")
local observer = require("achievements_observer")
local files    = require("achievement_files")

local M = {}

--- RPCS3 / shadPS4 files are only listed, not reset (ADR-0066): writing TROPUSR.DAT and the trophy XML was never run on a
--- real emulator's files. Turn on once someone with a PS3 / PS4 game has checked that the emulator still loads the file
--- and shows the trophies locked (release plan D5). Tests turn it on to keep the write path covered.
M.TROPHY_RESET = false
local TROPHY_NOTE = "Not reset from here yet: reset the trophies in the emulator."

--- Injectable for tests. nil = the real dependency.
M.deps = {
  read = nil,   -- fun(path) -> string | nil
  write = nil,  -- fun(path, content) -> ok, err
  now = nil,    -- fun() -> unix seconds
  entry = nil,  -- fun(appid) -> sc, exe_dir
}

local function read(p)
  if M.deps.read then return M.deps.read(p) end
  local f = io.open(p, "rb")
  if not f then return nil end
  local c = f:read("*a")
  f:close()
  return c
end

local function write(p, c)
  if M.deps.write then return M.deps.write(p, c) end
  return utils.write_file(p, c)
end

local function now() return (M.deps.now or os.time)() end

local function count(t)
  local n = 0
  for _ in pairs(t or {}) do n = n + 1 end
  return n
end

--- Each place this shortcut's unlocks come from besides the plugin's own store.
--- Returns { sources = { { id, label, resettable, unlocked, files = { paths }, note } } }.
function M.sources(shortcut_appid, _native_appid)
  local s_appid = tonumber(shortcut_appid) or 0
  local st = store.get_state(s_appid) or {}
  local schema = st.schema or {}
  local out = {}

  -- RPCS3 / shadPS4 trophy files.
  if schema.ps3_title_id or schema.ps4_title_id then
    local sc, exe_dir
    if M.deps.entry then sc, exe_dir = M.deps.entry(s_appid) else sc, exe_dir = observer.shortcut_entry(s_appid) end
    local on = M.TROPHY_RESET == true
    local ps3 = { id = "rpcs3", label = "RPCS3 achievements", resettable = on, unlocked = 0, files = {},
      note = not on and TROPHY_NOTE or nil }
    local ps4 = { id = "shadps4", label = "shadPS4 achievements", resettable = on, unlocked = 0, files = {},
      note = on and "shadNet may sync them back from your shadNet account." or TROPHY_NOTE }
    for _, p in ipairs(observer.trophy_files(schema, sc, exe_dir)) do
      local data = read(p) or ""
      local is_dat = p:match("%.[Dd][Aa][Tt]$") ~= nil
      local src = is_dat and ps3 or ps4
      src.files[#src.files + 1] = p
      -- Each trophy is in the map twice ("1" and "001"): count the three-digit form only.
      for id in pairs(is_dat and files.rpcs3_unlocked(data) or files.shadps4_unlocked(data)) do
        if #id >= 3 then src.unlocked = src.unlocked + 1 end
      end
    end
    if #ps3.files > 0 then out[#out + 1] = ps3 end
    if #ps4.files > 0 then out[#out + 1] = ps4 end
  end

  -- RetroAchievements: on the user's account, not resettable from here.
  local ra_id = math.floor(tonumber(schema.ra_game_id) or 0)
  if ra_id > 0 then
    out[#out + 1] = { id = "retroachievements", label = "RetroAchievements", resettable = false,
      unlocked = count(st.unlocks), files = {},
      -- The game's page: its "Manage progress" button resets the user's progress (RAWeb MasteredProgressIndicator).
      url = "https://retroachievements.org/game/" .. tostring(ra_id),
      note = "They stay on your RetroAchievements account and come back the next time they sync. Reset them on the game's page with Manage progress." }
  end

  return { sources = out }
end

local function backup_path(p)
  return p .. ".bak-" .. os.date("%Y%m%d-%H%M%S", now())
end

--- Clears one file's unlocks after copying it to a backup. Returns cleared count, or nil and why.
local function clear_file(source_id, p)
  local content = read(p)
  if not content then return nil, "cannot read " .. p end
  local next_content, cleared, why
  if source_id == "rpcs3" then
    next_content, cleared, why = files.rpcs3_lock_all(content)
  elseif source_id == "shadps4" then
    next_content, cleared = files.shadps4_lock_all(content)
  end
  if not next_content then return nil, why or "unsupported file" end
  if cleared == 0 then return 0 end
  local ok, err = write(backup_path(p), content)
  if not ok then return nil, "could not back up " .. p .. ": " .. tostring(err) end
  ok, err = write(p, next_content)
  if not ok then return nil, "could not write " .. p .. ": " .. tostring(err) end
  return cleared
end

--- Resets the shortcut: the chosen sources' files (ids from M.sources), then the plugin's own
--- unlocks, and marks its logs read. A file that fails is reported and the rest go on.
--- Returns { ok, sources = { { id, ok, cleared, error } } }.
function M.reset(shortcut_appid, native_appid, chosen, game_title)
  local s_appid = tonumber(shortcut_appid) or 0
  local want = {}
  for _, id in ipairs(chosen or {}) do want[id] = true end
  local results, all_ok = {}, true
  for _, src in ipairs(M.sources(s_appid, native_appid).sources) do
    if want[src.id] and src.resettable then
      local r = { id = src.id, ok = true, cleared = 0 }
      for _, p in ipairs(src.files) do
        local n, err = clear_file(src.id, p)
        if n then
          r.cleared = r.cleared + n
        else
          r.ok, r.error, all_ok = false, err, false
          logger:warn("Reset achievements: " .. tostring(err))
        end
      end
      results[#results + 1] = r
    end
  end
  local ok_logs, err_logs = pcall(observer.mark_logs_read, s_appid, game_title)
  if not ok_logs then logger:warn("Reset achievements: could not mark logs read: " .. tostring(err_logs)) end
  store.reset(s_appid)
  logger:info(string.format("Reset achievements for shortcut %d (%d file source(s))", s_appid, #results))
  return { ok = all_ok, sources = results }
end

return M
