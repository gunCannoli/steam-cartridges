--- steam-cartridges - Xenia Local Xbox 360 Achievement Provider.
---
--- Achievements for games launched through Xenia, read from the emulator's own profile files (no sign-in, no network).
--- Layout (PlayniteAchievements' Xenia provider, MIT, and the XDBF/GPD format):
---   account folder   <Xenia folder>/content/<XUID>/FFFE07D1/00010000/<XUID>/   (holds a file named `Account`)
---   one game         <TITLEID>.gpd in that folder: an XDBF container, ALL numbers big-endian
---     header   "XDBF", version, entry capacity, entries used, free capacity, free used (u32 each, 24 bytes)
---     entries  18 bytes each from byte 24: section u16, id u64, offset u32, size u32; the data starts at
---              24 + 18 * entry capacity + 8 * free capacity, an entry's offset is relative to that
---     section 1 an achievement: magic, id, icon id, gamerscore, flags (u32 each), unlock FILETIME u64, then three
---              UTF-16BE strings ending in NUL: name, description once earned, description while locked
---              flags: 0x20000 earned, 0x08 shown (hidden when clear), low 3 bits the type; flags 0 = never synced, skipped
---     section 2 an icon (PNG) with the icon id as its entry id; section 5 the game's title string
--- The title id comes from the game's .xex header (execution info), a folder named after it, or, for an .iso, the
--- shortcut's name matched against the title strings of the account's .gpd files.

local utils       = require("utils")
local fs          = require("fs")
local logger      = require("logger")
local platform    = require("platform")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")
local store       = require("achievements_store")

local M = {}

--- Injectable dependencies for testing.
M.deps = {
  steam_paths = nil,
  shortcuts = nil,
  store = nil,
  icon_dir = nil,      -- fun() -> folder for extracted icons ; nil = <data dir>/xenia_icons
  default_roots = nil, -- fun() -> { Xenia folders } ; nil = the per-user Xenia folders found through platform.lua
}

local function is_file(p)
  if not p or p == "" then return false end
  local f = io.open(p, "rb")
  if f then f:close() return true end
  return false
end

local function is_dir(p)
  if not p or p == "" then return false end
  local ok, res = pcall(fs.is_directory, p)
  return ok and res == true
end

local function list(dir)
  local ok, entries = pcall(fs.list, dir)
  local out = {}
  if not ok or type(entries) ~= "table" then return out end
  for _, e in ipairs(entries) do
    local name = type(e) == "table" and (e.name or e.path) or tostring(e)
    name = tostring(name):gsub("\\", "/"):match("([^/]+)$")
    if name then out[#out + 1] = name end
  end
  table.sort(out)
  return out
end

local function slashes(p) return (tostring(p or ""):gsub("\\", "/"):gsub("/+$", "")) end

local function file_url(p)
  p = slashes(p)
  if p:sub(1, 1) == "/" then return "file://" .. p end
  return "file:///" .. p
end

local function distinct(t)
  local seen, c = {}, 0
  for _, v in pairs(t or {}) do
    if not seen[v] then seen[v] = true c = c + 1 end
  end
  return c
end

-- ---------- pure readers (big-endian) ----------

local function u16(d, pos)
  local a, b = d:byte(pos, pos + 1)
  if not b then return nil end
  return a * 256 + b
end

local function u32(d, pos)
  local a, b, c, e = d:byte(pos, pos + 3)
  if not e then return nil end
  return ((a * 256 + b) * 256 + c) * 256 + e
end

local function u64(d, pos)
  local hi, lo = u32(d, pos), u32(d, pos + 4)
  if not lo then return nil end
  return hi * 4294967296 + lo
end

--- UTF-16BE (NUL ended) at `pos` -> UTF-8 text and the position after the terminator.
local function utf16be(d, pos, limit)
  local out = {}
  while pos + 1 <= limit do
    local cu = u16(d, pos)
    pos = pos + 2
    if cu == 0 or cu == nil then break end
    if cu >= 0xD800 and cu <= 0xDBFF and pos + 1 <= limit then
      local lo = u16(d, pos)
      if lo and lo >= 0xDC00 and lo <= 0xDFFF then
        cu = 0x10000 + (cu - 0xD800) * 1024 + (lo - 0xDC00)
        pos = pos + 2
      end
    end
    if cu < 0x80 then out[#out + 1] = string.char(cu)
    elseif cu < 0x800 then out[#out + 1] = string.char(0xC0 + math.floor(cu / 64), 0x80 + cu % 64)
    elseif cu < 0x10000 then
      out[#out + 1] = string.char(0xE0 + math.floor(cu / 4096), 0x80 + math.floor(cu / 64) % 64, 0x80 + cu % 64)
    else
      out[#out + 1] = string.char(0xF0 + math.floor(cu / 262144), 0x80 + math.floor(cu / 4096) % 64,
        0x80 + math.floor(cu / 64) % 64, 0x80 + cu % 64)
    end
  end
  return table.concat(out), pos
end

local FILETIME_TO_UNIX = 11644473600

--- Windows FILETIME (100 ns since 1601) -> Unix seconds, or nil when it is not a plausible date.
local function filetime_to_unix(ft)
  if not ft or ft <= 0 then return nil end
  local s = math.floor(ft / 10000000) - FILETIME_TO_UNIX
  if s <= 0 or s > 4102444800 then return nil end
  return s
end

--- An XDBF/GPD file's content -> { achievements = { {id, icon_id, gamerscore, flags, earned, unlock_time, name,
--- description_unlocked, description_locked} }, icons = { [icon id] = png bytes }, title = string|nil } or nil, why.
--- Only the achievement, icon and title-string entries are read.
function M.parse_gpd(data)
  if type(data) ~= "string" or #data < 24 then return nil, "file too short" end
  if u32(data, 1) ~= 0x58444246 then return nil, "not an XDBF file (bad magic)" end
  local cap, used, free_cap = u32(data, 9), u32(data, 13), u32(data, 17)
  if not (cap and used and free_cap) or cap > 1000000 or used > cap or free_cap > 1000000 then
    return nil, "entry table out of range"
  end
  local base = 24 + 18 * cap + 8 * free_cap -- 0-based start of the data area
  if base > #data then return nil, "data area out of range" end
  local out = { achievements = {}, icons = {} }
  for i = 0, used - 1 do
    local at = 24 + 18 * i + 1
    local section, id, offset, size = u16(data, at), u64(data, at + 2), u32(data, at + 10), u32(data, at + 14)
    if not (section and id and offset and size) then return nil, "truncated entry table" end
    local first = base + offset + 1 -- 1-based
    if first + size - 1 > #data then return nil, "entry out of range" end
    if section == 1 and size >= 28 then
      local flags = u32(data, first + 16)
      if flags ~= 0 then
        local last = first + size - 1
        local name, p = utf16be(data, first + 28, last)
        local desc_unlocked, p2 = utf16be(data, p, last)
        local desc_locked = utf16be(data, p2, last)
        out.achievements[#out.achievements + 1] = {
          id = u32(data, first + 4),
          icon_id = u32(data, first + 8),
          gamerscore = u32(data, first + 12) or 0,
          flags = flags,
          earned = math.floor(flags / 131072) % 2 == 1,
          unlock_time = filetime_to_unix(u64(data, first + 20)),
          name = name, description_unlocked = desc_unlocked, description_locked = desc_locked,
        }
      end
    elseif section == 2 and size > 0 then
      out.icons[id] = data:sub(first, first + size - 1)
    elseif section == 5 and not out.title then
      local t = utf16be(data, first, first + size - 1)
      if t ~= "" then out.title = t end
    end
  end
  return out
end

--- The title id (8 upper-case hex digits) of a .xex's header, or nil. `head` = the file's first bytes (XEX2 header:
--- optional headers from byte 24, each key u32 + value u32; key 0x00040006 is execution info, the value an offset to
--- media id, version, base version, title id).
function M.xex_title_id(head)
  if type(head) ~= "string" or head:sub(1, 4) ~= "XEX2" then return nil end
  local count = u32(head, 21)
  if not count or count > 256 then return nil end
  for i = 0, count - 1 do
    local at = 24 + i * 8 + 1
    if u32(head, at) == 0x00040006 then
      local off = u32(head, at + 4)
      local tid = off and u32(head, off + 12 + 1)
      if tid and tid ~= 0 then return string.format("%08X", tid) end
      return nil
    end
  end
  return nil
end

--- Xbox 360 achievement points -> a tier percentage (a tier, not a real unlock rate: Xenia has no global statistics).
local function tier_pct(gs)
  if gs <= 10 then return 60 elseif gs <= 25 then return 45 elseif gs <= 50 then return 30 elseif gs <= 100 then return 15 end
  return 5
end

--- GPD content -> the canonical schema achievements (icons are written by the caller: it gives icon_url(icon_id)).
function M.build_achievements(parsed, icon_url)
  local list_out, unlocks, seen = {}, {}, {}
  for _, a in ipairs(parsed.achievements) do
    if a.id and not seen[a.id] then
      seen[a.id] = true
      local hidden = math.floor(a.flags / 8) % 2 == 0
      local icon = icon_url and parsed.icons[a.icon_id] and icon_url(a.icon_id) or ""
      list_out[#list_out + 1] = {
        id = tostring(a.id),
        name = a.name ~= "" and a.name or ("Achievement " .. tostring(a.id)),
        description = hidden and (a.description_locked ~= "" and a.description_locked or a.description_unlocked)
          or (a.description_unlocked ~= "" and a.description_unlocked or a.description_locked),
        icon = icon, icon_locked = icon,
        points = a.gamerscore, global_pct = tier_pct(a.gamerscore),
        hidden = hidden,
      }
      if a.earned then unlocks[tostring(a.id)] = { unlocked_time = a.unlock_time or os.time() } end
    end
  end
  return list_out, unlocks
end

-- ---------- finding the files ----------

local function tokens(exe, launch_options)
  local full = slashes(tostring(exe or "") .. " " .. tostring(launch_options or ""))
  local out = {}
  for q in full:gmatch('"([^"]+)"') do out[#out + 1] = q end
  for t in full:gmatch("%S+") do out[#out + 1] = (t:gsub('"', "")) end
  return out
end

local function default_roots()
  if M.deps.default_roots then return M.deps.default_roots() end
  return platform.locate({ "Xenia", "xenia", "Xenia Canary", "xenia_canary" }, is_dir)
end

--- Every account folder under the Xenia folders the command points at, plus the per-user ones.
function M.account_dirs(exe, launch_options)
  local roots, seen_root = {}, {}
  local function add_root(p)
    p = slashes(p)
    if p ~= "" and not seen_root[p] then seen_root[p] = true roots[#roots + 1] = p end
  end
  for _, tok in ipairs(tokens(exe, launch_options)) do
    if tok:lower():find("xenia", 1, true) then add_root(tok:match("^(.*)/[^/]+$") or tok) end
  end
  for _, p in ipairs(default_roots()) do add_root(p) end
  local out = {}
  for _, root in ipairs(roots) do
    for _, profile in ipairs(list(root .. "/content")) do
      local base = root .. "/content/" .. profile .. "/FFFE07D1/00010000"
      for _, xuid in ipairs(list(base)) do
        if is_file(base .. "/" .. xuid .. "/Account") then out[#out + 1] = base .. "/" .. xuid end
      end
    end
  end
  return out
end

local function gpd_path(account, tid)
  for _, name in ipairs({ tid .. ".gpd", tid:lower() .. ".gpd" }) do
    if is_file(account .. "/" .. name) then return account .. "/" .. name end
  end
  return nil
end

local function norm(s) return (tostring(s or ""):lower():gsub("[^%w]", "")) end

--- The game's title id and its .gpd files: { title_id, gpds = { path }, via = "xex"|"path"|"name" } or nil.
function M.find_game(exe, launch_options, name)
  local cmd = tostring(exe or "") .. " " .. tostring(launch_options or "")
  if not cmd:lower():find("xenia", 1, true) then return nil end
  local accounts = M.account_dirs(exe, launch_options)
  if #accounts == 0 then return nil end
  local function gpds_for(tid)
    local out = {}
    for _, acc in ipairs(accounts) do
      local p = gpd_path(acc, tid)
      if p then out[#out + 1] = p end
    end
    return out
  end
  local toks = tokens(exe, launch_options)
  -- 1. the .xex header (a plain .xex game file)
  for _, tok in ipairs(toks) do
    if tok:lower():match("%.xex$") then
      local f = io.open(tok, "rb")
      if f then
        local head = f:read(65536)
        f:close()
        local tid = M.xex_title_id(head)
        local g = tid and gpds_for(tid)
        if g and #g > 0 then return { title_id = tid, gpds = g, via = "xex" } end
      end
    end
  end
  -- 2. a folder or file named after the title id (Xbox 360 content is often kept as <TITLEID>/...)
  for _, tok in ipairs(toks) do
    for hex in tok:gmatch("%f[%x](%x%x%x%x%x%x%x%x)%f[%X]") do
      local tid = hex:upper()
      if tid ~= "FFFE07D1" then
        local g = gpds_for(tid)
        if #g > 0 then return { title_id = tid, gpds = g, via = "path" } end
      end
    end
  end
  -- 3. the shortcut's name against the .gpd files' title strings (an .iso carries no id we read)
  local want = norm(name)
  if want ~= "" then
    for _, acc in ipairs(accounts) do
      for _, fname in ipairs(list(acc)) do
        local tid = fname:match("^(%x%x%x%x%x%x%x%x)%.[gG][pP][dD]$")
        if tid and tid:upper() ~= "FFFE07D1" then
          local text = utils.read_file(acc .. "/" .. fname)
          local parsed = text and M.parse_gpd(text)
          if parsed and parsed.title and norm(parsed.title) == want then
            local g = gpds_for(tid:upper())
            if #g > 0 then return { title_id = tid:upper(), gpds = g, via = "name" } end
          end
        end
      end
    end
  end
  return nil
end

local function icon_root()
  if M.deps.icon_dir then return M.deps.icon_dir() end
  return require("data_dir").path() .. "/xenia_icons"
end

--- Main entry point for Xenia shortcuts: reads every build's copy of the game's .gpd and saves the merged set.
function M.get_or_fetch(shortcut_appid)
  local s_appid = tonumber(shortcut_appid) or 0
  if s_appid <= 0 then return nil, "invalid shortcut_appid" end

  local store_mod = M.deps.store or store
  local paths = (M.deps.steam_paths or steam_paths).resolve()
  if not paths or not paths.shortcuts then return nil, "missing shortcuts path" end
  local sc
  for _, entry in ipairs((M.deps.shortcuts or shortcuts).parse(paths.shortcuts) or {}) do
    if entry.appid == s_appid then sc = entry break end
  end
  if not sc then return nil, "shortcut not found" end

  local game = M.find_game(sc.exe, sc.launch_options, sc.name or sc.appname)
  if not game then return nil, "xenia profile for this game not found (play it once in Xenia)" end

  -- Definitions from the first copy that lists an id; the player's progress from the best copy (unlocked in any
  -- build counts, earliest time kept), like PlayniteAchievements.
  local schema_list, merged, icons, read_ok = {}, {}, {}, 0
  local by_id = {}
  for _, path in ipairs(game.gpds) do
    local parsed, err = M.parse_gpd(utils.read_file(path) or "")
    if parsed then
      read_ok = read_ok + 1
      for id, png in pairs(parsed.icons) do if not icons[id] then icons[id] = png end end
      parsed.icons = icons
      local dir = icon_root() .. "/" .. game.title_id
      pcall(function() if not fs.is_directory(dir) then fs.create_directories(dir) end end)
      local function icon_url(icon_id)
        local p = dir .. "/" .. tostring(icon_id) .. ".png"
        if not is_file(p) and icons[icon_id] then utils.write_file(p, icons[icon_id]) end
        return file_url(p)
      end
      local list_out, unlocks = M.build_achievements(parsed, icon_url)
      for _, a in ipairs(list_out) do
        if not by_id[a.id] then by_id[a.id] = true schema_list[#schema_list + 1] = a end
      end
      for id, u in pairs(unlocks) do
        local cur = merged[id]
        if not cur or (u.unlocked_time and u.unlocked_time < cur.unlocked_time) then merged[id] = u end
      end
    else
      logger:info(string.format("[xenia] a profile copy was ignored (%s)", tostring(err)))
    end
  end
  if read_ok == 0 or #schema_list == 0 then return nil, "xenia achievement file could not be read" end

  local schema = {
    xenia_title_id = game.title_id,
    native_appid = 0,
    title = sc.name or sc.appname or game.title_id,
    total = #schema_list,
    fetched_at = os.time(),
    achievements = schema_list,
  }
  store_mod.save_schema_and_sync(s_appid, "xenia_" .. game.title_id, schema, merged, "xenia")
  local state = store_mod.get_state(s_appid) or {}
  state.schema, state.unlocks = schema, merged
  logger:info(string.format("[xenia] loaded set for shortcut %d via=%s: %d achievements, %d unlocked, %d profile copy(ies)",
    s_appid, game.via, schema.total, distinct(merged), read_ok))
  return state
end

return M
