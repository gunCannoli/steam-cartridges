# Changelog

All notable changes to **Steam Cartridges**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bloodborne PC trophies**: a shortcut that runs a Bloodborne PC port (Awakenchan's BloodBorneButPc, or pyL1nx's
  bloodborne_pc) gets its 40 trophies in Steam, with PlayStation's rarity, unlocks from the port's trophy log (player
  profiles too) and icons taken from your own game dump. Reset Achievements can clear the port's trophy log (a backup
  is kept). More native ports can be added as they appear.
- **Secret achievements stay secret**: trophies a game marks as hidden (Bloodborne's endings and bosses, PS3 and PS4
  trophies) are hidden in Steam until you unlock them, as on a Steam game.
- **Full Controller Support for console games**: a game IGDB or ScreenScraper lists on a console, a handheld or arcade
  (PlayStation, Xbox, Nintendo, Sega, ...) gets the Full Controller Support badge, unless you chose otherwise for it.

### Fixed

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
