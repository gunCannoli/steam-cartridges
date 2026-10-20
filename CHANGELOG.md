# Changelog

All notable changes to **Steam Cartridges**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0-beta] - 2026-10-20

### Added

- **Achievement packs can use RetroAchievements badges as icons**: an achievement may carry `"ra_icon": "476109"`, the
  badge name from its RetroAchievements page. With a RetroAchievements key in the plugin's `.env`, the plugin fetches the
  badge itself (a few per page view, kept in `ra_badges` in its data folder); without a key, or if the download fails,
  the game's icon is shown as before. Your own icons, the `icons` line and a PS4 dump still come first. The Dusklight
  example pack now names a badge for all 50 achievements.

## [0.5.0-beta] - 2026-10-20

### Added

- **Achievement packs**: give a non-Steam game achievements with one short JSON file in
  `millennium/config/steam-cartridges/packs` inside your Steam folder: the program the shortcut starts, where the game
  writes its achievements, and the list (names, descriptions; secret, rarity and platinum if you want them). No plugin
  update is needed for a new port. The plugin finds the achievements in the game's file whatever its layout (JSON, INI,
  logs). Packs are used only when no other source gives the game achievements, except that a pack as complete as a
  built-in port (Bloodborne, Dusklight) replaces it, so a pack can update one. Icons: numbered PNGs in a folder named after
  the pack, the game's own icon folder, or your PS4 dump found beside the game. Settings → **Achievement packs** lists your
  packs and their problems, imports a file and reloads the folder, looking the games up again at once; the game's
  Cartridge page shows which pack it uses and whether its files are found. How to write one:
  [ACHIEVEMENT-PACKS.md](ACHIEVEMENT-PACKS.md), with two examples.

### Fixed

- **Achievements without an icon show a picture**: the game's own icon, or a trophy badge, in the achievements list, the
  unlock toast and the Activity feed, instead of an empty square (Dusklight's achievements have no icons).
- **Two native ports' games no longer share one achievement list**: Bloodborne and Dusklight were stored under the same
  key, so with both in the library one could show the other's list. Each is now stored under its own key; a game stored
  the old way is built again once, its unlocks kept.
- **An emulated game is never linked to a Steam game by its title alone**: "God of War" in PCSX2 is the PS2 game, not
  Steam's 2018 one. Besides the emulator programs already known, this now covers PPSSPP's Windows build
  (`PPSSPPWindows64`), `mame64`, ePSXe, PCSX, Lime3DS, the Switch forks, bsnes, higan, Cxbx, Stella, Yabause and Kronos,
  and any shortcut whose command line or launch options name a ROM or disc image, whatever starts it (a frontend, or a
  script such as EmuDeck's launchers). A link made earlier stays until you change it in the Game Data editor.

## [0.4.0-beta] - 2026-10-20

### Added

- **Dusklight (Twilight Princess PC port) achievements**: a shortcut that launches `Dusklight.exe` gets the game's 50
  achievements, unlocked from its own `achievements.json` (`%APPDATA%\TwilitRealm\Dusklight`, the older `Dusk` folder, or
  `data` beside the exe). Unlock times are when the plugin first sees them; reset clears the file's unlocked flags. Counters
  show as unlocked only.
- **A log file for bug reports**: `millennium/config/steam-cartridges/steam-cartridges.log` inside your Steam folder
  (512 KB, one older copy as `.log.1`). It holds what the plugin did: the services set up (yes/no, never a value), one
  line per web request (source, status, time, the start of an error body), why a game's Game Info came from IGDB,
  ScreenScraper or the empty fallback, and why RetroAchievements found or missed a game (ROM, hash, GameID, credentials
  present). Passwords, keys, tokens and your Windows user name are removed before anything is written, so the file can be
  shared as it is.
- **Adding an account says whether it connected.** After you add IGDB, ScreenScraper, SteamGridDB or RetroAchievements
  the plugin signs in once to check it. A refused account is not kept and the popup says why; a connected one stays open
  and tells you the library is being fetched in the background (it takes a few minutes).
- **A Cartridge page in a game's Properties window.** Right-click a non-Steam game > Properties > **Cartridge** shows the
  game's data to edit right there (Game Info, controller support, players, achievements, and the Steam, IGDB and
  ScreenScraper links), the same form as the Game Data editor, in one column.
- **The log times every achievements save** (one `[store]` line with its size and milliseconds), so a slow store would show up in a bug report.

### Fixed

- **Games added before IGDB or ScreenScraper was set up now get their Game Info when you add it.** They had been saved
  with an empty record that counted as done, so the new account only worked for games added afterwards (or after
  removing and re-adding the game). Empty records are looked up again as soon as a source is available.
- **The fetch progress bar is at the top of the settings panel**, where a theme that resizes or re-lays out the panel
  can no longer push it out of sight.
- **The log hides every saved account name, key and secret wherever it appears**, plus your Steam account id (also on the very first line of a session) and email
  addresses.
- **The settings panel keeps its layout under custom CSS.** A theme that turns the panel into a grid of narrow columns
  (a "Centred Library Manager" style) split each section's cards into separate columns; every section is now one
  full-width column whatever the container does.

## [0.3.0-beta] - 2026-10-19

### Added

- **Link a game to IGDB or ScreenScraper by its id** in Manual Edit: **Search** shows the game the id belongs to (title,
  platforms, year, developers), **Save** keeps its Game Info as your own edit. ScreenScraper also takes the game page's
  address and is best for console and arcade games.
- **Game Info from both web sources**: when IGDB leaves a field empty (developers, publishers, description, release
  date, genres), ScreenScraper fills it, and the other way round, so one account is enough and two give the most.
- **Loading indicators in Manual Edit**: Steam's spinner and what is running ("Searching ScreenScraper...") while it
  reads your library, loads a game, searches or saves, in the card you used.
- **Removed games are forgotten**: a game removed from your library loses its stored data after a week (your own edits
  and achievement unlocks are kept, in case you add it back).

### Changed

- **Manual Edit opens in its own window, as big as the screen**: your games on the left, with **Only games with
  issues** and a count per game; the game on the right, with its missing Game Info, controller support or achievements
  tinted red. Fix them there, mark a game as having **No achievements** (**Retry achievement detection** undoes it), or
  **Ignore issues** to take it off the list. **Fix issues** in Library Analytics opens the first one.
- **A missing publisher is no longer an issue**: fan games and homebrew often have none.

### Removed

- The **Review** popup of Library Analytics: everything it did is in Manual Edit.

### Fixed

- **The wrong IGDB entry for some games**: re-releases with no data won over the original; entries with developers and
  a summary now win.
- **A game you linked by hand could be matched again by title** at the next refresh; a link is now kept as your own
  edit (Revert undoes it).
- **Manual Edit's list**: a fixed game leaves the "with issues" list, a game removed from the library leaves the list
  while the window is open, and **No achievements** is only offered to a game without any.

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
