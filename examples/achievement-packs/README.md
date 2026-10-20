# Example achievement packs

Two packs written from the plugin's built-in ports, to copy or adapt (the format: [ACHIEVEMENT-PACKS.md](../../ACHIEVEMENT-PACKS.md)).
To use one, copy it into `<Steam>\millennium\config\steam-cartridges\packs\` and press **Reload** in the settings.

| File | Shows |
| --- | --- |
| `dusklight.json` | A game whose file names achievements by its own keys: every achievement has an `id`. Three places the file may be. |
| `bloodborne.json` | A game that numbers its trophies: no `id`s (the position is the number), secret trophies, rarity and the platinum. One pack for both PC ports. |

Both games already have built-in support; a pack as complete as the built-in one replaces it, so these also show how to
update a built-in game. The Bloodborne pack reads the default saves folders only (the built-in one also follows the
launcher's settings and player profiles).
