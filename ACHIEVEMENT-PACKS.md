# Achievement packs

An achievement pack gives a non-Steam game achievements from one short file you write or download. It is for PC ports
and fan projects that keep their own achievement file (a native port of a console game, a decompilation, a remake) and
that no other source knows. You need no update of Steam Cartridges: drop the file in a folder, press **Reload**.

- [The folder](#the-folder)
- [Writing a pack](#writing-a-pack)
- [Where the achievements file is: `files`](#where-the-achievements-file-is-files)
- [Icons](#icons)
- [The platinum](#the-platinum)
- [Which pack is used](#which-pack-is-used)
- [Checking a pack](#checking-a-pack)
- [Finding where a game writes its achievements](#finding-where-a-game-writes-its-achievements)

## The folder

```
<Steam>\millennium\config\steam-cartridges\packs\
```

Every `.json` file there is read as a pack. The folder survives updates of the plugin. In Steam's Millennium settings,
**Steam Cartridges → Achievement packs** lists your packs, shows the folder, imports a file into it (**Import a pack...**)
and reads it again (**Reload**). Reload looks up the games your packs match at once: no restart.

## Writing a pack

A pack has four fields:

```json
{
  "id": "dusklight",
  "exe": ["Dusklight.exe"],
  "files": [
    "{game}/data/achievements.json",
    "%APPDATA%/TwilitRealm/Dusklight/achievements.json"
  ],
  "achievements": [
    { "id": "hero_of_twilight", "name": "Hero of Twilight", "description": "Deliver the finishing blow to Ganondorf." },
    { "id": "three_heart_clear", "name": "Hero Mode", "description": "Defeat Ganondorf with only 3 heart containers." }
  ]
}
```

| Field | What to write |
| --- | --- |
| `id` | The pack's name: lower case letters, digits, `-` and `_`. Your stored achievements are filed under it, so keep it. |
| `exe` | The program your Steam shortcut starts, as in its **Target** (`"Dusklight.exe"`, any case). For a common name such as `game.exe`, add its folder: `"Dusklight/game.exe"`. |
| `files` | Where the game writes its achievements (below). |
| `achievements` | The list, **in the game's own order**. Each has a `name` and a `description`. |

Each achievement may also have:

| Field | Meaning |
| --- | --- |
| `hidden` | `true` for a secret achievement: Steam hides it until you unlock it. |
| `rarity` | The percent of players who have it (`22.5`): Steam's "x% of players" line. |
| `platinum` | `true` on the one achievement that unlocks itself when all the others are (below). |
| `id` | Only when the game's file names achievements by its own keys (`"hero_of_twilight"`). Without it, an achievement's id is **its position in the list, starting at 0**: the first is 0, the second 1. Games that number their achievements (`trophy 5 unlocked`) need no `id` at all. |

A pack never says how the game's file is laid out: Steam Cartridges finds your achievements' ids and names in it by
itself. It reads JSON files, INI files, and logs and text files with one unlock per line (`5 1760000000`,
`hero_of_twilight=1`, `Runtime: trophy 5 unlocked`, `Achievement unlocked: Hero Mode`). A line that only reports
progress but names an achievement after a word like "achievement" can be misread as an unlock.

Full examples (Dusklight, Bloodborne) are in [examples/achievement-packs](examples/achievement-packs).

## Where the achievements file is: `files`

| Write | Means |
| --- | --- |
| `{game}` | The folder of the shortcut's program. `..` goes one folder up: `{game}/../saves/trophies.log`. |
| `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`, any `%NAME%`; `~` | Windows' own folders, as in Explorer's address bar. |
| `*` as a whole folder name | Any folder there, for a folder per account: `%APPDATA%/Game/*/achievements.json`. |

List every place the game may use (a portable install, the AppData folder, an older version's folder): all are read, and
an unlock in any of them counts. A file that does not exist yet is fine; most games create it on the first unlock.

## Icons

No field is needed. Each achievement takes the first icon it finds:

1. **Your own icons:** PNG files named by the achievement's position, in a folder named after the pack's id:
   `packs\dusklight\0.png`, `1.png`, ... A folder with only some of them is fine.
2. **The `icons` line**, when the game ships its own icons: `"icons": "{game}/assets/achievements"` (PNG files; files
   named by a number go to that position, otherwise they are taken in name order), or a PS4 trophy file
   (`"icons": "D:/PS4/CUSA01623/sce_sys/trophy/trophy00.trp"`).
3. **Your PS4 game dump, found by itself:** for a PS4 port, Steam Cartridges looks for `sce_sys\trophy\trophy00.trp` in the
   game's folder, the folders inside it and the folders beside it, and uses the one with as many trophy icons as the pack
   has achievements.
4. Otherwise the game's own icon, or a trophy badge.

Icons are PNG only, up to 512 KB each, shrunk to Steam's achievement icon size. Press **Reload** after adding some.

## The platinum

On a PlayStation the console awards the platinum, never the game, so a port's file never says it. Mark it with
`"platinum": true`: it unlocks once every other achievement in the pack is unlocked. A game without a platinum needs none:
Enhanced Notifications shows its own "all achievements" celebration for every game.

## Which pack is used

- **A pack is the last source:** if Steam, RetroAchievements, an emulator's trophies or another plugin already give the
  game achievements, the pack is not used.
- **A pack can update a built-in port** (Bloodborne PC, Dusklight): when it is at least as complete as the built-in list,
  the pack is used instead.
- **Several packs for one game:** the one with the most achievements, then the one with the most details (descriptions,
  rarity, secret flags, a platinum). A more complete pack takes over after **Reload**, and your unlocks move to it.
- **A game you marked "No achievements"** (Manual Edit) stays that way. Its Cartridge page says a pack matches; press
  **Retry achievement detection** there to use it.

## Checking a pack

- **Settings → Achievement packs** lists each pack with the games it is used by. A file that is not a valid pack is listed
  with the problem in plain words (`files[0] is not a full path`, `achievements[3] has no name`).
- **The game's Properties → Cartridge** (or Manual Edit) shows the pack the game uses and each of its files: `found, 3
  unlocked`, `not created yet`, or `can't read this file`.
- **Reset achievements** (Enhanced Notifications) can also clear the game's own file: only what unlocked something is
  removed or turned off, after a backup copy.

## Finding where a game writes its achievements

- Read the port's README or source: search it for "achievement" or "trophy".
- Look in the game's folder, `%APPDATA%` and `%LOCALAPPDATA%` for a folder named after the game or its team, and for a
  file that changes when you unlock something.
- Some ports only print unlocks to their console. If their launcher saves that output to a log file (SpartanPort saves
  it to `user\last_run.log`), the log works as the file.
