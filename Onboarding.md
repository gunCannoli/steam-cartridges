# Onboarding in Steam Cartridges

Steam Cartridges fetches nothing for your library until you tell it what to fetch. The first time you open its
settings (Steam's Millennium settings, under **Steam Cartridges**), the **Library Setup** window opens by itself and
walks you through four steps: where Game Info and artwork come from, where achievements come from, which games the
plugin may scan, and then each game one by one. Until you finish it, or choose to skip it, the other settings stay
greyed out and the plugin fetches nothing new. What it already stored keeps showing.

- [The four steps](#the-four-steps)
- [Rules and the size of the scan](#rules-and-the-size-of-the-scan)
- [Confirming your games](#confirming-your-games)
- [Skipping](#skipping)
- [After an update: the new-onboarding prompt](#after-an-update-the-new-onboarding-prompt)
- [After onboarding](#after-onboarding)
- [Starting over for one game](#starting-over-for-one-game)
- [Troubleshooting](#troubleshooting)

## The four steps

The steps along the top of the window unlock in order: each one needs the previous one's answer. You can always go
back, or open a later step you already reached, by clicking it.

### 1. Metadata

Pick where Game Info, artwork and media come from. Each source is a row of its own; turn on at least one to
continue. Nothing is on by default.

| Source | Gives | Needs |
| --- | --- | --- |
| Steam Store Mirror | Steam's own info for a non-Steam game that has a Steam counterpart | nothing |
| SteamGridDB | artwork and icons, fetched automatically | a free key |
| ScreenScraper | Game Info, screenshots and manuals; great for retro games | an account |
| IGDB | Game Info, trailers and artwork; great for retro games | a Twitch Client ID and Secret |

You can change this any time in Settings › Metadata. Saved keys and passwords are encrypted where they rest (your
Windows account on Windows, your desktop keyring on Linux) and are never written anywhere else; keys saved by an
earlier version are converted automatically the first time Steam starts after the update.

### 2. Achievements

How a game's achievements are found. RetroAchievements identifies a game by the **hash of its ROM or disc**, so the
shortcut has to launch a file RetroAchievements knows: a renamed or patched ROM, or a launcher that hides the file,
does not match, and such a game shows "Missing achievements" in the last step, where you can link it by hand.

Unlocks from console emulators (RetroArch, DuckStation, PCSX2, Dolphin and PPSSPP logs, RPCS3 and shadPS4 trophies)
come from the **Emulators** source, and Bloodborne PC and Dusklight from **Native ports**; add them below to turn
them on. The Steam Store Mirror is not an achievements source: Steam's achievements are a list a custom game cannot
unlock, so a game matched to a Steam game asks for RetroAchievements, an achievement pack, or **No achievements**
instead. What each source needs: [Achievements.md](Achievements.md).

### 3. Rules

Which games the plugin may scan. **With no rule the plugin scans nothing**: you decide which games it may touch, so
at least one rule is required to continue.

- **Simple rules:** **Scan only these** or **Exclude these**, by collection name or by game. For example: scan only
  the collection "Retro", or exclude "Demos".
- **Advanced rule:** for a specific case: one service, a game title or a regex pattern. For example:
  RetroAchievements only for the collection "Super Nintendo".

Add them with **Add rule**. The step shows three counts: non-Steam games detected, games your rules ignore, and
games that will be scanned. Above the list, a coloured card says how big the scan is: green (up to 150 games),
yellow (up to 250) or red, asking if that is what you want. It is advice, not a block: a rule is still required,
but any size may continue.

### 4. Games

One row per game waiting to be set up: **Games to set up: N**. Nothing is looked up until you click
**Find matches**: it looks every game up on your sources, one by one, and proposes a match for each shortcut.
Nothing is saved until you confirm.

Confirm each proposed game below. The card shows the facts it was matched on (platform, release year, developer,
genres, collections), so you can check it is the right game before it is fetched. Answer each game, one at a
time:

- **Yes**: the game is fetched at once, with its Game Info filled in on the spot, and the list moves to the next game.
- A wrong proposal: link it by hand instead (with its platform), or skip it for later.
- A game with no achievements: mark it **No achievements**, and it is never asked again.
- **Skip**: the plugin leaves this game alone.

Only the games you confirm are ever downloaded. A confirmed game is never asked again.

## Skipping

The first step carries a **(I know what I'm doing, skip onboarding)** link. It asks for a confirmation first:
onboarding is the one place that shows every option together. If you skip, nothing is chosen for you and the plugin
scans nothing until you add a rule in Settings.

## After an update: the new-onboarding prompt

When an update brings a new onboarding, the first time you open the settings a small window,
**A new onboarding is available**, offers to run it again. Three checkmarks choose what to keep: your saved
credentials, all settings, and the games metadata. **Start from zero** keeps nothing. Nothing is deleted whatever
you choose: what is cleared is moved to a backup folder in the plugin's data folder. **Skip** keeps everything as
it is and never asks again.

## After onboarding

The settings panel's first block, **Library Setup**, stays your way back in:

- **Review your games** opens the same list with each game's answer, and says how many new games wait for you. A
  shortcut added after setup waits here until you confirm it.
- **Refresh library** looks up the games nobody answered yet, and fetches again the confirmed games that miss data.

## Starting over for one game

When an onboarding answer or a fetch goes wrong for one game, delete what the plugin holds about it: **Delete
metadata** at the bottom of its Game Data editor (the Manual Edit window, or the game's Properties ›
**Cartridge** page). It deletes the Game Info, achievements, the match you confirmed and the downloaded media, and
the game is asked again in Library Setup.

## Troubleshooting

- **The settings are greyed out.** Finish the onboarding or skip it: every control except the Library Setup block
  waits until then.
- **The window never opened.** Open it from the settings panel's first block, **Library Setup › Open** (or
  **Start** on a fresh install).
- **A new shortcut gets nothing.** It waits in **Review your games** until you confirm it. The plugin never fetches
  a game you did not validate.
- **A game keeps its wrong details.** Fix it in Manual Edit, or **Delete metadata** for that game and answer it
  again in Library Setup.
- **Something to report.** The log file the plugin writes lists what it did and what each service answered, with
  passwords, keys and your user name removed: see [Reporting a problem](README.md#reporting-a-problem).
