--- Emulator executables: shortcuts that launch these never get an automatic
--- store match (the shortcut title is a ROM, not a Steam game: "God of War" in
--- PCSX2 is the PS2 game, not Steam's 2018 one). A guard against wrong matches,
--- not bucket guessing. A manual mapping still works.
--- A native port whose definition says `store_match = false` counts too (native_ports.lua, ADR-0072).
--- So does a shortcut whose command line or launch options name a ROM or disc image,
--- whatever program starts it (a frontend, or a script such as EmuDeck's launchers).

local M = {}

local EMULATORS = {}
for name in ([[retroarch dolphin primehack cemu pcsx2 rpcs3 duckstation ppsspp
  yuzu ryujinx xemu xenia mame mednafen flycast melonds citra vita3k shadps4
  snes9x mgba vbam visualboyadvance project64 simple64 rmg mupen64plus
  ares bigpemu blastem fusion kega fceux mesen nestopia desmume redream
  demul supermodel model2emu bizhawk openemu azahar eden
  ppssppwindows ppssppwindows64 mame64 epsxe pcsx lime3ds sudachi citron suyu
  torzu bsnes higan zsnes cxbx stella yabause kronos]]):gmatch("%S+") do
  EMULATORS[name] = true
end

--- ROM and disc image extensions. A PC game's command line does not name these.
local ROM_EXTENSIONS = {}
for ext in ([[iso cso chd cue bin gdi cdi m3u pbp rvz gcz wbfs wad nsp xci 3ds cia
  nds gba gbc gb sfc smc nes fds n64 z64 v64 md smd gen 32x sms gg pce a26 a78
  lnx ngp ws wsc vpk zip 7z]]):gmatch("%S+") do
  ROM_EXTENSIONS[ext] = true
end

--- Whether a command line names a ROM or disc image: a file name ending in one of
--- ROM_EXTENSIONS, followed by a quote, a space or the end.
function M.names_rom(cmd)
  for ext in tostring(cmd or ""):lower():gmatch("%.(%w+)[\"'%s]") do
    if ROM_EXTENSIONS[ext] then return true end
  end
  local last = tostring(cmd or ""):lower():match("%.(%w+)$")
  return last ~= nil and ROM_EXTENSIONS[last] == true
end

--- Basename without extension, lowercased. Handles quotes and both slashes.
function M.basename(exe)
  local s = tostring(exe or ""):gsub('"', ""):gsub("\\", "/")
  local base = s:match("([^/]*)$") or s
  return (base:gsub("%.%w+$", ""):lower())
end

--- The program of a command line, as basename(). Steam's Exe field holds the
--- whole command for a RetroArch shortcut (`"...\retroarch.exe" -L core "rom"`),
--- so only the first token (quoted, or up to ".exe", or up to a space) counts.
function M.program(cmd)
  local s = tostring(cmd or ""):gsub("^%s+", "")
  local first = s:match('^"([^"]*)"')
    or s:match("^(.-%.[eE][xX][eE])%s") or s:match("^(.-%.[eE][xX][eE])$")
    or s:match("^(%S*)")
  return M.basename(first)
end

--- `launch_options` is optional: with it, a ROM named there counts too.
function M.is_emulator(exe, launch_options)
  local b = M.program(exe)
  if EMULATORS[b] then return true end
  local port = require("native_ports").for_program(b)
  if port and port.store_match == false then return true end
  -- Suffixed builds: "dolphin-x64", "rpcs3-qt", "pcsx2-qt".
  local head = b:match("^(%w+)[%-_ ]")
  if head ~= nil and EMULATORS[head] == true then return true end
  return M.names_rom(tostring(exe or "") .. " " .. tostring(launch_options or ""))
end

return M
