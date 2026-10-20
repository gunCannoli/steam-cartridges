# Changelog

All notable changes to **Steam Cartridges**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Manual Edit is full screen and shows what each game is missing**: the games on the left, with **Only games with
  issues** and a count per game; the missing Game Info, controller support or achievements of a game are tinted red.
  Fix them there, link the right RetroAchievements, Steam or IGDB entry, mark a game as having **No achievements**, or
  **Ignore issues** to take it off the list. **Fix issues** in Library Analytics opens the first one.

- **Link a game to ScreenScraper** from Manual Edit: enter its id (or its page address), check the game it finds
  (title, platforms, year, developers) and save its Game Info (best for console and arcade games). IGDB is linked by
  its id the same way.
- **Game Info from both web sources**: when IGDB leaves a field empty (developers, publishers, description, release
  date, genres), ScreenScraper fills it, and the other way round, so one account is enough and two give the most.
- **Removed games are forgotten**: a game removed from your library loses its stored data after a week (your own
  edits and achievement unlocks are kept, in case you add it back).
- **Loading indicators in Manual Edit**: a search, a link, a save or Fetch now shows Steam's spinner and what is
  running ("Searching ScreenScraper...") in the card you used, until it is done; opening Manual Edit and choosing a
  game show it too while their data loads.
- **A game you link to IGDB or ScreenScraper stays linked**: the link is kept as your own edit (Revert undoes it); before,
  the next refresh could match the title to another game.

### Fixed

- **The wrong IGDB entry for some games** (re-releases with no data won over the original); entries with developers
  and a summary now win.
- **Manual Edit's issues**: a fixed game leaves the "with issues" list, a missing publisher is no longer an issue, a
  game removed from the library leaves the list while the window is open, and "No achievements" is only offered to a
  game without any.

### Removed

- The **Review** popup of Library Analytics: everything it did is in Manual Edit.

## [0.2.0-beta] - 2026-10-19

### Added

- **Bloodborne PC trophies**: a shortcut that runs a Bloodborne PC port (Awakenchan's BloodBorneButPc, or pyL1nx's
  bloodborne_pc) gets its 40 trophies in Steam, with PlayStation's rarity, unlocks from the port's trophy log (player
  profiles too) and icons taken from your own game dump. More native ports can be added as they appear.
- **Secret achievements stay secret**: trophies a game marks as hidden (Bloodborne's endings and bosses, PS3 and PS4
  trophies) are hidden in Steam until you unlock them, as on a Steam game.
- **Full Controller Support for console games**: a game IGDB or ScreenScraper lists on a console, a handheld or arcade
  (PlayStation, Xbox, Nintendo, Sega, ...) gets the Full Controller Support badge, unless you chose otherwise for it.

- **A ready-to-use download** on the Releases page: no build needed.
- **[Achievements.md](Achievements.md)**: what each achievements source needs to link a game.

### Fixed

- **Your own artwork is kept**: a game matched to Steam no longer replaces a portrait, hero, logo or wide capsule you
  set yourself; only empty ones are filled.
- **Linking a game to IGDB by hand failed** every time (Game Data editor); it now fetches the game's data.
- **A shortcut whose achievements were not found stayed that way for a day** after an update that can read them; it is
  checked again right away.
- **A softcore RetroAchievements unlock showed as locked**: the profile lookup asked for hardcore unlocks only; it now takes
  both modes, and a refetch no longer drops an unlock already stored.

## [0.1.0-beta] - 2026-10-19

First public beta, for testing. Expect rough edges; please report what you find.

### Added

- **Steam's own app page for any non-Steam game**, on the desktop and in Big Picture: hero and capsule art, the Play bar
  (last played, play time), the Game Info tab (description, developer, publisher, franchise, release date, category
  badges) and the Post-Game Summary and Recordings and Screenshots built from the captures Steam already took.
- **Game Info from the best source available**: a Steam Store match first, then IGDB or ScreenScraper; your own edits
  (Manual Edit) always win.
- **Artwork**: a Steam match brings the native portrait, hero, logo and wide art; other games get artwork and a library
  icon from SteamGridDB.
- **Achievements for non-Steam games**: RetroAchievements for ROMs (hashed locally, no extra tools), RPCS3 and shadPS4
  trophies and the emulator logs it recognises, shown in Steam's own achievements page with Steam's unlock toasts and
  progress bars. Reset Achievements in the settings.
- **Community tab content**: trailers, artwork and game manuals (with a ScreenScraper account).
- **Collections ("buckets") and routing rules**: choose per collection or per game which sources are used.
- **Extension API** for other plugins to push Game Info, screenshots, achievements and unlocks
  (`steam-cartridges-third-party` and `steam-cartridges-local` use it).

### Notes

- A Steam Store match replaces art you set in the native portrait, hero, logo and wide slots; **Clear** in the settings
  removes the match and only the art this plugin wrote.
- Epic and Xbox games, Steam API emulators and PC-game log reading live in separate plugins, not here.
- The Activity feed's "{Username} captured" cards come from the separate Steam Captured Activity plugin.
