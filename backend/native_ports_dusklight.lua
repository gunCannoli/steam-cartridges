--- steam-cartridges - native port of The Legend of Zelda: Twilight Princess (Dusklight). Engine and contract: native_ports.lua.
---
--- Dusklight (https://github.com/TwilitRealm/dusklight, src/dusk/achievements.cpp, read 2026-10-19, release v2.0.3) keeps
--- its own achievements in <data dir>/achievements.json: one object, `"<key>": { "progress": n, "unlocked": bool,
--- "extra": ... }` per achievement, no unlock time. The data dir is %APPDATA%\TwilitRealm\Dusklight (the docs name it
--- for mods; the older build used ...\Dusk and migrates), or a `data` folder beside the exe in portable mode. A custom
--- data path set in the game's settings is not read. The 50 achievements are built in (the game has no schema file);
--- ids are the game's own keys. There are no trophies: no grades, no rarity, no platinum, no icons.

local GAME = {
  key = "dusklight",
  title = "The Legend of Zelda: Twilight Princess",
  points = 10,
  trophies = {},
}

-- key, name, description (the game's own text; counters carry their goal in the text)
for _, a in ipairs({
  -- Challenge
  { "hero_of_twilight", "Hero of Twilight", "Deliver the finishing blow to Ganondorf." },
  { "three_heart_clear", "Hero Mode", "Defeat Ganondorf with only 3 heart containers." },
  { "completionist", "Completionist", "Complete the game after collecting all equipment, heart containers, portals, bugs, poes, and hidden skills." },
  { "cave_of_ordeals", "Conqueror of Ordeals", "Clear all 50 floors of the Cave of Ordeals." },
  { "cave_of_ordeals_heartless", "Indomitable", "Clear all 50 floors of the Cave of Ordeals with only 3 heart containers." },
  { "speedrun_12h", "Been There Done That", "Defeat Ganondorf with a total save file play time under 12 hours." },
  { "speedrun_8h", "Swift Blade", "Defeat Ganondorf with a total save file play time under 6 hours." },
  { "no_deaths_clear", "Deathless", "Defeat Ganondorf with 0 deaths on your save file." },
  { "untouchable", "Untouchable", "Kill 25 enemies in a row without taking damage." },
  -- Collection
  { "princess_of_bugs", "The Princess of Bugs", "Deliver all 24 golden bugs to Agitha." },
  { "all_poes", "Poe Collector", "Collect all 60 Poe Souls." },
  { "hylian_loach", "Legendary Catch", "Obtain the Hylian Loach in your fishing journal." },
  { "all_fish", "Gone Fishin'", "Obtain all 6 species of fish in your fishing journal." },
  { "a_big_heart", "A Big Heart", "Reach maximum health with all 20 heart containers." },
  { "all_bottles", "Glassware Guardian", "Obtain all 4 bottles." },
  { "all_hidden_skills", "Master of Secrets", "Learn all 7 Hidden Skills." },
  { "all_letters", "We Deliver!", "Collect all 16 postman letters." },
  -- Minigame
  { "plumm_max", "Thank You Berry Much", "Score 61,454 points in the Plumm minigame." },
  { "rollgoal_8", "Rollgoal Novice", "Complete the first 8 rollgoal stages." },
  { "rollgoal_all", "Lost Your Marbles", "Complete all rollgoal stages." },
  { "goat_30s", "Ranch Hand", "Herd all 20 goats into the pen in under 30 seconds." },
  { "goat_20s", "Bane of Howard", "Herd all 20 goats into the pen in under 20 seconds." },
  { "goat_18s", "King of the Ranch", "Herd all 20 goats into the pen in under 18 seconds." },
  { "snowboard_70s", "Downhill Dash", "Finish the snowboarding minigame in under 70 seconds." },
  { "canoe_perfect", "River Raider", "Achieve a perfect score in the canoe minigame." },
  { "star_2_under_40s", "Rising Star", "Complete the STAR Prize 2 minigame in under 40 seconds." },
  { "star_2_under_30s", "Shooting Star", "Complete the STAR Prize 2 minigame in under 30 seconds." },
  -- Misc
  { "dark_hammer_one_hit", "Mortal Edge", "Defeat Darkhammer in a single hit." },
  { "bow_100m_hit", "Long Shot", "Hit an enemy from over 100 meters away with the bow." },
  { "rollstab_triple", "Surgical Skewer", "Kill 3 enemies with a single rollstab." },
  { "friendly_fire", "Friendly Fire", "Get hit by your own cannonball." },
  { "long_jump_attack", "Long Jump Attack", "Travel more than 15 meters in a single jump attack before landing." },
  { "email_me", "Email Me", "Read a letter during the Dark Beast Ganon fight." },
  { "heavy_hitter", "Heavy Hitter", "Wear the Iron Boots during the end credits." },
  { "fishing_rod_ganondorf", "Here Fishy Fishy", "Confuse Ganondorf with the fishing rod." },
  { "steal_from_trill", "Petty Theft", "Steal from Trill." },
  { "cucco_control", "Cucco Whisperer", "Take control of a cucco." },
  { "ganondorf_3hit", "Autospin Annihilation", "Finish off Ganondorf in the final duel after only 3 attacks." },
  -- Glitched
  { "back_in_time", "Back in Time", "Perform the Back in Time glitch to play on the title screen." },
  { "early_master_sword", "Early Master Sword", "Obtain the Master Sword before completing Midna's Desperate Hour." },
  { "earliest_master_sword", "Earliest Master Sword", "Obtain the Master Sword before meeting Midna." },
  { "speedrun_4h", "Hero of Time", "Defeat Ganondorf with a total save file play time under 4 hours." },
  { "no_fish_suit", "No Fish Suit No Problem", "Defeat Morpheel without equipping Zora Armor." },
  { "null_item", "Null Item", "Obtain the mysterious black rupee in the item wheel." },
  { "stallord_skip", "Stallord Skip", "Leave Stallord's arena through the exit without defeating Stallord." },
  { "lakebed_before_lanayru", "White Midna Glitch", "Clear the Lakebed Temple before clearing Lanayru's Twilight." },
  { "early_hidden_village", "Quick Detour", "Rescue the Hidden Village before clearing Goron Mines." },
  { "forest_temple_no_boomerang", "Must Have Been The Wind", "Complete the Forest Temple without obtaining the Gale Boomerang." },
  { "early_city", "Early City", "Obtain the Double Clawshots without obtaining the Dominion Rod." },
  { "early_kakariko", "Gorge Skip", "Collect the Kakariko warp portal without warping the gorge bridge." },
}) do
  GAME.trophies[#GAME.trophies + 1] = { id = a[1], name = a[2], description = a[3] }
end

return {
  {
    id = "dusklight",
    name = "Dusklight",
    url = "https://github.com/TwilitRealm/dusklight",
    programs = { "dusklight*" },
    markers = { "Dusklight.exe", "{exe}" },
    controller = true,
    store_match = false,
    game = GAME,
    unlocks = {
      format = "key_flags_json",
      files = function(port)
        local out = { port.root .. "/data/achievements.json" } -- portable mode
        local appdata = port.getenv("APPDATA")
        if appdata then
          appdata = port.expand(appdata)
          out[#out + 1] = appdata .. "/TwilitRealm/Dusklight/achievements.json"
          out[#out + 1] = appdata .. "/TwilitRealm/Dusk/achievements.json" -- the build before the rename
        end
        -- Linux (unconfirmed, no log yet): SDL's per-user data folder, where the game keeps the same files
        local data = port.getenv("LOCALAPPDATA")
        if data then out[#out + 1] = port.expand(data) .. "/TwilitRealm/Dusklight/achievements.json" end
        return out
      end,
    },
  },
}
