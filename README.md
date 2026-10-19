# Steam Cartridges

A [Millennium](https://steambrew.app) plugin that makes non-Steam games feel like native Steam games.

If you use Steam as a gaming-console style hub (living in Big Picture, with your emulators, PC games and launchers all
in one library), a non-Steam game normally looks like a second-class citizen: a bare page with a grey "information is
unavailable" box. Steam Cartridges gives every non-Steam game the same rich app page a Steam game has, using Steam's
own components, on the desktop **and** in Big Picture.

> **Beta.** Steam Cartridges is in public beta (0.1.0-beta). It is tested on my own library, not yours: expect rough
> edges and please report what you find in an [issue](../../issues) with the Steam log lines (`logs/`) around it.

## Features

- **Steam's own app page for any non-Steam game:** hero and capsule art, the Play bar with last played and play time,
  the Game Info tab (description, developer, publisher, franchise, release date, category badges), and the
  Post-Game Summary and Recordings and Screenshots built from the captures Steam already took.
- **Game Info from the best source available:** a Steam Store match first, then IGDB or ScreenScraper, and your own
  edits always win. Edit any game by hand with Manual Edit.
- **Artwork:** a Steam match brings the native portrait, hero, logo and wide art; games without one get artwork and a
  proper library icon from SteamGridDB.
- **Achievements for non-Steam games:** RetroAchievements for ROMs (hashed locally, no extra tools), RPCS3 and shadPS4
  trophies, the Bloodborne PC port's trophies (with their icons from your own dump), and the emulator logs it recognises. They show in Steam's own achievements page, with Steam's own unlock
  toasts and progress bars. What each source needs: [Achievements.md](Achievements.md).
- **Community tab content:** trailers, artwork and game manuals (with a ScreenScraper account) as cards in the
  Community section.
- **Nothing is rebuilt:** the plugin restores the sections Steam hides from shortcuts and feeds Steam's own stores, so
  it looks, navigates and feels like the real thing, controller included.

[![A Game Boy Advance game's page with Steam's native hero, achievements, Game Info and Post-Game Summary](.github/example.png)](.github/example.png)

## Install

Requires [Millennium](https://steambrew.app). Build from source (Node.js 20+):

```bash
npm install
npm run build
```

Then copy the folder (with the generated `.millennium` folder inside it) to `<Steam>/millennium/plugins/steam-cartridges`,
restart Steam and enable **Steam Cartridges** in the Millennium settings.

## Setup

It works on its own with no setup: install it and your non-Steam games get Steam's page and Post-Game Summary from the
captures Steam already has. The rest is opt-in, in Steam's Millennium settings under **Steam Cartridges**:

- **Metadata:** add your IGDB (Twitch), SteamGridDB or ScreenScraper credentials with **Add service**.
- **Collections ("buckets"):** put games in a collection and assign the collection in the settings.
  - **Steam Store:** the game borrows Steam's own data. The title is matched against native games Steam already knows,
    then against Steam's store search; near matches are suggestions you accept.
  - **Web Scraping:** the game gets Game Info from IGDB or ScreenScraper.
- **Routing rules:** choose per collection or per game which sources are used.

Game Info from the web runs only for games in a collection you assigned to **Web Scraping**, so until you assign one,
no game gets web Game Info.

For your screenshots and recordings as "{Username} captured" cards in the Activity feed, install
[Steam Captured Activity](https://github.com/gunCannoli/steam-captured-activity) next to it.

## Notes

- **Your art is replaced for Steam Store matches:** a match sets the native portrait, hero, logo and wide art on the
  shortcut, replacing art you set in those slots. **Clear** in the settings removes the match and only the art this
  plugin wrote, and remembers the rejection.
- **Requests are rare and polite:** web requests only happen for games in the Steam Store and Web Scraping buckets, at
  most one per second, and downloaded media stays on disk (the "Keep downloaded media" setting).
- **Your data stays local:** the plugin stores its records (Game Info, matches, credentials) in
  `millennium/config/steam-cartridges` inside your Steam folder; nothing is sent anywhere except the lookups above.

## About

Makes non-Steam games feel native: Steam's own app page from your captures, plus optional metadata, artwork and
achievements.

## License

MIT
