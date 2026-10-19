--- Emulator executables: shortcuts that launch these never get an automatic
--- store match (the shortcut title is a ROM, not a Steam game). A guard against
--- wrong matches, not bucket guessing. A manual mapping still works.

local M = {}

local EMULATORS = {}
for name in ([[retroarch dolphin primehack cemu pcsx2 rpcs3 duckstation ppsspp
  yuzu ryujinx xemu xenia mame mednafen flycast melonds citra vita3k shadps4
  snes9x mgba vbam visualboyadvance project64 simple64 rmg mupen64plus
  ares bigpemu blastem fusion kega fceux mesen nestopia desmume redream
  demul supermodel model2emu bizhawk openemu azahar eden]]):gmatch("%S+") do
  EMULATORS[name] = true
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

function M.is_emulator(exe)
  local b = M.program(exe)
  if EMULATORS[b] then return true end
  -- Suffixed builds: "dolphin-x64", "rpcs3-qt", "pcsx2-qt".
  local head = b:match("^(%w+)[%-_ ]")
  return head ~= nil and EMULATORS[head] == true
end

return M
