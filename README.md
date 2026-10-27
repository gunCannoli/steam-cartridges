# Steam Cartridges

A [Millennium](https://steambrew.app) plugin that makes non-Steam games feel like native Steam games.

If you use Steam as a gaming-console style hub (living in Big Picture, with your emulators, PC games and launchers all
in one library), a non-Steam game normally looks like a second-class citizen: a bare page with a grey "information is
unavailable" box. Steam Cartridges gives every non-Steam game the same rich app page a Steam game has, using Steam's
own components, on the desktop **and** in Big Picture.

## Features

- **Steam's own app page for any non-Steam game:** hero and capsule art, the Play bar with last played and play time,
  the Game Info tab (description, developer, publisher, franchise, release date, category badges), and the
  Post-Game Summary and Recordings and Screenshots built from the captures Steam already took.
- **Game Info from the best source available:** a Steam Store match first, then IGDB or ScreenScraper, and your own
  edits always win. Edit any game by hand with Manual Edit.
- **Artwork:** a Steam match brings the native portrait, hero, logo and wide art; games without one get artwork and a
  proper library icon from SteamGridDB.
- **Achievements for non-Steam games:** RetroAchievements for ROMs (hashed locally, no extra tools), RPCS3 and shadPS4
  trophies, the Bloodborne PC (with icons from your own dump) and Dusklight ports' achievements, and the emulator logs it recognises. They show in Steam's own achievements page, with Steam's own unlock
  toasts and progress bars. What each source needs: [Achievements.md](Achievements.md).
- **Achievement packs:** give any other game achievements with one short file: the program, where the game writes its
  achievements, and the list. No plugin update needed; the plugin reads the game's file whatever its layout. Some packs
  come included and work as they are (Dusklight), and Manual Edit can give any game a pack. How: [Achievement-Packs.md](Achievement-Packs.md).
- **Community tab content:** trailers, artwork and game manuals (with a ScreenScraper account) as cards in the
  Community section.
- **Nothing is rebuilt:** the plugin restores the sections Steam hides from shortcuts and feeds Steam's own stores, so
  it looks, navigates and feels like the real thing, controller included.

[![A Game Boy Advance game's page with Steam's native hero, achievements, Game Info and Post-Game Summary](.github/example.png)](.github/example.png)

## Install

Requires [Millennium](https://steambrew.app).

1. Download `steam-cartridges-<version>.zip` from the [latest release](../../releases).
2. Extract it into `<Steam>/millennium/plugins/`, so the plugin is in `<Steam>/millennium/plugins/steam-cartridges`.
3. Restart Steam and enable **Steam Cartridges** in the Millennium settings.

To update, replace that folder with the new release's. Your settings and data are kept (they live in Steam's
`millennium/config` folder, not in the plugin's).

<details>
<summary>Build from source instead</summary>

Node.js 20+:

```bash
npm install
npm run build
```

Then copy the folder (with the generated `.millennium` folder inside it) to `<Steam>/millennium/plugins/steam-cartridges`.

</details>

## Setup

It works on its own with no setup: install it and your non-Steam games get Steam's page and Post-Game Summary from the
captures Steam already has. The rest is in Steam's Millennium settings under **Steam Cartridges**:

- **Onboarding:** the first time you open the plugin's settings, a window walks you through your sources,
  achievements and rules before anything is downloaded. Until you finish it, or choose
  **(I know what I'm doing, skip)**, the other settings wait and the plugin fetches nothing new (what it already stored
  keeps showing). You need at least one source on and at least one rule (**Scan only these** or **Exclude these**; with
  no rule the plugin scans nothing). Full walkthrough: [Onboarding.md](Onboarding.md).
- **Metadata:** add your IGDB (Twitch), SteamGridDB or ScreenScraper credentials with **Add source**. Game Info and
  artwork from the web need at least one of them.
- **Achievements:** RetroAchievements finds a game by the hash of its ROM or disc, so the shortcut has to launch a file
  RetroAchievements knows. Steam's own achievements are a list only and cannot be unlocked in a custom game, so the Steam
  Store Mirror is not an achievements source.
- **Rules decide everything:** with no rule the plugin scans nothing. Routing Rules start simple: **Scan only these** or
  **Exclude these**, by collection or game; an **Advanced rule** covers a specific case (one service, a title, a regex). All of
  them start from **Add rule**.
  Once a game is in scope it is looked up by what its shortcut runs:
  - **Emulators and ROMs** (RetroArch, DuckStation, PCSX2, ...): Game Info from IGDB, then ScreenScraper.
  - **PC games:** a match to the same game on Steam first (Steam's own Game Info and artwork), else IGDB.
- **Advanced rules** include or exclude games from a
  service (Steam Store Mirror, IGDB, ScreenScraper, SteamGridDB, RetroAchievements, Console Emulators) by **collection**,
  **game title** or a **regex pattern**. **Scan only these** leaves out every game it does not match.
- **Manual Edit** (Library Analytics): every game full screen. **Show** lists any Analytics group (metadata, achievements, ignored, issues), with counts, so you can work through each group; the games missing
  Game Info, controller support or achievements, with what they miss tinted red; fill it in, link the right Steam, IGDB
  ScreenScraper or RetroAchievements entry, mark a game as having **No achievements**, or **Ignore issues**. Your own Game Info for a
  game always wins.

**Your artwork stays yours.** A portrait, hero, logo, wide capsule or icon you set yourself in Steam is never replaced:
Steam Cartridges only fills the empty ones (and replaces only art it put there itself).

First run: [Onboarding.md](Onboarding.md). Achievements and what each source needs: [Achievements.md](Achievements.md).

For your screenshots and recordings as "{Username} captured" cards in the Activity feed, install
[Steam Captured Activity](https://github.com/gunCannoli/steam-captured-activity) next to it.

## Notes

- **Requests are rare and polite:** web requests only happen for games in the Steam Store and Web Scraping buckets, at
  most one per second (plus the achievement icons of a pack that names RetroAchievements badges, only if you have set up a
  RetroAchievements key), and downloaded media stays on disk (the "Keep downloaded media" setting).
- **Your data stays local:** the plugin stores its records (Game Info, matches, credentials) in
  `millennium/config/steam-cartridges` inside your Steam folder; nothing is sent anywhere except the lookups above.

## Reporting a problem

Send the log file: `<your Steam folder>\millennium\config\steam-cartridges\steam-cartridges.log`.
On Linux that is `<your Steam folder>/millennium/config/steam-cartridges/steam-cartridges.log`, usually
`~/.local/share/Steam/millennium/config/steam-cartridges/steam-cartridges.log` (or under `~/.steam/steam/`). It is **not** in
Millennium's own folders (`~/.config/millennium`, `~/.local/share/millennium`); Millennium keeps no log folder there. Its first
line `[startup]` names your OS and this exact folder.
It lists what the plugin did and what each service (IGDB, ScreenScraper, RetroAchievements, SteamGridDB) answered.
Passwords, keys, tokens and your user name (Windows or Linux) are removed before anything is written.

## Support

If this plugin is useful to you, you can support its development on [Ko-fi](https://ko-fi.com/cannoligun).

## About

Makes non-Steam games feel native: Steam's own app page from your captures, plus optional metadata, artwork and
achievements.

## License

MIT
