--- steam-cartridges - In-game achievement observer (Phase 5).
---
--- Detects unlocks out-of-process from console emulators: their logs (RetroArch, DuckStation, PCSX2,
--- Dolphin, PPSSPP, RPCS3, shadPS4) and RPCS3 / shadPS4 trophy files. Steam API emulator saves and
--- PC-game engine logs belong to the steam-cartridges-local extension (ADR-0063).
---
--- Matches observed tokens against the mirrored Steam schema (achievements_store)
--- and registers new unlocks without requiring third-party storefront APIs or DLL injection.

local json   = require("json")
local logger = require("logger")
local store  = require("achievements_store")

local M = {}

local files  = require("achievement_files")

--- How far each log has been read (byte offset by path), kept on disk so a Steam restart does
--- not read a whole log again and bring back unlocks a reset cleared (ADR-0054). Loaded on first
--- use; written only when it changed. M._offsets_path overrides the file (tests).
local log_offsets = nil
local offsets_dirty = false
M._offsets_path = nil

local function offsets_path()
  return M._offsets_path or require("data_dir").file("log_offsets.json")
end

local function load_offsets()
  if log_offsets then return end
  log_offsets = {}
  local f = io.open(offsets_path(), "rb")
  if not f then return end
  local ok, data = pcall(json.decode, f:read("*a") or "")
  f:close()
  if ok and type(data) == "table" then
    for k, v in pairs(data) do
      if type(k) == "string" and tonumber(v) then log_offsets[k] = tonumber(v) end
    end
  end
end

local function save_offsets()
  if not offsets_dirty then return end
  offsets_dirty = false
  local f = io.open(offsets_path(), "wb")
  if not f then return end
  f:write(json.encode(log_offsets or {}))
  f:close()
end

--- Tests: forget the offsets held in memory.
function M._reset_offsets() log_offsets, offsets_dirty = nil, false end

--- Shortcuts whose sources were asked this session because no schema was stored (ADR-0060): a poll runs every 2 s,
--- and asking the sources (RetroAchievements: a ROM hash and network) on each one held the backend for every other call.
local resolved_once = {}
function M._reset_resolved() resolved_once = {} end

local function normalize(s)
  return tostring(s or ""):lower():gsub("[^%w]", "")
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  return content
end

local function file_exists(path)
  local f = io.open(path, "rb")
  if f then
    f:close()
    return true
  end
  return false
end

--- Tails an engine log file incrementally from the last known byte offset.
function M.scan_log_for_unlocks(filepath)
  local f = io.open(filepath, "rb")
  if not f then return {} end

  load_offsets()
  local current_size = f:seek("end")
  local last_offset = log_offsets[filepath] or 0

  if current_size < last_offset then
    -- File was truncated or rotated
    last_offset = 0
  end

  f:seek("set", last_offset)
  local new_bytes = f:read("*a")
  local read_to = f:seek()
  if log_offsets[filepath] ~= read_to then
    log_offsets[filepath] = read_to
    offsets_dirty = true
  end
  f:close()

  if not new_bytes or #new_bytes == 0 then
    return {}
  end

  local detected = {}
  for line in new_bytes:gmatch("[^\r\n]+") do
    -- Achievement trigger patterns of console emulators: RetroArch / DuckStation / PCSX2 / Dolphin / PPSSPP / RPCS3 / shadPS4
    -- rcheevos' client (RetroArch 1.17+): "Awarding achievement 4615: <title>", then "Achievement 4615 awarded, new score: 7"
    local ach = line:match("%[RCHEEVOS%]%s*Awarding achievement%s*(%d+)")
             or line:match("%[RCHEEVOS%]%s*Achievement%s*(%d+)%s*awarded")
             or line:match("%[RCHEEVOS%]%s*Awarded achievement%s*(%d+)")
             or line:match("%[CHEEVOS%]%s*Awarded achievement%s*(%d+)")
             or line:match("[aA]warded achievement%s*(%d+)")
             or line:match("%[Achievements%]%s*Unlocked%s*(%d+)")
             or line:match("%[Achievements%]%s*Awarded%s*(%d+)")
             or line:match("[aA]chievement%s*(%d+)%s*unlocked")
             or line:match("[tT]rophy [uU]nlocked:%s*[%w_]+%s*%[(%d+)%]")
             or line:match("%{Emu%.Trophy%}%s*[tT]rophy%s*[uU]nlocked:%s*[%w_]+%s*%[(%d+)%]")
             or line:match("[tT]rophy [uU]nlocked:%s*([%w_%-]+)")
             or line:match("[tT]rophy%s*(%d+)%s*[uU]nlocked")
    if ach and #ach > 0 then
      detected[ach] = { unlocked_time = os.time() }
    end
  end

  return detected
end

--- Resolves a raw token (ID or display name) to a canonical schema achievement item.
function M.resolve_canonical_item(token, schema_achievements)
  if not token or not schema_achievements then return nil end
  local str_token = tostring(token)
  local token_norm = normalize(str_token)

  -- 1. Exact ID
  for _, item in ipairs(schema_achievements) do
    if item.id == str_token then return item end
  end

  -- 2. Case-insensitive ID
  for _, item in ipairs(schema_achievements) do
    if item.id:lower() == str_token:lower() then return item end
  end

  -- 3. Exact Name
  for _, item in ipairs(schema_achievements) do
    if item.name:lower() == str_token:lower() then return item end
  end

  -- 4. Normalized match (alphanumeric only)
  for _, item in ipairs(schema_achievements) do
    if normalize(item.name) == token_norm or normalize(item.id) == token_norm then
      return item
    end
  end

  return nil
end

--- Scans the console-emulator logs and trophy files of a running game.
--- Updates achievements_store and returns newly unlocked items.
--- K1: Millennium's cjson encodes an empty Lua table as `{}`; mark lists as arrays when it can.
local function as_array(list)
  local ok, cjson = pcall(require, "cjson")
  if ok and type(cjson) == "table" and cjson.array_mt then setmetatable(list, cjson.array_mt) end
  return list
end

-- ---------- where a shortcut's unlocks can come from (shared with achievements_reset.lua) ----------

--- The shortcut's shortcuts.vdf entry and its executable's folder ("" when unknown).
function M.shortcut_entry(s_appid)
  local paths = require("steam_paths").resolve()
  if not (paths and paths.shortcuts) then return nil, "" end
  for _, sc in ipairs(require("shortcuts").parse(paths.shortcuts) or {}) do
    if sc.appid == s_appid and sc.exe then
      local s = tostring(sc.exe):gsub('^"(.*)"$', "%1"):gsub("\\", "/")
      return sc, (s:match("^(.*)/[^/]+$") or "")
    end
  end
  return nil, ""
end

--- The trophy files holding the unlocks of an RPCS3 or shadPS4 shortcut that exist: RPCS3's
--- TROPUSR.DAT, or shadPS4's trophy XML (its per-user save file, or the older in-folder TROP*.XML).
function M.trophy_files(schema, sc_match, exe_dir)
  local out = {}
  local cmd, opts = sc_match and sc_match.exe or exe_dir, sc_match and sc_match.launch_options
  if schema and schema.ps3_title_id then
    local dir = require("ps3_trophies").find_trophy_dir(cmd, opts)
    if dir and file_exists(dir .. "/TROPUSR.DAT") then out[#out + 1] = dir .. "/TROPUSR.DAT" end
  end
  if schema and schema.ps4_title_id then
    local ps4 = require("ps4_trophies")
    for _, p in ipairs(ps4.find_save_files(ps4.find_trophy_dir(cmd, opts), schema.ps4_npcommid) or {}) do
      out[#out + 1] = p
    end
  end
  return out
end

--- The newest RetroArch log in `dir`: with log_to_file_timestamp on, RetroArch writes one
--- "retroarch__YYYY_MM_DD__HH_MM_SS.log" per run and never "retroarch.log". The names sort by time.
function M.newest_retroarch_log(dir)
  local fs_ok, fs = pcall(require, "fs")
  if not (fs_ok and fs and fs.list and fs.is_directory) or not dir or #dir == 0 or not fs.is_directory(dir) then return nil end
  local ok, entries = pcall(fs.list, dir)
  local newest
  for _, entry in ipairs(ok and entries or {}) do
    local name = tostring(entry.name or entry.path or ""):match("([^/\\]+)$") or ""
    if name:match("^retroarch__%d+_%d+_%d+__%d+_%d+_%d+%.log$") and (not newest or name > newest) then newest = name end
  end
  return newest and (dir .. "/" .. newest) or nil
end

--- RetroArch's log folders: next to the executable, the defaults, and log_dir from retroarch.cfg (":\" expanded)
--- when the shortcut runs RetroArch.
local function retroarch_log_dirs(exe_dir, sc_match)
  local dirs = { (os.getenv("APPDATA") or "") .. "/RetroArch/logs" }
  if #exe_dir > 0 then dirs[#dirs + 1] = exe_dir .. "/logs" end
  if sc_match and tostring(sc_match.exe or ""):lower():find("retroarch", 1, true) then
    local ok, conf = pcall(function() return require("retroachievements").get_retroarch_config(exe_dir) end)
    if ok and type(conf) == "table" and conf.log_dir then dirs[#dirs + 1] = conf.log_dir end
  end
  return dirs
end

--- Every console-emulator log that may hold this game's unlocks and exists: next to the executable
--- and in known install folders. Engine logs are steam-cartridges-local's (ADR-0063).
function M.log_paths(game_title, sc_match, exe_dir)
  local appdata = os.getenv("APPDATA") or ""
  local localappdata = os.getenv("LOCALAPPDATA") or ""
  local userprofile = os.getenv("USERPROFILE") or ""
  local out, seen = {}, {}
  local function add(p)
    if p and not seen[p] and file_exists(p) then
      seen[p] = true
      out[#out + 1] = p
    end
  end
  exe_dir = exe_dir or ""
  if #exe_dir > 0 then
    for _, rel in ipairs({ "/duckstation.log", "/logs/duckstation.log", "/logs/retroarch.log", "/User/Logs/dolphin.log",
        "/Logs/dolphin.log", "/logs/emulog.txt", "/emulog.txt", "/ppsspp.log", "/RPCS3.log", "/rpcs3.log",
        "/user/log/shadps4.log", "/shadps4.log" }) do
      add(exe_dir .. rel)
    end
  end
  for _, p in ipairs({
    appdata .. "\\RetroArch\\logs\\retroarch.log",
    userprofile .. "\\Documents\\DuckStation\\duckstation.log",
    appdata .. "\\duckstation\\duckstation.log",
    localappdata .. "\\duckstation\\duckstation.log",
    userprofile .. "\\Documents\\PCSX2\\logs\\emulog.txt",
    appdata .. "\\PCSX2\\logs\\emulog.txt",
    localappdata .. "\\PCSX2\\logs\\emulog.txt",
    userprofile .. "\\Documents\\Dolphin Emulator\\Logs\\dolphin.log",
    appdata .. "\\Dolphin Emulator\\Logs\\dolphin.log",
    appdata .. "\\PPSSPP\\PSP\\SYSTEM\\ppsspp.log",
    appdata .. "\\rpcs3\\RPCS3.log",
    localappdata .. "\\rpcs3\\RPCS3.log",
    appdata .. "\\shadps4\\user\\log\\shadps4.log",
    localappdata .. "\\shadps4\\user\\log\\shadps4.log",
  }) do
    add(p)
  end
  -- One spelling per folder (slashes, case), so the same log is not read twice under two names.
  local seen_dir = {}
  for _, d in ipairs(retroarch_log_dirs(exe_dir, sc_match)) do
    local key = d:gsub("\\", "/"):gsub("/+$", ""):lower()
    if not seen_dir[key] then
      seen_dir[key] = true
      add(M.newest_retroarch_log((d:gsub("\\", "/"):gsub("/+$", ""))))
    end
  end

  return out
end

--- Marks every log of this shortcut as read up to its current end, so lines written before a
--- reset never unlock again (ADR-0054). Saved at once.
function M.mark_logs_read(s_appid, game_title)
  local sc_match, exe_dir = M.shortcut_entry(tonumber(s_appid) or 0)
  load_offsets()
  for _, p in ipairs(M.log_paths(game_title, sc_match, exe_dir)) do
    local f = io.open(p, "rb")
    if f then
      log_offsets[p] = f:seek("end")
      offsets_dirty = true
      f:close()
    end
  end
  save_offsets()
end

function M.check_unlocks(shortcut_appid, native_appid, game_title)
  local s_appid = tonumber(shortcut_appid) or 0
  local n_appid = tonumber(native_appid) or 0
  if s_appid <= 0 then
    return { new_unlocks = as_array({}) }
  end

  local st = store.get_state(s_appid)
  if (not st or not st.schema or not st.schema.achievements) and not resolved_once[s_appid] then
    -- One resolver for every source, so a PC game with no trophy dir or ROM path stays silent (K2). Once per
    -- session: the quit reload asks again (ADR-0060).
    resolved_once[s_appid] = true
    local _, raw = require("ach_service")._resolve(s_appid, { native = n_appid })
    st = raw
  end
  if not st or not st.schema or not st.schema.achievements then
    return { new_unlocks = as_array({}) }
  end

  local schema_achievements = st.schema.achievements
  local existing_unlocks = st.unlocks or {}
  local candidate_unlocks = {}

  local sc_match, exe_dir = M.shortcut_entry(s_appid)

  -- 1. RPCS3 / shadPS4 trophy files
  for _, path in ipairs(M.trophy_files(st.schema, sc_match, exe_dir)) do
    local data = read_file(path)
    local parsed = data and (path:match("%.[Dd][Aa][Tt]$") and files.rpcs3_unlocked(data) or files.shadps4_unlocked(data)) or {}
    for id, info in pairs(parsed) do
      candidate_unlocks[id] = info
    end
  end

  -- 2. Console-emulator logs, read from where the last check stopped
  for _, logpath in ipairs(M.log_paths(game_title, sc_match, exe_dir)) do
    local detected = M.scan_log_for_unlocks(logpath)
    for id, info in pairs(detected) do
      candidate_unlocks[id] = info
    end
  end
  save_offsets()

  -- 3. Match Candidates Against Schema & Record Unlocks
  local new_unlocks = {}
  for raw_id, info in pairs(candidate_unlocks) do
    local canonical = M.resolve_canonical_item(raw_id, schema_achievements)
    if canonical and not existing_unlocks[canonical.id] then
      local unlock_time = info.unlocked_time or os.time()
      store.unlock(s_appid, canonical.id, unlock_time)
      existing_unlocks[canonical.id] = { unlocked_time = unlock_time }

      table.insert(new_unlocks, {
        id = canonical.id,
        name = canonical.name,
        description = canonical.description,
        icon = canonical.icon,
        global_pct = canonical.global_pct,
        rtime_unlocked = unlock_time,
      })
    end
  end

  if #new_unlocks > 0 then
    logger:info(string.format("Observer detected %d new unlock(s) for shortcut %d", #new_unlocks, s_appid))
  end

  return { new_unlocks = as_array(new_unlocks) }
end

return M
