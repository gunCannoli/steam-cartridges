# Achievements in Steam Cartridges

Steam Cartridges shows achievements for non-Steam games in Steam's own places: the achievements section of the game's
page, the full achievements view (desktop and Big Picture), the unlock toasts, the Post-Game Summary and the play bar's
progress. This page explains where those achievements come from, and what a game in your library needs so that
Steam Cartridges can link it to a source.

- [How a game gets its achievements](#how-a-game-gets-its-achievements)
- [RetroAchievements](#retroachievements) (ROMs in emulators)
- [Steam](#steam) (a non-Steam copy of a game Steam sells)
- [Native PC ports](#native-pc-ports) (Bloodborne PC, Dusklight)
- [RPCS3](#rpcs3-playstation-3) (PlayStation 3)
- [shadPS4](#shadps4-playstation-4) (PlayStation 4)
- [Achievement packs](#achievement-packs) (any other game that keeps its own achievement file)
- [Linking a game by hand](#linking-a-game-by-hand)
- [Troubleshooting](#troubleshooting)

## How a game gets its achievements

Steam Cartridges reads the non-Steam game's shortcut (its **Target** and **Launch Options** in Steam's Properties) and
asks the sources below in this order. The first source that applies to the game answers; a game no source applies to
simply has no achievements section, and nothing is requested for it.

| Order | Source | Applies when | You need |
| --- | --- | --- | --- |
| 1 | Steam | the game is matched to a Steam game | a PC game (not an emulator) |
| 2 | Native PC ports | the shortcut runs a supported port | the port, installed as it ships |
| 3 | RPCS3 | the shortcut points at a PS3 game with its trophy data | RPCS3 |
| 4 | shadPS4 | the shortcut points at a PS4 game with its trophy data | shadPS4 |
| 5 | RetroAchievements | the shortcut's command names a ROM file that exists | a RetroAchievements account |
| 6 | Achievement packs | a pack in your packs folder matches the shortcut's program | a pack file ([Achievement-Packs.md](Achievement-Packs.md)) |

Unlocks reach Steam two ways: when you open the game's page (what the source has now), and **while you play**, when
Steam Cartridges watches the source's files or the emulator's log and shows Steam's own unlock toast.

Secret achievements (PlayStation trophies, Bloodborne's endings and bosses) stay hidden in Steam until you unlock them,
as on a Steam game.

## RetroAchievements

For ROMs played in an emulator: RetroArch, DuckStation, PCSX2, Dolphin, PPSSPP and other emulators that RetroAchievements
supports. Steam Cartridges finds the game on [RetroAchievements](https://retroachievements.org) by the ROM itself, then
shows that game's achievements with your unlocks.

### What you need

1. **A RetroAchievements account.**
2. **Your account in one of these places** (the first one found is used):
   - **An emulator you are signed in to.** Steam Cartridges reads the login RetroArch, DuckStation, PCSX2, Dolphin or
     PPSSPP saved in its own settings; the emulator the shortcut runs is tried first.
   - **Steam Cartridges' settings:** **Achievements → Add source → RetroAchievements**, with your **Username** and your
     **Web API Key** (on retroachievements.org, in your account's settings, under *Keys*). Steam Cartridges keeps them in
     its own data folder and sends them only to retroachievements.org.

   With both, the emulator's login and the Web API Key are used together.
3. **A shortcut whose command names the ROM file.** The ROM path must be in the shortcut's Target or Launch Options,
   and the file must exist. Put paths with spaces in quotes. For example:

   ```text
   Target:          "C:\Emulators\RetroArch\retroarch.exe"
   Launch Options:  -L cores\mgba_libretro.dll "D:\ROMs\GBA\Metroid Fusion (USA).gba"
   ```

   Shortcuts made by Steam ROM Manager, EmuDeck or RetroArch's playlist export have this form already.

### How the game is found

- **By the ROM's hash**, the way RetroAchievements itself identifies a game: the plugin computes the ROM's
  RetroAchievements hash locally (no extra tools) and asks which game it belongs to. Cartridges, `.zip` files, PS1 and
  PS2 discs (`.bin`/`.cue`, `.iso`) and `.m3u` playlists (disc 1) are hashed. A ROM is hashed once and remembered.
- **By title**, only when the ROM cannot be hashed: `.chd` discs, arcade romsets and very large files. The shortcut's
  name is matched against RetroAchievements' list for the console, which is guessed from the emulator, core, folder
  or file extension (PS1, PS2, SNES, NES, Game Boy, Game Boy Advance, N64, GameCube, PSP, DS, Genesis, Master System,
  PC Engine, Dreamcast, Saturn, arcade). Name the shortcut after the game.
- **A ROM that RetroAchievements does not support gets no achievements.** If the hash is known not to match any game
  (a hack, a bad dump, another revision), the title is **not** tried: that ROM would never unlock achievements in the
  emulator either. Use a ROM version RetroAchievements supports, or link the game by hand.

### Unlocks

- Your unlocks come from your RetroAchievements profile when the page opens. Hardcore and softcore unlocks both count.
- **While you play**, unlocks appear as they happen when the emulator writes a log Steam Cartridges can read:
  - **RetroArch:** turn on *Settings → Logging → Log to File*. Logs in RetroArch's `logs` folder (also timestamped
    ones) are read.
  - **DuckStation, PCSX2, Dolphin, PPSSPP:** their log files in their usual folders, or next to the emulator.
- Without a log, new unlocks show the next time you open the game's page.

## Steam

For a non-Steam copy of a game that Steam also sells (a DRM-free copy, a copy from another store). The game uses the
Steam game's own achievement list, icons and global rarity, read from Steam's public pages.

### What you need

1. **A PC game.** With Auto Mode (on by default), every shortcut that does not run an emulator is matched to a Steam
   game. A routing rule can include or exclude games from the **Steam Store Mirror** service.
2. **A match to the right Steam game.** The shortcut's title is matched against the games Steam already knows about,
   then against Steam's store search; near matches are suggestions you accept. You can also link it by hand
   ([below](#linking-a-game-by-hand)).

Emulators and native PC ports are never matched to a Steam game automatically: their shortcut's title is a ROM or a
console game, not a Steam product.

### Unlocks

The Steam source gives the **list**: names, descriptions, icons and global rarity. It does not read your Steam account
(you do not own the game on Steam), so the game shows its full list, all locked.

## Native PC ports

PC ports of console games that record trophies in their own file. The trophy list (names, descriptions, grades,
secret trophies and PlayStation rarity) is built in; the unlocks come from the port's own trophy log.

### Supported ports

| Game | Port | The shortcut runs | Unlocks are read from |
| --- | --- | --- | --- |
| Bloodborne (CUSA03173) | [BloodBorneButPc](https://github.com/Awakenchan/BloodBorneButPc) | `Bloodborne.exe` or `Bloodborne Launcher.exe` | `user\trophies.log` |
| Bloodborne (CUSA03173) | [bloodborne_pc](https://github.com/pyL1nx/bloodborne_pc) | `Bloodborne.exe` or `Play Bloodborne.exe` | `user\trophies.log` |
| The Legend of Zelda: Twilight Princess | [Dusklight](https://github.com/TwilitRealm/dusklight) | `Dusklight.exe` | `%APPDATA%\TwilitRealm\Dusklight\achievements.json`, or `data` beside the exe |

### What you need

1. **The port installed as it ships.** The shortcut's Target must be one of the port's programs above, in the port's own
   folder (Steam Cartridges recognises the port by its engine files next to it).
2. **The port's own trophy log.** Its launcher keeps it in the saves folder: `user` in the port's folder, or the saves
   folder you chose in the launcher. Each player profile has its own log, and the launcher's current profile is used.
3. **For trophy icons, your game dump.** The icons are read from your own dump
   (`sce_sys\trophy\trophy00.trp`, in the game folder you chose in the port's launcher) and shrunk to Steam's
   achievement icon size, once. Without the dump, trophies show without icons, and the icons appear once the dump is
   found. Steam Cartridges ships none of the game's art.

The platinum is added once every base-game trophy is unlocked, as on a PlayStation (The Old Hunters' trophies do not
count). Unlocks show while you play: the log is read during your session.

Dusklight has no trophies: its 50 achievements have no grades, rarity or platinum, and no icons of their own (they show the
game's icon). Its unlock times are when Steam Cartridges first sees them.

Any other port, or an updated list for these, is an [achievement pack](#achievement-packs): no plugin update needed.

## Achievement packs

A pack is a short JSON file you put in `<Steam>\millennium\config\steam-cartridges\packs\`: the program the shortcut
starts, where the game writes its achievements, and the list. Steam Cartridges reads the game's file by itself, whatever its
layout. Packs are used only when no other source gives the game achievements, except that a pack as complete as a
built-in port (Bloodborne, Dusklight) replaces it. Some packs come with the plugin, ready to use (Dusklight, Bloodborne:
[backend/packs](backend/packs)). How to write one: [Achievement-Packs.md](Achievement-Packs.md).

## RPCS3 (PlayStation 3)

For PS3 games in [RPCS3](https://rpcs3.net). The trophy list comes from the game's own trophy data, the unlocks from
RPCS3's trophy save (`TROPUSR.DAT`).

### What you need

1. **The game's `EBOOT.BIN` (or its `PS3_GAME` folder) in the shortcut's command**, for example
   `"C:\Emulators\RPCS3\rpcs3.exe" --no-gui "D:\PS3\Game\PS3_GAME\USRDIR\EBOOT.BIN"`.
2. **The game's trophy data next to it:** a `TROPDIR` folder (in `PS3_GAME`, or up to two folders above the `EBOOT.BIN`)
   holding `TROPCONF.SFM`.
3. **RPCS3's own trophy saves**, created when you earn trophies in it.

RPCS3's log is also read while you play. This source is built from RPCS3's documented formats and is not yet tested on
a real installation; please report what you see.

## shadPS4 (PlayStation 4)

For PS4 games in [shadPS4](https://shadps4.net). The trophy list comes from the game's trophy XML, the unlocks from
shadPS4's trophy save.

### What you need

1. **The game in the shortcut's command:** its `eboot.bin` path, or its title id (`CUSA00000`).
2. **A trophy XML** (`TROP.XML` or `TROPCONF.SFM`) in one of these places: shadPS4's `user\trophy\<title id>` folder (in
   `%APPDATA%\shadPS4` or next to the shadPS4 program), or the game folder's `trophy` or `sce_sys\trophy` folder.
3. **shadPS4's trophy saves**, created when you earn trophies in it.

shadPS4's log is also read while you play. Like RPCS3, this source is not yet tested on a real installation.

## Linking a game by hand

Steam Cartridges settings → **Library Analytics → Manual Edit** opens every game full screen. Turn on **Only games
with issues** (or use **Fix issues**) to see the games missing something; what they miss is tinted red. For a game you
can:

- **Link RetroAchievements:** paste the game's RetroAchievements URL (`https://retroachievements.org/game/1234`) or its
  id. Use this when the automatic match picked the wrong game.
- **Steam link:** search Steam and link the same game, for its achievement list.
- **No achievements:** the game has none; turn achievement detection off for it. **Retry achievement detection** turns
  it back on.
- **Fetch now:** look the game up again now.
- **Ignore issues:** take the game off the issues list without changing anything.

## Troubleshooting

- **No achievements section at all:** no source applies to the shortcut. Check the source's *What you need* above
  (most often: the ROM path is missing from the shortcut's command, or the file was moved).
- **A game that was not found is not looked up again for a day.** Use **Fetch now** in Manual Edit to look it
  up now (after fixing the shortcut, for example). An update of Steam Cartridges that adds a source looks again by itself.
- **RetroAchievements shows nothing:** check that you are signed in (an emulator's login, or the Web API Key in
  Achievements → Add source), and that RetroAchievements supports your ROM's version (its game page lists the supported
  hashes).
- **Unlocks only appear after reopening the page:** turn on the emulator's log file (RetroArch: *Log to File*).
- Report anything else in an [issue](../../issues), with the Steam log lines around it.
