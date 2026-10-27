--- steam-cartridges - one table of platforms (Library Setup plan § 4, Q3).
---
--- Every source that takes a platform reads its own id from here, and every signal that names a platform
--- (a title tag, an emulator, a RetroArch core, a ROM extension) names one of these ids. Pure data, no I/O.
---
--- A platform: { id, name, tags = { aliases a title may carry in (...) or [...] }, ra = RetroAchievements console id,
--- ss = ScreenScraper systemeid, igdb = { IGDB platform ids } }. `steam` and `pc` are the Steam one.
--- Ids checked against each service by tests/live/probes/platform_ids.lua (Library Setup plan § 8 Q3), 2026-10-22: every
--- `ra` and `igdb` id names its system. `ss` ids are checked only where screenscraper_media.SS_SYSTEM already used them
--- (nes, snes, n64, gc, gba, psx, psp, genesis, arcade); the others are from ScreenScraper's systems list, unchecked.

local M = {}

M.LIST = {
  { id = "steam",     name = "Steam",                tags = { "steam" } },
  { id = "pc",        name = "PC",                   tags = { "pc", "windows", "win", "pc version" }, igdb = { 6 } },
  { id = "nes",       name = "NES",                  tags = { "nes", "famicom", "fc", "nintendo entertainment system" }, ra = 7, ss = 3, igdb = { 18, 99 } },
  { id = "snes",      name = "SNES",                 tags = { "snes", "super nintendo", "super famicom", "sfc", "super nes" }, ra = 3, ss = 4, igdb = { 19, 58 } },
  { id = "n64",       name = "Nintendo 64",          tags = { "n64", "nintendo 64" }, ra = 2, ss = 14, igdb = { 4 } },
  { id = "gc",        name = "GameCube",             tags = { "gc", "gcn", "gamecube", "nintendo gamecube", "ngc" }, ra = 16, ss = 13, igdb = { 21 } },
  { id = "wii",       name = "Wii",                  tags = { "wii", "nintendo wii" }, ra = 19, ss = 16, igdb = { 5 } },
  { id = "wiiu",      name = "Wii U",                tags = { "wii u", "wiiu" }, ra = 20, ss = 18, igdb = { 41 } },
  { id = "switch",    name = "Switch",               tags = { "switch", "nintendo switch", "ns", "nsw" }, ss = 225, igdb = { 130 } },
  { id = "gb",        name = "Game Boy",             tags = { "gb", "game boy", "gameboy" }, ra = 4, ss = 9, igdb = { 33 } },
  { id = "gbc",       name = "Game Boy Color",       tags = { "gbc", "game boy color", "gameboy color" }, ra = 6, ss = 10, igdb = { 22 } },
  { id = "gba",       name = "Game Boy Advance",     tags = { "gba", "game boy advance", "gameboy advance" }, ra = 5, ss = 12, igdb = { 24 } },
  { id = "nds",       name = "Nintendo DS",          tags = { "nds", "nintendo ds" }, ra = 18, ss = 15, igdb = { 20 } },
  { id = "3ds",       name = "Nintendo 3DS",         tags = { "3ds", "nintendo 3ds" }, ra = 62, ss = 17, igdb = { 37 } },
  { id = "psx",       name = "PlayStation",          tags = { "psx", "ps1", "ps one", "psone", "playstation", "playstation 1", "sony playstation" }, ra = 12, ss = 57, igdb = { 7 } },
  { id = "ps2",       name = "PlayStation 2",        tags = { "ps2", "playstation 2", "sony playstation 2" }, ra = 21, ss = 58, igdb = { 8 } },
  { id = "ps3",       name = "PlayStation 3",        tags = { "ps3", "playstation 3", "sony playstation 3" }, ss = 59, igdb = { 9 } },
  { id = "ps4",       name = "PlayStation 4",        tags = { "ps4", "playstation 4", "sony playstation 4" }, igdb = { 48 } },
  { id = "psp",       name = "PSP",                  tags = { "psp", "playstation portable" }, ra = 41, ss = 61, igdb = { 38 } },
  { id = "vita",      name = "PS Vita",              tags = { "vita", "ps vita", "psvita", "playstation vita" }, ss = 62, igdb = { 46 } },
  { id = "genesis",   name = "Genesis / Mega Drive", tags = { "genesis", "mega drive", "megadrive", "md", "sega genesis", "sega mega drive" }, ra = 1, ss = 1, igdb = { 29 } },
  { id = "sms",       name = "Master System",        tags = { "sms", "master system", "sega master system" }, ra = 11, ss = 2, igdb = { 64 } },
  { id = "gamegear",  name = "Game Gear",            tags = { "gg", "game gear", "sega game gear" }, ra = 15, ss = 21, igdb = { 35 } },
  { id = "segacd",    name = "Sega CD",              tags = { "sega cd", "mega cd", "segacd" }, ra = 9, ss = 20, igdb = { 78 } },
  { id = "32x",       name = "32X",                  tags = { "32x", "sega 32x" }, ra = 10, ss = 19, igdb = { 30 } },
  { id = "saturn",    name = "Saturn",               tags = { "saturn", "sega saturn" }, ra = 39, ss = 22, igdb = { 32 } },
  { id = "dreamcast", name = "Dreamcast",            tags = { "dc", "dreamcast", "sega dreamcast" }, ra = 40, ss = 23, igdb = { 23 } },
  { id = "pce",       name = "PC Engine",            tags = { "pce", "pc engine", "turbografx", "turbografx-16", "tg16" }, ra = 8, ss = 31, igdb = { 86 } },
  { id = "xbox",      name = "Xbox",                 tags = { "xbox", "og xbox" }, ra = 22, ss = 32, igdb = { 11 } },
  { id = "xbox360",   name = "Xbox 360",             tags = { "xbox 360", "x360", "360" }, ss = 33, igdb = { 12 } },
  { id = "atari2600", name = "Atari 2600",           tags = { "atari 2600", "2600", "a2600" }, ra = 25, ss = 26, igdb = { 59 } },
  { id = "arcade",    name = "Arcade",               tags = { "arcade", "mame", "fbneo", "neo geo", "neogeo", "cps1", "cps2", "cps3" }, ra = 27, ss = 75, igdb = { 52, 79, 80 } },
}

M.BY_ID = {}
for _, p in ipairs(M.LIST) do M.BY_ID[p.id] = p end

--- Lower-cased tag text -> platform id.
M.BY_TAG = {}
for _, p in ipairs(M.LIST) do
  for _, t in ipairs(p.tags or {}) do M.BY_TAG[t] = p.id end
end

--- Platform ids that are the Steam release (a PC game).
M.STEAM_SIDE = { steam = true, pc = true }

--- Emulator program (steam_store_emulators.program) -> the platforms it can run. A program missing here, or mapped to
--- an empty list, says "a console, platform unknown" (RetroArch, MAME, Mednafen, ares...).
M.PROGRAMS = {
  pcsx2 = { "ps2" }, ["pcsx2-qt"] = { "ps2" }, -- not "play" (the Play! emulator): too common a launcher name
  duckstation = { "psx" }, swanstation = { "psx" }, epsxe = { "psx" }, pcsx = { "psx" },
  rpcs3 = { "ps3" }, shadps4 = { "ps4" },
  ppsspp = { "psp" }, ppssppwindows = { "psp" }, ppssppwindows64 = { "psp" },
  vita3k = { "vita" },
  yuzu = { "switch" }, ryujinx = { "switch" }, sudachi = { "switch" }, citron = { "switch" }, suyu = { "switch" },
  torzu = { "switch" }, eden = { "switch" },
  dolphin = { "gc", "wii" }, primehack = { "gc", "wii" },
  cemu = { "wiiu" },
  citra = { "3ds" }, azahar = { "3ds" }, lime3ds = { "3ds" },
  melonds = { "nds" }, desmume = { "nds" },
  xemu = { "xbox" }, cxbx = { "xbox" }, xenia = { "xbox360" },
  flycast = { "dreamcast" }, redream = { "dreamcast" }, demul = { "dreamcast" },
  mgba = { "gba", "gb", "gbc" }, vbam = { "gba", "gb", "gbc" }, visualboyadvance = { "gba", "gb", "gbc" },
  snes9x = { "snes" }, bsnes = { "snes" }, higan = { "snes" }, zsnes = { "snes" },
  project64 = { "n64" }, simple64 = { "n64" }, rmg = { "n64" }, mupen64plus = { "n64" },
  fceux = { "nes" }, nestopia = { "nes" }, mesen = { "nes" },
  blastem = { "genesis" }, kega = { "genesis", "sms", "gamegear", "segacd", "32x" }, fusion = { "genesis", "sms", "gamegear", "segacd", "32x" },
  yabause = { "saturn" }, kronos = { "saturn" },
  stella = { "atari2600" },
  supermodel = { "arcade" }, model2emu = { "arcade" },
}

--- RetroArch core (emulator_controllers.core) -> the platforms it can run.
M.CORES = {
  snes9x = { "snes" }, snes9x2010 = { "snes" }, snes9x2005 = { "snes" }, bsnes = { "snes" }, bsnes_hd_beta = { "snes" },
  ["mesen-s"] = { "snes", "gb", "gbc" },
  fbneo = { "arcade" }, fbalpha2012 = { "arcade" }, mame2003_plus = { "arcade" }, mame2010 = { "arcade" },
  mame = { "arcade" }, fbneo_neogeo = { "arcade" }, geolith = { "arcade" },
  mgba = { "gba", "gb", "gbc" }, gpsp = { "gba" }, vba_next = { "gba" }, vbam = { "gba", "gb", "gbc" },
  swanstation = { "psx" }, duckstation = { "psx" }, pcsx_rearmed = { "psx" }, mednafen_psx = { "psx" },
  mednafen_psx_hw = { "psx" },
  fceumm = { "nes" }, nestopia = { "nes" }, mesen = { "nes" }, quicknes = { "nes" },
  genesis_plus_gx = { "genesis", "sms", "gamegear", "segacd" }, picodrive = { "genesis", "sms", "segacd", "32x" },
  blastem = { "genesis" }, gearsystem = { "sms", "gamegear" },
  gambatte = { "gb", "gbc" }, sameboy = { "gb", "gbc" }, gearboy = { "gb", "gbc" },
  mupen64plus_next = { "n64" }, parallel_n64 = { "n64" },
  melonds = { "nds" }, melondsds = { "nds" }, desmume = { "nds" },
  ppsspp = { "psp" },
  mednafen_saturn = { "saturn" }, yabasanshiro = { "saturn" }, kronos = { "saturn" },
  flycast = { "dreamcast" },
  mednafen_pce_fast = { "pce" }, mednafen_pce = { "pce" }, geargrafx = { "pce" },
  dolphin = { "gc", "wii" },
  pcsx2 = { "ps2" }, play = { "ps2" },
  citra = { "3ds" }, azahar = { "3ds" },
  stella = { "atari2600" },
}

--- ROM extension -> platform, only where the extension names one platform (`.iso`, `.bin`, `.chd`, `.zip` do not).
M.EXTENSIONS = {
  sfc = "snes", smc = "snes",
  nes = "nes", fds = "nes",
  gba = "gba", gb = "gb", gbc = "gbc",
  n64 = "n64", z64 = "n64", v64 = "n64",
  nds = "nds", ["3ds"] = "3ds", cia = "3ds",
  md = "genesis", smd = "genesis", gen = "genesis",
  ["32x"] = "32x", sms = "sms", gg = "gamegear", pce = "pce", a26 = "atari2600",
  nsp = "switch", xci = "switch",
  wua = "wiiu", wud = "wiiu", wux = "wiiu", rpx = "wiiu",
  wbfs = "wii", -- not .wad: Doom's data files are .wad too (a gzdoom shortcut read as a Wii game, 2026-10-22)
  gdi = "dreamcast", cdi = "dreamcast",
  pbp = "psp", cso = "psp",
  vpk = "vita",
}

return M
