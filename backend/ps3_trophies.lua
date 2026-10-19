--- steam-cartridges - RPCS3 Local PlayStation 3 Trophy Provider (Phase 5).
---
--- Integrates local PlayStation 3 trophies for games launched via RPCS3.
--- Key features:
---   1. Parses official offline TROPCONF.SFM XML schema (titles, descriptions, types, hidden status).
---   2. Parses TROPUSR.DAT binary unlock database (its trophy state table, achievement_files.lua) without network access.
---   3. Maps trophy types (Platinum, Gold, Silver, Bronze) to canonical points and rarity percentiles.
---   4. Integrates with achievements_store and out-of-process RPCS3.log tailer.

local utils       = require("utils")
local fs          = require("fs")
local logger      = require("logger")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")
local store       = require("achievements_store")

local M = {}

--- Points and default rarity percentiles by Sony trophy type
local TROPHY_METRICS = {
  P = { points = 300, global_pct = 5,  name = "Platinum" },
  G = { points = 90,  global_pct = 15, name = "Gold" },
  S = { points = 30,  global_pct = 30, name = "Silver" },
  B = { points = 15,  global_pct = 60, name = "Bronze" },
}

local function count_keys(tbl)
  local c = 0
  for _ in pairs(tbl or {}) do c = c + 1 end
  return c
end

--- Read 32-bit unsigned big-endian integer from string
local function read_u32_be(data, offset)
  local b1, b2, b3, b4 = data:byte(offset, offset + 3)
  if not b4 then return 0 end
  return b1 * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4
end

--- Read 64-bit unsigned big-endian integer (approximate to seconds)
local function read_u64_be(data, offset)
  local high = read_u32_be(data, offset)
  local low = read_u32_be(data, offset + 4)
  if high == 0 and low == 0 then return 0 end
  -- Sony timestamps in microseconds since 0001-01-01 or Unix epoch
  if high > 0x01000000 then
    -- Convert Windows/Sony filetime to Unix timestamp
    local unix_sec = math.floor((high * 4294967296 + low) / 1000000) - 11644473600
    if unix_sec > 0 and unix_sec < 2500000000 then return unix_sec end
  end
  return low > 0 and low or os.time()
end

--- Parses TROPCONF.SFM XML file into canonical schema achievements
function M.parse_tropconf(xml_text, base_dir)
  if not xml_text or #xml_text == 0 then return nil, "empty xml" end

  local npcommid = xml_text:match("<npcommid>([^<]+)</npcommid>") or "NPWR_UNKNOWN"
  npcommid = npcommid:gsub("%s+", "")

  local achievements = {}
  local base_uri = (base_dir or ""):gsub("\\", "/")
  if #base_uri > 0 and not base_uri:match("/$") then
    base_uri = base_uri .. "/"
  end

  -- Scan <trophy id="..." hidden="..." ttype="...">
  for trophy_block in xml_text:gmatch("<trophy%s+[^>]*>.-</trophy>") do
    local id = trophy_block:match('id="([^"]+)"')
    local hidden = trophy_block:match('hidden="([^"]+)"') == "yes"
    local ttype = (trophy_block:match('ttype="([^"]+)"') or "B"):upper()
    local name = trophy_block:match("<name>(.-)</name>") or ("Trophy " .. tostring(id))
    local detail = trophy_block:match("<detail>(.-)</detail>") or ""

    -- Clean XML entities
    name = name:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
    detail = detail:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')

    local metrics = TROPHY_METRICS[ttype] or TROPHY_METRICS.B
    local icon_path = #base_uri > 0 and (base_uri .. "TROP" .. tostring(id) .. ".PNG") or ""
    local icon_url = #icon_path > 0 and ("file:///" .. icon_path) or ""

    if id then
      table.insert(achievements, {
        id = tostring(id),
        name = name,
        description = detail,
        icon = icon_url,
        icon_locked = icon_url,
        points = metrics.points,
        global_pct = metrics.global_pct,
        ttype = ttype,
        hidden = hidden,
      })
    end
  end

  return {
    title_id = npcommid,
    total = #achievements,
    achievements = achievements,
  }
end

--- Unlocked trophies in a TROPUSR.DAT (RPCS3's format, achievement_files.lua):
--- id ("0" and "000") -> { unlocked_time }.
function M.parse_tropusr(binary_data)
  return require("achievement_files").rpcs3_unlocked(binary_data)
end

--- Locates the trophy directory for a given RPCS3 game path
function M.find_trophy_dir(cmd, launch_options)
  local full = (tostring(cmd or "") .. " " .. tostring(launch_options or "")):gsub("\\", "/")
  
  -- Scan quoted arguments or file tokens
  local candidates = {}
  for q in full:gmatch('"([^"]+)"') do
    table.insert(candidates, q)
  end
  for token in full:gmatch("(%S+)") do
    table.insert(candidates, token:gsub('"', ''))
  end

  for _, p in ipairs(candidates) do
    local s = p:lower()
    if s:find("eboot%.bin") or s:find("ps3_game") or s:find("npwr") then
      local dir = p:match("^(.*)[/\\][^/\\]+$") or p
      -- Check common relative locations for TROPDIR
      local subpaths = {
        dir .. "/TROPDIR",
        dir .. "/../TROPDIR",
        dir .. "/../../TROPDIR",
        dir .. "/PS3_GAME/TROPDIR",
        dir,
      }
      for _, sp in ipairs(subpaths) do
        -- Check if any NPWR folder exists in sp
        local f = io.open(sp .. "/TROPCONF.SFM", "r")
        if f then
          f:close()
          return sp
        end
      end
    end
  end

  -- Check RPCS3 install paths (next to the shortcut's exe first, then %APPDATA%)
  local appdata = (os.getenv("APPDATA") or ""):gsub("\\", "/")
  local default_rpcs3_trophies = {
    appdata .. "/rpcs3/dev_hdd0/home/00000001/trophy",
  }

  for _, p in ipairs(candidates) do
    if p:lower():find("rpcs3") then
      local dir = p:match("^(.*)[/\\][^/\\]+$") or p
      table.insert(default_rpcs3_trophies, 1, dir .. "/dev_hdd0/home/00000001/trophy")
    end
  end

  for _, r_path in ipairs(default_rpcs3_trophies) do
    local f = io.open(r_path, "r")
    if f then
      f:close()
      return r_path
    end
  end

  return nil
end

--- Main entry point for RPCS3 shortcuts
function M.get_or_fetch(shortcut_appid)
  local s_appid = tonumber(shortcut_appid) or 0
  if s_appid <= 0 then return nil, "invalid shortcut_appid" end

  -- 1. Check existing state in achievements.json
  local st = store.get_state(s_appid)
  if st and st.schema and st.schema.ps3_title_id then
    return st
  end

  -- 2. Resolve shortcut
  local paths = steam_paths.resolve()
  if not paths or not paths.shortcuts then return nil, "missing shortcuts path" end

  local list = shortcuts.parse(paths.shortcuts) or {}
  local sc = nil
  for _, entry in ipairs(list) do
    if entry.appid == s_appid then
      sc = entry
      break
    end
  end

  if not sc then return nil, "shortcut not found" end

  local full_cmd = (tostring(sc.exe or "") .. " " .. tostring(sc.launch_options or "")):lower()
  if not full_cmd:find("rpcs3") and not full_cmd:find("ps3_game") and not full_cmd:find("eboot%.bin") then
    return nil, "not an rpcs3 shortcut"
  end

  -- 3. Locate Trophy Directory
  local trop_dir = M.find_trophy_dir(sc.exe, sc.launch_options)
  if not trop_dir then
    return nil, "rpcs3 trophy directory not found"
  end

  -- 4. Parse TROPCONF.SFM
  local sfm_path = trop_dir .. "/TROPCONF.SFM"
  local sfm_text = utils.read_file(sfm_path)
  if not sfm_text then
    return nil, "cannot read TROPCONF.SFM"
  end

  local parsed_schema, err = M.parse_tropconf(sfm_text, trop_dir)
  if not parsed_schema then return nil, err end

  -- 5. Parse TROPUSR.DAT
  local usr_path = trop_dir .. "/TROPUSR.DAT"
  local usr_data = utils.read_file(usr_path)
  local unlocks = usr_data and M.parse_tropusr(usr_data) or {}

  local schema = {
    ps3_title_id = parsed_schema.title_id,
    native_appid = 0,
    title = sc.name or sc.appname or parsed_schema.title_id,
    total = parsed_schema.total,
    fetched_at = os.time(),
    achievements = parsed_schema.achievements,
  }

  -- 6. Save in achievements_store (atomic sync)
  local schema_key = "ps3_" .. tostring(parsed_schema.title_id)
  store.save_schema_and_sync(s_appid, schema_key, schema, unlocks, "rpcs3")

  local final_state = store.get_state(s_appid)
  final_state.schema = schema
  final_state.unlocks = unlocks

  logger:info(string.format(
    "RPCS3: loaded '%s' (TitleID %s) for shortcut %d: %d trophies, %d unlocked",
    schema.title, parsed_schema.title_id, s_appid, schema.total, count_keys(unlocks)
  ))

  return final_state
end

return M
