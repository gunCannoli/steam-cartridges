--- Full Controller Support inferred from how a shortcut launches (parity plan
--- Part F, ADR-0038 addendum). A fixed table, no guessing: a RetroArch core
--- (`-L <core>` in Exe or LaunchOptions, ADR-0003) or a standalone emulator exe
--- maps to true (a console, handheld or arcade system: played with a
--- controller) or false (a keyboard / mouse system). Anything else is nil: not
--- inferred, the "Default to full controller support" setting decides.
---
--- Core names are the `<core>_libretro.info` names in RetroArch's info/ folder
--- (RetroArch's core catalog on the dev machine, read 2026-09-25); the four
--- cores installed there (cores\*.dll) are listed first.

local emulators = require("steam_store_emulators")

local M = {}

local function set(words)
  local t = {}
  for w in words:gmatch("%S+") do t[w] = true end
  return t
end

--- RetroArch cores of consoles, handhelds and arcade boards.
M.CORES_WITH_CONTROLLER = set([[
  snes9x mgba fbneo swanstation
  fceumm nestopia mesen quicknes
  bsnes mesen-s snes9x2010
  genesis_plus_gx picodrive blastem gearsystem
  duckstation pcsx_rearmed mednafen_psx mednafen_psx_hw
  mupen64plus_next parallel_n64
  gambatte sameboy gearboy gpsp vba_next vbam
  melonds melondsds desmume
  ppsspp
  mednafen_saturn yabasanshiro kronos
  flycast
  mednafen_pce_fast mednafen_pce geargrafx
  dolphin
  pcsx2 play
  citra azahar
  fbneo_neogeo fbalpha2012 mame2003_plus mame2010 mame geolith neocd
  stella prosystem handy
  mednafen_wswan mednafen_ngp race mednafen_vb opera virtualjaguar
]])

--- RetroArch cores of keyboard / mouse systems (DOS, ScummVM, NEC PC-88 / PC-98, PC, Mac).
M.CORES_WITHOUT_CONTROLLER = set([[
  dosbox_pure dosbox_core dosbox_svn dosbox
  scummvm
  quasi88 np2kai nekop2
  pcem virtualxt minivmac
]])

--- Standalone emulator programs (steam_store_emulators.lua names) of controller
--- systems. `retroarch` is decided by its core; `mame` also runs computers: not inferred.
M.EMULATORS_WITH_CONTROLLER = set([[
  dolphin primehack cemu pcsx2 rpcs3 duckstation ppsspp yuzu ryujinx
  xemu xenia flycast melonds citra vita3k mednafen shadps4
  snes9x mgba vbam visualboyadvance project64 simple64 rmg mupen64plus
  ares bigpemu blastem fusion kega fceux mesen nestopia desmume redream
  demul supermodel model2emu bizhawk openemu azahar eden
]])

--- Core name from a command line: `-L cores\snes9x_libretro.dll` -> "snes9x".
---@param cmd string
---@return string|nil
function M.core(cmd)
  local s = tostring(cmd or ""):gsub("\\", "/")
  local path = s:match('%-L%s+"([^"]+)"') or s:match("%-L%s+(%S+)")
    or s:match('%-%-libretro[=%s]+"([^"]+)"') or s:match("%-%-libretro[=%s]+(%S+)")
    or s:match('cores/([^/%s]+%.[dD][lL][lL])') or s:match('cores/([^/%s]+%.so)')
  if not path then return nil end
  local base = (path:match("([^/]*)$") or path):lower()
  return (base:gsub("%.%w+$", ""):gsub("_libretro$", ""))
end

--- true (controller system), false (keyboard / mouse system) or nil (unknown)
--- for one shortcuts.lua entry ({ exe, launch_options }).
---@param entry table
---@return boolean|nil
function M.infer(entry)
  if type(entry) ~= "table" then return nil end
  local full_cmd = tostring(entry.exe or "") .. " " .. tostring(entry.launch_options or "")
  local lower = full_cmd:lower()
  local program = emulators.program(entry.exe)
  local head = program:match("^(%w+)[%-_ ]")
  if program == "retroarch" or head == "retroarch" or lower:find("retroarch", 1, true) or lower:find("_libretro", 1, true) then
    local core = M.core(full_cmd)
    if core and M.CORES_WITH_CONTROLLER[core] then return true end
    if core and M.CORES_WITHOUT_CONTROLLER[core] then return false end
    -- If RetroArch is running a standard console/arcade ROM, default to controller
    if lower:find("%.zip") or lower:find("%.7z") or lower:find("%.sfc") or lower:find("%.smc")
      or lower:find("%.nes") or lower:find("%.gba") or lower:find("%.gbc") or lower:find("%.bin")
      or lower:find("%.iso") or lower:find("%.chd") or lower:find("%.cue") then
      return true
    end
    return nil
  end
  if M.EMULATORS_WITH_CONTROLLER[program] or (head and M.EMULATORS_WITH_CONTROLLER[head]) then
    return true
  end
  for emu_name in pairs(M.EMULATORS_WITH_CONTROLLER) do
    if lower:find(emu_name, 1, true) then
      return true
    end
  end
  return nil
end

--- { ["<appid>"] = true|false } for every shortcut with an inference (unknown ones are left out).
--- Stores both unsigned and signed 32-bit int keys so JS lookups never miss.
---@param entries table[]
---@return table<string, boolean>
function M.for_entries(entries)
  local out = {}
  for _, entry in ipairs(entries or {}) do
    local value = M.infer(entry)
    if value ~= nil and entry.appid then
      local u_key = tostring(entry.appid)
      out[u_key] = value
      local num = tonumber(entry.appid)
      if num and num >= 2147483648 then
        local s_key = tostring(num - 4294967296)
        out[s_key] = value
      end
    end
  end
  return out
end

return M
