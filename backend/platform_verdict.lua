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
      local family = M.COLLECTION_FAMILIES[id]
      out[#out + 1] = { kind = "path", platforms = family or { id }, detail = seg }
    end
  end
  return out
end

--- Tags too short or too common to mean a console as a folder name ("D:\PC\", "\md\", "\360\").
M.PATH_IGNORED = {}
for t in ("pc win dc md gg ns fc 360 2600 gc steam windows"):gmatch("%S+") do M.PATH_IGNORED[t] = true end

--- Console families where a collection name or broad folder refers to a family of systems rather than a single generation.
M.COLLECTION_FAMILIES = {
  wii = { "wii", "wiiu" },
  psx = { "psx", "ps2", "ps3", "ps4" },
  xbox = { "xbox", "xbox360" },
  gb = { "gb", "gbc", "gba" },
}

--- Signal reliability weights for arbitration and conflict resolution (review-queue plan Phase D).
M.SIGNAL_WEIGHTS = {
  choice = 100,
  port = 80,
  core = 70,
  program = 65,
  rom = 65,
  tag = 50,
  path = 20,
  collection = 15,
  steam = 10,
}

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
      local family = M.COLLECTION_FAMILIES[id]
      out[#out + 1] = { kind = "collection", platforms = family or { id }, detail = tostring(name) }
    end
  end
  return out
end

--- Resolves the best platform from signals and candidate platforms based on signal weights.
--- Returns: best_platform, is_tie, dispute_reason
local function resolve_best(signals, candidates)
  if not candidates or #candidates == 0 then return nil, false, nil end
  if #candidates == 1 then return candidates[1], false, nil end

  local scores = {}
  local best_sig = {}
  for _, c in ipairs(candidates) do scores[c] = 0 end

  for _, sig in ipairs(signals) do
    local w = M.SIGNAL_WEIGHTS[sig.kind] or 10
    local p_set = set_of(sig.platforms or {})
    for _, c in ipairs(candidates) do
      if p_set[c] then
        scores[c] = (scores[c] or 0) + w
        if not best_sig[c] or w > best_sig[c].weight then
          best_sig[c] = { weight = w, kind = sig.kind, detail = sig.detail }
        end
      end
    end
  end

  local best_p, best_score, second_score = nil, -1, -1
  for _, c in ipairs(candidates) do
    local sc = scores[c] or 0
    if sc > best_score then
      second_score = best_score
      best_score = sc
      best_p = c
    elseif sc > second_score then
      second_score = sc
    end
  end

  local is_tie = (best_score == second_score and best_score > 0)
  local reason
  if best_p and best_sig[best_p] then
    reason = string.format("Platform %s favored based on %s", best_p, best_sig[best_p].kind)
  end

  return best_p, is_tie, reason
end

--- The platforms every console signal allows (their intersection), or nil when no signal names one.
--- Returns the list, whether two signals disagree (an empty intersection), and all candidate platforms seen.
local function narrow(signals)
  local current = nil
  local all_platforms = {}
  for _, sig in ipairs(signals) do
    for _, p in ipairs(sig.platforms or {}) do all_platforms[p] = true end
    if #sig.platforms > 0 then
      if not current then
        current = set_of(sig.platforms)
      else
        local next_set, any = {}, false
        for _, p in ipairs(sig.platforms) do
          if current[p] then next_set[p] = true; any = true end
        end
        if not any then
          local all_list = {}
          for p in pairs(all_platforms) do all_list[#all_list + 1] = p end
          table.sort(all_list)
          return nil, true, all_list
        end
        current = next_set
      end
    end
  end
  if not current then return nil, false, {} end
  local list = {}
  for p in pairs(current) do list[#list + 1] = p end
  table.sort(list)
  return list, false, list
end

--- The verdict for one shortcut.
---@param title string            the shortcut's name
---@param entry table|nil         its shortcuts.vdf row { exe, launch_options, start_dir }
---@param steam table|nil         the Steam store proposal { appid, name } (steam_store_search.proposal)
---@param choice table|nil        the user's validated answer { platform = id }
---@param collections string[]|nil the names of the Steam collections the game is in
---@return table { state, platform = id | nil, candidates = { ids }, title = title without tag, signals = { ... }, disputed = bool, dispute_reason = string|nil }
function M.verdict(title, entry, steam, choice, collections)
  local tag, bare = M.platform_tag(title)
  local signals = {}
  if tag then signals[#signals + 1] = { kind = "tag", platforms = { tag }, detail = tag } end
  local consoles = M.console_signals(entry)
  for _, s in ipairs(M.collection_signals(collections)) do consoles[#consoles + 1] = s end
  for _, s in ipairs(consoles) do signals[#signals + 1] = s end
  if steam then signals[#signals + 1] = { kind = "steam", platforms = { "steam" }, detail = tostring(steam.appid) } end

  local function result(state, platform, candidates, disputed, dispute_reason)
    return {
      state = state,
      platform = platform,
      candidates = candidates or (platform and { platform } or {}),
      title = bare,
      signals = signals,
      disputed = disputed or false,
      dispute_reason = dispute_reason,
    }
  end

  if type(choice) == "table" and choice.platform then
    local p = choice.platform
    return result(platforms.STEAM_SIDE[p] and "steam" or "other", p)
  end

  local console_list, console_conflict, all_console_candidates = narrow(consoles)
  local is_console = #consoles > 0

  if tag and platforms.STEAM_SIDE[tag] then
    if is_console then
      local all_cands = { tag, unpack(all_console_candidates or console_list or {}) }
      local best_p, _, reason = resolve_best(signals, all_cands)
      return result("conflict", best_p, all_cands, true, reason)
    end
    return result("steam", tag)
  end

  if tag then
    if console_conflict then
      local all_cands = { tag, unpack(all_console_candidates or {}) }
      local best_p, _, reason = resolve_best(signals, all_cands)
      return result("conflict", best_p, all_cands, true, reason)
    end
    if console_list and not set_of(console_list)[tag] then
      local all_cands = { tag, unpack(all_console_candidates or console_list) }
      local best_p, _, reason = resolve_best(signals, all_cands)
      return result("conflict", best_p, all_cands, true, reason)
    end
    return result("other", tag)
  end

  if is_console then
    if console_conflict then
      local best_p, _, reason = resolve_best(signals, all_console_candidates)
      return result("conflict", best_p, all_console_candidates, true, reason)
    end
    if console_list and #console_list == 1 then return result("other", console_list[1]) end
    return result("other", nil, console_list)
  end

  if steam then return result("steam-proposed", "steam") end
  return result("unknown", nil)
end

return M
