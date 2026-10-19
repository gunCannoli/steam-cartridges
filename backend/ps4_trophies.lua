--- steam-cartridges - shadPS4 Local PlayStation 4 Trophy Provider.
---
--- Integrates local PlayStation 4 trophies for games launched via shadPS4.
--- Key features:
---   1. Parses offline TROP.XML / TROPCONF.SFM schemas (titles, descriptions, trophy types, hidden status).
---   2. Reads unlocks from shadPS4's trophy XML save files (find_save_files) without network access.
---   3. Detects shadPS4 trophy directories across AppData, portable emulator dirs, and game directories.
---   4. Integrates with achievements_store and out-of-process shadps4.log tailer.

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

local function file_exists(path)
  local f = io.open(path, "rb")
  if f then
    f:close()
    return true
  end
  return false
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
  if high > 0x01000000 then
    local unix_sec = math.floor((high * 4294967296 + low) / 1000000) - 11644473600
    if unix_sec > 0 and unix_sec < 2500000000 then return unix_sec end
  end
  return low > 0 and low or os.time()
end

--- Parses TROP.XML / TROPCONF.SFM into canonical schema achievements
function M.parse_trop_xml(xml_text, base_dir)
  if not xml_text or #xml_text == 0 then return nil, "empty xml" end

  local title_id = xml_text:match("<npcommid>([^<]+)</npcommid>") or
                   xml_text:match("<title_id>([^<]+)</title_id>") or
                   "CUSA_UNKNOWN"
  title_id = title_id:gsub("%s+", "")

  local achievements = {}
  local base_uri = (base_dir or ""):gsub("\\", "/")
  if #base_uri > 0 and not base_uri:match("/$") then
    base_uri = base_uri .. "/"
  end

  for trophy_block in xml_text:gmatch("<trophy%s+[^>]*>.-</trophy>") do
    local id = trophy_block:match('id="([^"]+)"') or trophy_block:match('<id>([^<]+)</id>')
    local hidden = (trophy_block:match('hidden="([^"]+)"') == "yes") or
                   (trophy_block:match('<hidden>([^<]+)</hidden>') == "yes")
    local ttype = (trophy_block:match('ttype="([^"]+)"') or
                   trophy_block:match('<ttype>([^<]+)</ttype>') or "B"):upper()
    local name = trophy_block:match("<name>(.-)</name>") or ("Trophy " .. tostring(id))
    local detail = trophy_block:match("<detail>(.-)</detail>") or
                   trophy_block:match("<description>(.-)</description>") or ""

    name = name:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
    detail = detail:gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')

    local metrics = TROPHY_METRICS[ttype] or TROPHY_METRICS.B

    -- Check icon file candidates: TROP000.PNG or TROP0.PNG or trophy icon tag
    local num_id = tonumber(id) or 0
    local icon_candidates = {
      base_uri .. string.format("TROP%03d.PNG", num_id),
      base_uri .. "TROP" .. tostring(id) .. ".PNG",
      base_uri .. string.format("trop%03d.png", num_id),
      base_uri .. "trop" .. tostring(id) .. ".png",
    }
    local icon_url = ""
    for _, ic in ipairs(icon_candidates) do
      if file_exists(ic) then
        icon_url = "file:///" .. ic
        break
      end
    end
    if #icon_url == 0 and #base_uri > 0 then
      icon_url = "file:///" .. icon_candidates[1]
    end

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
    title_id = title_id,
    total = #achievements,
    achievements = achievements,
  }
end

--- shadPS4 keeps unlocks in a trophy XML (`unlockstate="true"`, `timestamp`): its per-user save
--- file <shadPS4>/[user/]home/<user id>/trophy/<npcommid>.xml, or, on older builds, the TROP*.XML
--- in the game's trophy folder. Returns every such file that exists and holds unlock state.
--- `npcommid` may be nil: it is then read from the folder's TROP.XML.
function M.find_save_files(trop_dir, npcommid)
  if not trop_dir then return {} end
  trop_dir = tostring(trop_dir):gsub("\\", "/")
  if not npcommid or not tostring(npcommid):match("^NPWR") then
    local text = utils.read_file(trop_dir .. "/TROP.XML") or ""
    npcommid = text:match("<npcommid>%s*([^<%s]+)%s*</npcommid>")
  end
  local out, seen = {}, {}
  local function add(p)
    if seen[p] or not file_exists(p) then return end
    local text = utils.read_file(p) or ""
    if text:find('unlockstate="', 1, true) then
      seen[p] = true
      out[#out + 1] = p
    end
  end
  -- Older builds: the state in the game's own trophy XML.
  for _, dir in ipairs({ trop_dir, trop_dir .. "/Xml" }) do
    add(dir .. "/TROP.XML")
    for i = 0, 30 do add(string.format("%s/TROP_%02d.XML", dir, i)) end
  end
  -- Current builds: a per-user save file under a home folder above the trophy folder.
  if npcommid then
    local dir = trop_dir
    for _ = 1, 5 do
      dir = dir:match("^(.*)/[^/]+$")
      if not dir then break end
      for _, home in ipairs({ dir .. "/home", dir .. "/user/home" }) do
        if fs.is_directory(home) then
          local ok, entries = pcall(fs.list, home)
          for _, e in ipairs(ok and entries or {}) do
            local user = type(e) == "table" and (e.path or e.name) or e
            user = tostring(user):gsub("\\", "/")
            if not user:find("/", 1, true) then user = home .. "/" .. user end
            add(user .. "/trophy/" .. npcommid .. ".xml")
          end
        end
      end
    end
  end
  return out
end

--- Locates the trophy directory for a given shadPS4 game path
function M.find_trophy_dir(cmd, launch_options)
  local full = (tostring(cmd or "") .. " " .. tostring(launch_options or "")):gsub("\\", "/")
  local candidates = {}
  for q in full:gmatch('"([^"]+)"') do
    table.insert(candidates, q)
  end
  for token in full:gmatch("(%S+)") do
    table.insert(candidates, token:gsub('"', ''))
  end

  -- Search for CUSA or Title ID in command line
  local cusa_id = full:match("(CUSA%d+)") or full:match("(cusa%d+)")
  if cusa_id then cusa_id = cusa_id:upper() end

  local appdata = (os.getenv("APPDATA") or ""):gsub("\\", "/")
  local localappdata = (os.getenv("LOCALAPPDATA") or ""):gsub("\\", "/")

  local root_dirs = {
    appdata .. "/shadps4/user/trophy",
    appdata .. "/shadps4/home/1000/trophy",
    localappdata .. "/shadps4/user/trophy",
  }

  -- Also check next to exe
  for _, p in ipairs(candidates) do
    if p:lower():find("shadps4") then
      local dir = p:match("^(.*)[/\\][^/\\]+$") or p
      table.insert(root_dirs, 1, dir .. "/user/trophy")
      table.insert(root_dirs, 2, dir .. "/home/1000/trophy")
    end
  end

  -- 1. If we have a CUSA ID, check root_dirs/[CUSA_ID]
  if cusa_id then
    for _, root in ipairs(root_dirs) do
      local target = root .. "/" .. cusa_id
      if file_exists(target .. "/TROP.XML") or file_exists(target .. "/TROPCONF.SFM") then
        return target, cusa_id
      end
    end
  end

  -- 2. Check candidate paths from command tokens
  for _, p in ipairs(candidates) do
    local s = p:lower()
    if s:find("eboot%.bin") or s:find("cusa") or s:find("trophy") then
      local dir = p:match("^(.*)[/\\][^/\\]+$") or p
      local subpaths = {
        dir .. "/trophy",
        dir .. "/sce_sys/trophy",
        dir .. "/TROPDIR",
        dir,
      }
      for _, sp in ipairs(subpaths) do
        if file_exists(sp .. "/TROP.XML") or file_exists(sp .. "/TROPCONF.SFM") then
          return sp, cusa_id
        end
      end
    end
  end

  -- 3. Check any existing folder in root_dirs
  for _, root in ipairs(root_dirs) do
    if file_exists(root .. "/TROP.XML") then
      return root, cusa_id
    end
  end

  return nil, nil
end

--- Main entry point for shadPS4 shortcuts
function M.get_or_fetch(shortcut_appid)
  local s_appid = tonumber(shortcut_appid) or 0
  if s_appid <= 0 then return nil, "invalid shortcut_appid" end

  -- 1. Check existing state in achievements.json
  local st = store.get_state(s_appid)
  if st and st.schema and st.schema.ps4_title_id then
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
  if not full_cmd:find("shadps4") and not full_cmd:find("cusa") then
    return nil, "not a shadps4 shortcut"
  end

  -- 3. Locate Trophy Directory
  local trop_dir, detected_id = M.find_trophy_dir(sc.exe, sc.launch_options)
  if not trop_dir then
    return nil, "shadps4 trophy directory not found"
  end

  -- 4. Parse XML
  local xml_path = trop_dir .. "/TROP.XML"
  if not file_exists(xml_path) then
    xml_path = trop_dir .. "/TROPCONF.SFM"
  end
  local xml_text = utils.read_file(xml_path)
  if not xml_text then
    return nil, "cannot read TROP.XML"
  end

  local parsed_schema, err = M.parse_trop_xml(xml_text, trop_dir)
  if not parsed_schema then return nil, err end

  local effective_title_id = detected_id or parsed_schema.title_id

  -- 5. Unlocks from shadPS4's trophy XML save files
  local unlocks = {}
  for _, path in ipairs(M.find_save_files(trop_dir, parsed_schema.title_id)) do
    for id, info in pairs(require("achievement_files").shadps4_unlocked(utils.read_file(path) or "")) do
      unlocks[id] = info
    end
  end

  local schema = {
    ps4_title_id = effective_title_id,
    ps4_npcommid = parsed_schema.title_id,
    native_appid = 0,
    title = sc.name or sc.appname or effective_title_id,
    total = parsed_schema.total,
    fetched_at = os.time(),
    achievements = parsed_schema.achievements,
  }

  -- 6. Save in achievements_store (atomic sync)
  local schema_key = "ps4_" .. tostring(effective_title_id)
  store.save_schema_and_sync(s_appid, schema_key, schema, unlocks, "shadps4")

  local final_state = store.get_state(s_appid)
  final_state.schema = schema
  final_state.unlocks = unlocks

  logger:info(string.format(
    "shadPS4: loaded '%s' (TitleID %s) for shortcut %d: %d trophies, %d unlocked",
    schema.title, effective_title_id, s_appid, schema.total, count_keys(unlocks)
  ))

  return final_state
end

return M
