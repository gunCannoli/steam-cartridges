--- steam-cartridges - native ports of Bloodborne (CUSA03173). Engine and contract: native_ports.lua (ADR-0072).
---
--- Both ports run the player's own dump on a shadPS4-derived runtime that appends "<id> <unix seconds>" to
--- <saves>/trophies.log on each unlock (their launchers read and write the same file: Core/Trophies.cs,
--- launcher/bbport_trophies.py). Their launchers keep settings in %APPDATA%\bbport-launcher\settings.json, whose
--- `user_dir` moves the saves folder; Awakenchan's launcher adds player profiles in <saves>/profiles/<name>.
--- The dump's trophy00.trp keeps the list encrypted, so it is built in: PSN's text, secret flags and rarity
--- (PSN order, PSNProfiles, read 2026-10-19), keyed by the PS4 ids the runtime logs. Icons come from the dump.

local GAME = {
  key = "CUSA03173",
  title = "Bloodborne",
  title_id = "CUSA03173",
  auto_platinum = true,
  trophies = {},
}

-- id, grade, DLC (The Old Hunters), secret, PSN rarity %, name, description
for _, t in ipairs({
  { 0, "P", false, false, 22.24, "Bloodborne", "All trophies acquired. Hats off!" },
  { 1, "G", false, true, 28.31, "Yharnam Sunrise", "You lived through the hunt, and saw another day." },
  { 2, "G", false, true, 31.71, "Honoring Wishes", "Captivated by the Moon Presence, you pledge to watch over the Hunter's Dream." },
  { 3, "G", false, true, 32.48, "Childhood's Beginning", "You became an infant Great One, lifting humanity into its next childhood." },
  { 4, "G", false, true, 23.40, "Yharnam, Pthumerian Queen", "Defeat Yharnam, Blood Queen of the Old Labyrinth." },
  { 5, "G", false, false, 24.36, "Hunter's Essence", "Acquire all hunter weapons." },
  { 6, "G", false, false, 28.45, "Hunter's Craft", "Acquire all special hunter tools." },
  { 7, "S", false, false, 38.17, "Weapon Master", "Acquire a weapon of the highest level." },
  { 8, "S", false, false, 33.56, "Blood Gem Master", "Acquire an extremely precious blood gem." },
  { 9, "S", false, false, 46.94, "Rune Master", "Acquire an extremely precious Caryll Rune." },
  { 10, "S", false, true, 42.58, "Cainhurst", "Gain entry to Cainhurst, the lost and ruined castle." },
  { 11, "S", false, true, 39.73, "The Choir", "Gain entry to the realm of the Choir, the high stratum of the Healing Church." },
  { 12, "S", false, true, 44.93, "The Source of the Dream", "Discover the abandoned old workshop, the source of the Hunter's Dream." },
  { 13, "S", false, true, 47.76, "Nightmare Lecture Building", "Gain entry into the Byrgenwerth lecture building, that drifts within the realm of nightmare." },
  { 14, "B", false, true, 62.80, "Father Gascoigne", "Defeat the beast that once was Father Gascoigne." },
  { 15, "B", false, true, 53.38, "Vicar Amelia", "Defeat the beast that once was Vicar Amelia." },
  { 16, "B", false, true, 49.69, "Shadow of Yharnam", "Defeat the Shadow of Yharnam." },
  { 17, "B", false, true, 48.31, "Rom, the Vacuous Spider", "Defeat Great One: Rom, the Vacuous Spider." },
  { 18, "B", false, true, 45.64, "The One Reborn", "Defeat the One Reborn." },
  { 19, "B", false, true, 43.41, "Micolash, Host of the Nightmare", "Defeat Micolash, Host of the Nightmare." },
  { 20, "B", false, true, 42.53, "Mergo's Wet Nurse", "Defeat Great One: Mergo's Wet Nurse." },
  { 21, "B", false, true, 65.57, "Cleric Beast", "Defeat Cleric Beast." },
  { 22, "B", false, true, 56.09, "Blood-starved Beast", "Defeat Blood-starved Beast." },
  { 23, "B", false, true, 51.52, "The Witch of Hemwick", "Defeat the Witch of Hemwick." },
  { 24, "B", false, true, 46.46, "Darkbeast Paarl", "Defeat Darkbeast Paarl." },
  { 25, "B", false, true, 41.48, "Amygdala", "Defeat Great One: Amygdala." },
  { 26, "B", false, true, 40.28, "Martyr Logarius", "Defeat Martyr Logarius." },
  { 27, "B", false, true, 38.58, "Celestial Emissary", "Defeat Great One: Celestial Emissary." },
  { 28, "B", false, true, 36.93, "Ebrietas, Daughter of the Cosmos", "Defeat Great One: Ebrietas, Daughter of the Cosmos." },
  { 29, "B", false, false, 64.43, "Blood Gem Contact", "Acquire a blood gem that imbues hunter weapons with special strength." },
  { 30, "B", false, false, 56.27, "Rune Contact", "Acquire a Caryll Rune that endows hunters with special strength." },
  { 31, "B", false, false, 56.08, "Chalice of Pthumeru", "Acquire the Chalice of Pthumeru that seals the catacombs that form a web deep below Yharnam." },
  { 32, "B", false, true, 41.48, "Chalice of Ailing Loran", "Acquire the Chalice of Ailing Loran that seals the tragic land lost to the sands." },
  { 33, "B", false, true, 36.93, "Chalice of Isz", "Acquire the Great Chalice of Isz that seals the home of the cosmic kin." },
  { 34, "G", true, false, 32.10, "Old Hunter's Essence", "Acquire all old hunter weapons." },
  { 35, "S", true, true, 42.71, "Orphan of Kos", "Defeat Great One: Orphan of Kos." },
  { 36, "B", true, true, 49.88, "Ludwig, the Holy Blade", "Defeat the beast that was once Ludwig, the Holy Blade." },
  { 37, "B", true, true, 47.13, "Lady Maria of the Astral Clocktower", "Defeat Lady Maria of the Astral Clocktower." },
  { 38, "B", true, true, 47.65, "Living Failures", "Defeat the failed attempts to become Great Ones." },
  { 39, "B", true, true, 40.22, "Laurence, the First Vicar", "Defeat the beast that was once Laurence, the First Vicar." },
}) do
  GAME.trophies[#GAME.trophies + 1] = { id = t[1], grade = t[2], dlc = t[3], hidden = t[4], global_pct = t[5], name = t[6], description = t[7] }
end

local function str(v) return type(v) == "string" and v or "" end

--- The launcher's settings (both ports' launchers use this file on Windows).
local function settings(port)
  local appdata = port.getenv("APPDATA")
  return appdata and port.json(port.expand(appdata) .. "/bbport-launcher/settings.json") or {}
end

--- The saves folder: the launcher's `user_dir`, else <port>/user (a source build: <port>/engine/user when only it has a
--- log), then the current player profile's folder (Awakenchan: profiles are `player_profiles`, "|"-separated).
local function saves(port)
  local s = settings(port)
  local dir = str(s.user_dir)
  if dir ~= "" then
    dir = port.expand(dir)
  else
    dir = port.root .. "/user"
    if not port.exists(dir .. "/trophies.log") and port.exists(port.root .. "/engine/user/trophies.log") then
      dir = port.root .. "/engine/user"
    end
  end
  local profile = str(s.player_profile)
  if profile ~= "" and profile:lower() ~= "main" then
    for name in str(s.player_profiles):gmatch("[^|]+") do
      name = name:match("^%s*(.-)%s*$")
      if name:lower() == profile:lower() then return dir .. "/profiles/" .. name end
    end
  end
  return dir
end

local UNLOCKS = { format = "id_time_log", files = function(port) return { saves(port) .. "/trophies.log" } end }

--- The dump's trophy pack: the launcher's `game_dir`, else a CUSA03173 folder or a dump (a folder with eboot.bin) in
--- or beside the port.
local function trophy_pack(port)
  local rel = "/sce_sys/trophy/trophy00.trp"
  local game = str(settings(port).game_dir)
  if game ~= "" and port.exists(port.expand(game) .. rel) then return port.expand(game) .. rel end
  for _, base in ipairs({ port.root, port.parent(port.root) }) do
    if base then
      if port.exists(base .. "/" .. GAME.title_id .. rel) then return base .. "/" .. GAME.title_id .. rel end
      for _, d in ipairs(port.list_dirs(base)) do
        if port.exists(d .. "/eboot.bin") and port.exists(d .. rel) then return d .. rel end
      end
    end
  end
  return nil
end

return {
  {
    id = "bloodborne_awakenchan",
    name = "Bloodborne PC",
    url = "https://github.com/Awakenchan/BloodBorneButPc",
    programs = { "bloodborne", "bloodborne launcher", "bb-start", "bb-probe" },
    -- A release keeps the engine in engine/out; a source build in out/.
    markers = { "engine/out/bb-probe.exe", "out/bb-probe.exe" },
    controller = true,
    store_match = false,
    game = GAME,
    unlocks = UNLOCKS,
    trophy_pack = trophy_pack,
  },
  {
    id = "bloodborne_pyl1nx",
    name = "Bloodborne PC (bbport)",
    url = "https://github.com/pyL1nx/bloodborne_pc",
    programs = { "bloodborne", "play bloodborne", "bb-play", "bb-probe" },
    -- packaging/windows/package.sh: Bloodborne.exe and Play Bloodborne.exe at the top, the engine in bin/.
    markers = { "bin/bb-probe.exe" },
    controller = true,
    store_match = false,
    game = GAME,
    unlocks = UNLOCKS,
    trophy_pack = trophy_pack,
  },
}
