--- steam-cartridges - which platform is this shortcut, and may the Steam match be proposed? (Library Setup plan § 4).
---
--- Pure: no disk, no network. Every source asks this one function; no source decides on its own. The verdict only
--- builds a proposal: nothing is applied until the user validates the game (ADR-0086, plan decision 7).
---
--- Signals, each naming a platform from platforms.lua (or none: "a console, platform unknown"):
---   tag       a known platform in a (...) / [...] group of the title: "Hitman 2: Silent Assassin (PS2)"
---   program   the emulator the shortcut starts (pcsx2 -> ps2; retroarch -> none)
---   core      a RetroArch core on the command line (-L cores\snes9x_libretro.dll -> snes)
---   rom       a ROM / disc file on the command line (.sfc -> snes; .iso -> none)
---   port      a native port that is not sold on Steam (native_ports.lua store_match = false)
---   path      a folder named like a console on the target, its arguments or the start folder (D:\roms\ps2\...)
---   collection a Steam collection named like a console ("PS2", "PlayStation 2 Games"), passed in by the app
---   steam     an exact Steam store hit (a candidate, never proof)
---   choice    what the user validated: the strongest signal, it overrides every other
---
--- States: steam (a steam / pc tag), steam-proposed (an exact Steam hit and nothing else), other (a console),
--- conflict (signals disagree), unknown (nothing settles it).

local platforms = require("platforms")
local emulators = require("steam_store_emulators")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  core = nil, -- fun(cmd) -> core name | nil ; nil = emulator_controllers.core
  port = nil, -- fun(program) -> port definition | nil ; nil = native_ports.for_program
}

local function trim(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end

--- The platform a title is tagged with, and the title without that tag. Only a whole group (or one comma-separated
--- part of it) that is a known tag counts: "(USA)", "(v1.1)", "[!]" are not tags and stay in the title.
---@param title string
---@return string|nil platform
---@return string title_without_tag
function M.platform_tag(title)
  title = tostring(title or "")
  local found, start_at, end_at
  local pos = 1
  while true do
    local s, e, open = title:find("([%(%[])", pos)
    if not s then break end
    local close = open == "(" and ")" or "]"
    local ce = title:find(close, e + 1, true)
    if not ce then break end
    local inner = title:sub(e + 1, ce - 1)
    for part in (inner .. ","):gmatch("([^,]*),") do
      local id = platforms.BY_TAG[trim(part):lower()]
      if id then found, start_at, end_at = id, s, ce break end
    end
    if found then break end
    pos = ce + 1
  end
  if not found then return nil, trim(title) end
  local rest = title:sub(1, start_at - 1) .. title:sub(end_at + 1)
  return found, trim((rest:gsub("%s%s+", " ")))
end

local function core_of(cmd)
  if M.deps.core then return M.deps.core(cmd) end
  local ok, ec = pcall(require, "emulator_controllers")
  return ok and ec.core(cmd) or nil
end

local function port_of(program)
  if M.deps.port then return M.deps.port(program) end
  local ok, np = pcall(require, "native_ports")
  return ok and np.for_program(program) or nil
end

--- ROM extensions named on a command line (lower case, in order).
local function rom_extensions(cmd)
  local out = {}
  local lower = tostring(cmd or ""):lower()
  for ext in lower:gmatch("%.([%w]+)[\"'%s]") do out[#out + 1] = ext end
  local last = lower:match("%.([%w]+)$")
  if last then out[#out + 1] = last end
  return out
end

local function set_of(list)
  local s = {}
  for _, v in ipairs(list or {}) do s[v] = true end
  return s
end

--- The console signals of a shortcuts.vdf entry: { {kind, platforms = {ids} | {}, detail}, ... }.
--- An empty platforms list means "a console, platform unknown".
function M.console_signals(entry)
  local out = {}
  if type(entry) ~= "table" then return out end
  local cmd = tostring(entry.exe or "") .. " " .. tostring(entry.launch_options or "")
  local program = emulators.program(entry.exe)
  local head = program:match("^(%w+)[%-_ ]")

  local port = port_of(program)
  if port and port.store_match == false then
    out[#out + 1] = { kind = "port", platforms = port.platform and { port.platform } or {}, detail = port.id or program }
  end

  if program == "retroarch" or head == "retroarch" or cmd:lower():find("_libretro", 1, true) then
    local core = core_of(cmd)
    out[#out + 1] = { kind = "program", platforms = {}, detail = "retroarch" }
    if core then
      out[#out + 1] = { kind = "core", platforms = platforms.CORES[core] or {}, detail = core }
    end
  else
    -- The program alone (its basename): a ROM on the command line is the rom signal below, not this one.
    local known = platforms.PROGRAMS[program] or (head and platforms.PROGRAMS[head])
    if known or (not port and emulators.is_emulator(program)) then
      out[#out + 1] = { kind = "program", platforms = known or {}, detail = program }
    end
  end

  local exts = rom_extensions(cmd)
  for _, ext in ipairs(exts) do
    if emulators.names_rom("x." .. ext) or platforms.EXTENSIONS[ext] then
      local p = platforms.EXTENSIONS[ext]
      out[#out + 1] = { kind = "rom", platforms = p and { p } or {}, detail = "." .. ext }
      break
    end
  end

  -- A folder named like a console on the target, its arguments or the start folder ("D:\roms\ps2\..."; plan Q6).
  local seen = {}
  -- Every piece followed by a separator is a folder; the file name at the end is not.
  local paths = (cmd .. " " .. tostring(entry.start_dir or "")):gsub("\\", "/")
  for seg in paths:gmatch("([^/\"]+)/") do
    local key = seg:lower():gsub("^%s+", ""):gsub("%s+$", "")
    local id = platforms.BY_TAG[key]
    if id and not platforms.STEAM_SIDE[id] and not M.PATH_IGNORED[key] and not seen[id] then
      seen[id] = true
      out[#out + 1] = { kind = "path", platforms = { id }, detail = seg }
    end
  end
  return out
end

--- Tags too short or too common to mean a console as a folder name ("D:\PC\", "\md\", "\360\").
M.PATH_IGNORED = {}
for t in ("pc win dc md gg ns fc 360 2600 gc steam windows"):gmatch("%S+") do M.PATH_IGNORED[t] = true end

--- Console signals from the Steam collections the game is in (plan Q6): a collection named like a console, alone or
--- followed by "games" ("PS2", "PlayStation 2 Games"). The app reads the collections (Steam's collection store) and
--- passes their names; a steam / pc collection says nothing about a shortcut.
function M.collection_signals(collections)
  local out, seen = {}, {}
  for _, name in ipairs(type(collections) == "table" and collections or {}) do
    local key = tostring(name):lower():gsub("^%s+", ""):gsub("%s+$", ""):gsub("%s+games$", "")
    local id = platforms.BY_TAG[key]
    if id and not platforms.STEAM_SIDE[id] and not seen[id] then
      seen[id] = true
      out[#out + 1] = { kind = "collection", platforms = { id }, detail = tostring(name) }
    end
  end
  return out
end

--- The platforms every console signal allows (their intersection), or nil when no signal names one.
--- Returns the list and whether two signals disagree (an empty intersection).
local function narrow(signals)
  local current = nil
  for _, sig in ipairs(signals) do
    if #sig.platforms > 0 then
      if not current then
        current = set_of(sig.platforms)
      else
        local next_set, any = {}, false
        for _, p in ipairs(sig.platforms) do
          if current[p] then next_set[p] = true; any = true end
        end
        if not any then return nil, true end
        current = next_set
      end
    end
  end
  if not current then return nil, false end
  local list = {}
  for p in pairs(current) do list[#list + 1] = p end
  table.sort(list)
  return list, false
end

--- The verdict for one shortcut.
---@param title string            the shortcut's name
---@param entry table|nil         its shortcuts.vdf row { exe, launch_options, start_dir }
---@param steam table|nil         the Steam store proposal { appid, name } (steam_store_search.proposal)
---@param choice table|nil        the user's validated answer { platform = id }
---@param collections string[]|nil the names of the Steam collections the game is in
---@return table { state, platform = id | nil, candidates = { ids }, title = title without tag, signals = { ... } }
function M.verdict(title, entry, steam, choice, collections)
  local tag, bare = M.platform_tag(title)
  local signals = {}
  if tag then signals[#signals + 1] = { kind = "tag", platforms = { tag }, detail = tag } end
  local consoles = M.console_signals(entry)
  for _, s in ipairs(M.collection_signals(collections)) do consoles[#consoles + 1] = s end
  for _, s in ipairs(consoles) do signals[#signals + 1] = s end
  if steam then signals[#signals + 1] = { kind = "steam", platforms = { "steam" }, detail = tostring(steam.appid) } end

  local function result(state, platform, candidates)
    return { state = state, platform = platform, candidates = candidates or (platform and { platform } or {}),
      title = bare, signals = signals }
  end

  if type(choice) == "table" and choice.platform then
    local p = choice.platform
    return result(platforms.STEAM_SIDE[p] and "steam" or "other", p)
  end

  local console_list, console_conflict = narrow(consoles)
  local is_console = #consoles > 0

  if tag and platforms.STEAM_SIDE[tag] then
    if is_console then return result("conflict", nil, console_list) end
    return result("steam", tag)
  end

  if tag then
    if console_conflict then return result("conflict", nil) end
    if console_list and not set_of(console_list)[tag] then return result("conflict", nil, { tag, unpack(console_list) }) end
    return result("other", tag)
  end

  if is_console then
    if console_conflict then return result("conflict", nil) end
    if console_list and #console_list == 1 then return result("other", console_list[1]) end
    return result("other", nil, console_list)
  end

  if steam then return result("steam-proposed", "steam") end
  return result("unknown", nil)
end

return M
