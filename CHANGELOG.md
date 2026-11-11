# Changelog

All notable changes to **Steam Cartridges**.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0-beta] - 2026-11-11

### Added

- **Onboarding UX and Library Analytics streamlining.**
  - Removed redundant "Not looked up yet" card from Step 4 when inspecting unlooked-up games.
  - Dynamic bulk confirmation chunk ramp-up: initial validation batches start small (5, then 10, then 25; `validateChunkSize`) so progress displays immediately instead of lingering at 0.
  - Real-time remaining time estimation (ETA) added to bulk confirmation, fetching, and sweep status rows (`Confirming X of Y (~15s remaining)...`, `Fetching...`, `Looking up...`).
  - Manual RetroAchievements link confirmation feedback: added a 5-second delay before library and dropdown list refreshes so users can read the confirmation, and changed the highlight overlay/card border from issue red (`ISSUE_TINT`) to success green (`SUCCESS_TINT_BORDER` `#a4d007`).
  - Removed redundant "Refresh or Review your games" banner from settings panel; games needing setup are cleanly tracked in the "Games to set up" count in the Library Setup section.
  - Replaced standalone "Fix issues" block and `GameDataEditor` modal with interactive Library Analytics counts: clicking "Games with issues", "Metadata Match", or "Achievements Detected" opens Library Setup Step 4 filtered by that category, while clicking "Non-Steam Games" or "Games Ignored" opens Step 3 Rules setup.
  - Removed "Edit MetaData" block from Library Analytics; manual editing is accessible directly through Step 4 / Cartridges properties.
- **Smarter platform sensor weighting and conflict resolution (Phase D).** Implemented hierarchical signal reliability weighting (`choice` [100] > `port` [80] > `core` [70] > `program`/`rom` [65] > `tag` [50] > `path` [20] > `collection` [15] > `steam` [10]) in `platform_verdict.lua`. Hard technical execution signals (emulators, cores, ROM extensions, native ports) supersede soft ambient signals (folders, collections) naturally without brittle manual family trees. Platform conflicts no longer abort lookups or discard proposals; the detection cascade resolves the winning platform candidate from signal weights, queries metadata/artwork/achievements across sources, builds the proposal, and marks it as disputed (`disputed = true`). Disputed proposals are classified under the certainty scale as `Uncertain` (▮▯▯▯) or `Possible` (▮▮▯▯) with clear reasons explaining which platform was favored over conflicting signals. Multi-system emulators and native ports with unspecified platforms automatically refine their system from metadata release lists.

### Fixed

- **Native port and achievement pack matching (e.g. Bloodborne PC).** Added `platform = "ps4"` to Bloodborne port definitions (`bloodborne_awakenchan` and `bloodborne_pyl1nx`), resolving platform ambiguity. In `library_service.lua`, native port and achievement pack checks now automatically match achievements during detection, confirmation, and scanning, populating the schema and resolving missing achievements for native ports.
- **Step 4 filter dropdown count mismatch and reactive list pruning on resolution.** In `step-games.tsx`, removed forced inclusion of the active game (`|| r.appid === appid`) from `shown`. The game list now strictly honors the active filter, matching the count displayed in the filter dropdown. Resolving achievements in the editor triggers real-time list re-scans that immediately remove the resolved game from the missing achievements filter view and advance selection.
- **Circuit breaker rate-limit pause bypass for manual actions and 60-second backoff.** In `net.lua`, explicit user-initiated actions (`consent > 0` or `{ force = true }`) bypass the circuit breaker pause, preventing manual RetroAchievements linking from being blocked by preceding bulk confirmation rate limits. In addition, 429 pause backoff was reduced from 30 minutes to 60 seconds, and successful responses immediately clear active pauses.
- **Step 4 validated games view displays full metadata editor cards.** Returning to Step 4 on a validated game now renders the complete metadata editor forms (Game Info, achievements, and sources) instead of a redundant "Validated / The plugin fetches this game" placeholder card.
- **Library Setup bulk confirmation feedback, badge duplication, and RetroAchievements link resilience.** Bulk confirmation now provides immediate visual progress feedback ("Confirming 0 of N...") instead of waiting for the first chunk to complete. Duplicate checkmarks on Step 4 badges were resolved by cleaning the confirmation text to "Confirmed · Achievements missing". During bulk confirmation, RetroAchievements source links (`choice.ra_game_id`, `choice.achievements = "ra"`) and `achievements_store` keys are now persistently recorded even if initial schema downloads encounter rate limits (HTTP 429) or transient network drops. In addition, `row(e)` falls back to `choice.achievements` when store records are pending, preventing confirmed games from misreporting missing achievements.
- **Game Data editor Achievements card layout and row spacing.** Reordered the Achievements card so RetroAchievements link inputs appear before Achievement Packs. Reduced excessive vertical spacing between description text and action controls for both the RetroAchievements URL input and the Achievement Pack dropdown.
- **Platform conflict false positive for console families (e.g. Cemu / .wua in a collection named "Wii").** Generic console family collection and folder tags (`wii`, `playstation`, `xbox`, `game boy`) now expand to their entire family of systems (`wiiu` + `wii`, `psx`..`ps4`, `xbox` + `xbox360`, `gb`..`gba`). An explicit emulator like Cemu running a `.wua` archive now cleanly resolves to Wii U without conflicting with a broader "Wii" collection tag. In addition, when signals do conflict, candidate platforms are preserved in `candidates` rather than discarded.
- **Unresponsive platform dropdown and incorrect default in conflict resolution modal and link cards.** Replaced Steam's internal `Dropdown` in modal dialogs and game link cards with a clean `Select` component that opens reliably across all modal overlays and popup windows without context menu event interception issues. Default platform pre-selects the first candidate from the game's detected signals (or inferred platform) rather than defaulting to `"steam"`, and one-click candidate pills allow instant selection of detected platforms.
- **Library Setup step 4: removed misleading '(out of scope)' count from header title and aligned certainty strip.** Step 4 title now cleanly reads `Games to set up: N` without repeating the out-of-scope games that were already excluded in Step 3. The certainty strip received matching horizontal padding (`16px`) so its badges align flush with the field description and label above.
- **Settings panel layout cleaned up and aligned with guardrail 18.** Removed the orphaned, buttonless "Finish onboarding or skip it to change settings" row that previously rendered as an isolated second card under Library Setup. The "Onboarding required" button description now succinctly explains both purpose and gating ("Set up sources and rules for your non-Steam games before changing settings.").
- **Settings refresh banner hidden during first-time onboarding.** The "Refresh or Review your games" banner now checks `onboarded === true` before rendering, avoiding confusion on new installations. When displayed, its label is streamlined to "Refresh or Review your games" with the count in the description ("N games need your attention.").
- **Text inputs across Sources and Achievements modals collapsed and clipped text.** Text inputs (`TextRows`) now ensure `.DialogInput_Wrapper` and inner inputs expand to full responsive width (`100%`) across all modal sizes. Removed the negative `margin-bottom` offset that was clipping the bottom edge of the input. Retained standard 38px minimum height paired with symmetric `padding: 8px 12px` and `line-height: normal` to guarantee that font baselines and glyph descenders are cleanly centered. Composite rows with trailing action buttons use an integrated flush track (`gap: 0`, `align-items: stretch`).
- **Add Source modal buttons were hidden after adding a source.** Kept `Add` and `Cancel` visible after each addition while sources remain available to allow adding multiple sources sequentially.
- **Library Setup step 4 removed redundant 'not looked up' indicators.** Excluded pending games from the top certainty strip and suppressed the certainty card row when a game has not been looked up yet, reducing noise.
- **Library Setup timeline clicks were intercepted by Steam's window drag region.** The top portion of the navigation buttons was under Chromium's window drag area; clicking there dragged the window instead of changing steps. Added `WebkitAppRegion: "no-drag"` to the timeline and buttons so the entire block is clickable.
- **Library Setup games count in step 2 (Rules) vs step 4 (Games) agreed only when zero games had existing data.** Step 2 now displays "Games already set up: X" when existing/validated games exist and warns on the games that will actually be scanned (`toScan`), matching Step 4's "Games to set up: Y (X already set up, Z out of scope)".
- **Add Source popup kept the added source in its dropdown until reopen.** The dropdown options now update immediately in state upon addition, removing the added service and selecting the next available candidate.
- **ScreenScraper credentials text inputs were not vertically centered, and the password visibility button was misaligned.** Input text is now vertically centered, and the visibility toggle eye button matches the text input height (`38px`) and top alignment with zero margin offset.
- **A shortcut's page opened with Game Info expanded; an owned game's opens collapsed.** Steam starts every shortcut's Game Info open, but behind the ⓘ "Show / Hide game details" button for owned games. A shortcut now starts collapsed like an owned game and the ⓘ button opens it (checked live, both ways).
- **No game was found when Steam's placeholder folder `userdata/0` was the newest one.** The plugin took it for the account, so `shortcuts.vdf` was "NOT FOUND", the library scanned as 0 games and nothing was fetched (log: `user 0`, `entries=0`). The folder `0` is no longer an account, and when `loginusers.vdf` does not name one, an account folder that holds a `shortcuts.vdf` is preferred over a newer one without.

- **A game with no logo on Steam no longer logs a warning.** Steam has no logo for some apps (Escape from Tarkov's store page has none), so the logo's 404 is now an info line; the other artwork slots are written as before and a missing portrait, hero or wide image still warns.

### Added

- **Platform conflict detection, dedicated badge, and resolution modal in Library Setup step 4.** Games whose platform signals disagree (e.g. collection console tag vs executable path/core) now show as `⚠ N conflict` in the certainty strip instead of being mislabeled as "no match". Certainty strip items are interactive; clicking the conflict badge opens a conflict resolution modal displaying the disagreeing signals, providing a platform picker, and an immediate "Resolve & Look up" action to run detection with the chosen platform before the main sweep. A "Platform conflicts" filter was also added to the "Show" dropdown.
- **Library Setup step 3 (Rules): clickable category counts reveal the games in each bucket.** Users can click on the count badges for "Non-Steam games detected", "Games that will be ignored", "Games already set up", and "Games that will be scanned" (with interactive hover styling, tooltip, and pointer cursor) to open a scrollable modal showing the list of games in that group with platform and collection tags, plus a search filter for quick inspection.
- **The signed-in user decides whose library file is read.** Steam's own window knows who is signed in; the plugin now takes that account first (then `loginusers.vdf`, then the newest folder that holds a `shortcuts.vdf`). With several accounts on one PC and no user marked in `loginusers.vdf`, the wrong account's non-Steam games could be read. The log line says `via=signed-in` and warns when `loginusers.vdf` names someone else.
- **The start-up log says how Steam's user folders look, and warns about anything odd.** One `[startup] steam folders:` line (which rule picked the user; whether `loginusers.vdf` is there, how many users it lists and how many are marked most-recent; how many `userdata` account folders exist, how many hold a `shortcuts.vdf`, whether the placeholder folder `0` is there; whether `config` exists) and one `[WARN]` line per inconsistency (no `loginusers.vdf`, no user in it, users but none marked, a named user with no folder, no account with a `shortcuts.vdf`, several accounts with one). Counts and yes/no only, no ids or paths. A report from a custom, portable or emulated Steam install now shows what is different without asking the reporter for a file.
- **Settings: the "Activity Feed" section is now "General", with a "Show Game Info" toggle** (setting `showGameInfoByDefault`, off by default, so Steam's own behaviour is kept). On: Game Info opens on every game's page, owned games included, and the pages already open change at once. Off: it stays behind the ⓘ button for a shortcut and an owned game alike, also when you go straight from one game to another (Steam kept the previous game's state there). The start-up log's options line says `game-info-open=on|off`.

### Changed

- **Optimized Step 4 bulk confirmation and detection.**
  - **Batched IGDB queries**: `web_igdb.fetch_by_ids` batches all IGDB lookups across each chunk into a single Apicalypse HTTP request (`where id = (...)`), eliminating dozens of individual sequential HTTP requests during bulk confirmation.
  - **Eliminated confirmation double-fetching**: Validation no longer marks newly saved metadata and achievements as forgotten in `fresh_policy`, preventing `fetchGames` and `startSync` from re-downloading the same games 2–3 times over the internet.
  - **Bulk record preloading**: `fetchGames` preloads all newly confirmed records in a single bulk disk read (`metadata.preload()`), eliminating hundreds of serialized IPC round-trips.
  - **Larger chunk size**: Increased `VALIDATE_ALL_CHUNK` from 10 to 25 to reduce total chunking iterations by 60%.
  - **Pruned redundant RetroAchievements patch queries during Detect**: `ra_info` (`r=patch`) is now only called as a fallback when developer, genre, or release year are missing, skipping hundreds of unnecessary patch downloads when IGDB or Steam already supply the metadata.
- **Library Setup step 4 and Game Editor UX polish.**
  - Merged confirmation label into `✓ Confirmed · Achievements missing` when achievements are missing, removing redundant subtitle lines.
  - Removed redundant `No achievements found` card in Step 4 when inspecting games with missing achievements.
  - In single-column mode (`single` / Step 4), hid the top diagnostic summary card (`Missing: Achievements / Fetch now / Ignore issues`).
  - In single-column mode (`single`), reordered editor cards dynamically: games with missing achievements display `AchievementsCard` at the top before `DetailsCard`; games with no match display external source linking cards (`Steam`, `IGDB`, `ScreenScraper`) at the top before `DetailsCard`.
  - Renamed the achievement bypass button in `AchievementsCard` from `No achievements` / `This game has none: turn achievement detection off for it` to `Ignore Achievements` / `Skips fetching achievements for this game` with action label `Ignore`.
- **Concurrent async library detection and batched validation disk writes.** Finding matches (`detectAll`) in Step 4 now runs across a pool of concurrent workers (5 in parallel) with live progress, cutting full library detection times by ~80%. Bulk validation (`validate_all`) batches disk writes (`game_choices.json`, `proposals.json`, `freshness.json`) to write once per chunk instead of writing to disk for every individual game, eliminating thousands of disk operations during bulk confirmation.
- **Background ingest during bulk confirmation.** In Step 4 bulk confirmation, metadata fetching runs concurrently across 5 workers and immediately updates the status banner (`✓ Confirmed N games.`) upon completion; asset synchronization (artwork, captures, store data) is handed off to background ingest rather than blocking the modal on the final game.
- **Removed technical 'The platform comes from a signal' text.** Streamlined the match explanation in Step 4 certainty cards by removing internal technical diagnostic wording.
- **Library Setup step 4: Certainty levels, filtering, and layout improvements.** Renamed match confidence scale to `Certain` (▮▮▮▮), `Likely` (▮▮▮▯), `Possible` (▮▮▯▯), and `Uncertain` (▮▯▯▯). Replaced `Needs you` in the filter dropdown with individual certainty options ordered worst-first (`Uncertain` > `Possible` > `Likely` > `Certain`), hiding zero-count levels. Clicking a certainty pill filters the dropdown and game list to that level. Step 4's left filter card now starts directly with "Filter by name or collection", with the filter dropdown right below the text input.
- **Onboarding and Library Setup modal height enlarged.** Increased modal height scale to `0.8` (~30% taller) for better vertical space across all steps.
- **Bulk confirm locking and live fetch progress.** Clicking "Confirm all proposed" now greys out and disables the games list and metadata cards while confirmation and fetching run. The progress indicator dynamically updates through both validation and data fetching (`Fetching X of Y: Game Name...`), ending cleanly with `✓ Confirmed N games.`
- **RetroAchievements arcade hashing (rcheevos) & manual link hash verification.** Arcade ZIP archives (such as FBNeo romsets) are now hashed by romset name according to rcheevos `rc_hash_arcade`, resolving RetroAchievements matches out of the box. Manually linking a game to RetroAchievements now inspects the ROM hash and reports whether the hash was verified, unmapped, or unhashable.
- **Settings changes and startup never trigger background scraping (Phase B of Review queue plan).** Editing sources or routing rules no longer starts an automatic library-wide fetch; it marks the library stale and displays an "N games could be refreshed" banner in Settings with a Review button opening Library Setup at step 4. Startup sync is strictly count-only, logging `startup: N detected, A in scope, B out, C need you, D set up` without walking or fetching any shortcuts.
- **Library Setup, step 4: every game shows how sure the plugin is about its match.** A signal-strength mark, a word and a colour (Verified, High, Medium, Low, No match; Confirmed, Not looked up and Skipped for the rest) in the list, a count per level under "Games to set up", and the reasons ("The title matches exactly", "The platform was guessed from the source's release list", "A source did not answer") on the game's card and in the row's tooltip. Computed from what Detect already stored, nothing new is saved or fetched, and the answers (Yes / No / Skip, Confirm all) work as before; this is the first phase of the Review queue plan (`docs/plans/steam-cartridges-review-queue-plan.md`).
- The start-up line for a native port now also says how many bytes of its achievements file were read (`read=1 (1234 bytes)`), so a report can tell an empty file from a file with nothing unlocked.

## [0.6.12-beta] - 2026-11-08

### Fixed

- **0.6.11-beta crashed at every Steam start with a Dusklight shortcut.** The new startup check of Dusklight's achievement files tried to read the places where no file exists, and Millennium's backend crashes when that happens while the plugin is starting. The plugin then never came up ("plugin not running"). The empty places are now skipped, and the startup checks of achievement files run once Steam's window has loaded.

## [0.6.11-beta] - 2026-11-07

### Added

- **The log says why a part of a game's page is empty.** New lines:
  - each start says how the previous one ended and whether it counts towards safe mode;
  - each native port reports whether its achievement file was found, and how many unlocks were read;
  - the Activity feed reports what it showed for a game, and why "Played for the first time" or the achievements were left out (no play time in Steam, no captures, unlocks with no time);
  - a game with no achievement source lists which sources were checked;
  - a game you open that the routing rules leave out is reported;
  - "nothing to walk" says how many games the rules leave out and whether Steam's collections had loaded.

### Fixed

- **Safe mode no longer turns on after a quick restart.** Starting Steam twice within a minute, or Steam starting its page over on its own, counted as two crashes, and the next start switched most of the plugin off (only captures and sections stayed). A start that got going and ran 10 seconds without an error now counts as fine, even when Steam closes it without notice. An install stuck in safe mode by an older version starts normally.
- **The Activity feed on a Steam beta stopped with `GetNewestActivityTime is not a function`.** The plugin's stand-in activity entry now has that step. Once Steam's own activity entry has been seen, the plugin uses Steam's class for the rest of the session, so a later Steam change can't break the stand-in the same way.
- **A game's achievements are looked up again when a source can answer now.** A game once marked "no achievement source" kept that answer for a day, even after its shortcut was pointed at a native port, an emulator or a ROM. Each start now checks these games again.

## [0.6.10-beta] - 2026-11-07

### Changed

- **The log starts fresh instead of growing for ever.** A start finds a log older than 2 days or bigger than 256 KB and moves it to `steam-cartridges.log.1`; the file you send holds this session and a recent one. A short, recent log is kept, so a restart to retry a bug does not hide the session that showed it. The size cap is now 1 MB (it was 2 MB).

### Fixed

- **A Steam beta showed "An error occurred while rendering this content" on a game's page** (`TypeError: Cannot read properties of undefined (reading 'map')` in the Activity feed). The "Added to library" and "Played for the first time" events were built on Steam's screenshot-event class without its constructor; the newer Steam asks that class `screenshots.length > 0` before drawing, and the list did not exist. The events now carry their own answer and an empty list. Found from the tester's stack trace, checked against the beta's code (build 1794022194).

## [0.6.9-beta] - 2026-11-07

### Added

- **The log now says why a Steam page failed to render.** A report of "An error occurred while rendering this content" (Steam's own error box on a game page) came with a log that said nothing about it:
  the plugin's warnings and errors went to Steam's console only. New `[render]` lines carry: an error that reached the window, React's own report naming the component that failed and its parents,
  every `logger.warn` / `logger.error` of the plugin (for example "Could not feed AchievementsFullStore"), and after the first one a `context:` line with the shape of the game being viewed (achievements listed,
  malformed, without icon; media items; which parts are ok), which features are off and which surfaces had trouble. Numbers and feature names only: no title, path or URL. Repeats are counted, not repeated.
- **The log header names the Steam client build** (`[system] steam client: build=...`), read from Steam's own package manifest, so a UI report can be tied to a Steam version.
- **More disc formats find their RetroAchievements game.** PlayStation, PlayStation 2, PSP and Dreamcast games in `.chd` (CD and DVD CHDs, every compression chdman uses), `.cso`, `.gdi` and `.pbp`
  files are hashed the way RetroAchievements does, next to `.iso`, `.bin` and `.cue`. Only the parts of a big image the hash needs are read.
- **The log says why a game could not be hashed**, for example `hash-fail(.chd:chd_codec_cdzs)` (never a file name).

### Fixed

- **PlayStation and PlayStation 2 games now find their RetroAchievements game.** The plugin hashed the boot file's bytes only; RetroAchievements also hashes its name and, for PlayStation, only the
  size its header gives, so no PlayStation disc ever matched. Now checked against RetroAchievements' own hasher. Hashes remembered from earlier versions are dropped once.
- **A game launched from a `.cue` file is hashed from the disc image the cue names**, not from the cue's own text (first `FILE` line, quoted or not, Windows or Linux separators). A `.m3u` playlist
  that lists `.cue` files works too. A cue with no track, no `FILE` line or a missing image is reported in the log instead of producing a wrong hash.
  Reported in [issue #1](https://github.com/gunCannoli/steam-cartridges/issues/1) by lsalazarm99.

## [0.6.8-beta] - 2026-10-31

### Changed

- **Saved keys and passwords are kept as plain text in the plugin's data folder again.** The plugin only ever stores them on your own computer
  and sends each one to its own service, so the extra layer was not worth what it cost. On Linux the keys file is readable by you only.
- **Keys saved by an earlier version are brought over automatically.** The first time Steam starts after the update, every key the plugin had
  stored in the keyring (Linux) or protected with your Windows account is moved into the new format. Nothing for you to do. A key that cannot be
  opened (another Windows user, another PC) is named in the log; add it again in Settings.

### Removed

- **The desktop keyring (`secret-tool`) is no longer used.** It made some Linux setups ask for the keyring password every time Steam started, and the
  plugin waited for that prompt before it could start. If your keyring is locked, the unlock prompt appears one last time while your keys are brought
  over, and never again. `secret-tool` is no longer needed and no longer shown in the log's `[host]` line.

## [0.6.7-beta] - 2026-10-31

### Added

- **Achievement files are found by name, not only by path.** After the known locations, the plugin looks in your user folders (AppData,
  `~/.config`, `~/.local/share`, Documents, Flatpak apps) and the game's own folder for any folder named like the game (Dusklight:
  "dusklight") and, in it, a file named like its achievements file, a few folders down. Every achievement pack gets this too (its `id`
  and file names), and a pack can steer it with `"discover": { "folders": [...], "files": [...] }`. One `[ports]` line says when the search,
  not a known path, found the file.
- **The log opens with the plugin and its version, then the machine.** The first line of every session is `---- steam-cartridges <version> ----`
  (repeated at the top of a rotated or cut log), and a `[system]` line follows with the OS and its build, CPU architecture and count,
  installed memory, language code and Lua build. No host name, user name, path or serial.

### Fixed

- **Every backend call now takes a signed appid.** The Linux 0.6.6-beta logs showed Fetch now, the start-up sync and Link doing nothing:
  each `[sync]` line read `identity=none, metadata=none, achievements=none`, no SteamGridDB, RetroAchievements or Steam request left,
  and Link answered "not a shortcut". The handlers refuse an appid below 2^31, and a signed one (CEF, some Millennium builds) is
  below it. The RPC wrapper now turns `appid` and `shortcut_appid` unsigned once, for every method.
- **More in the log for the next report.** `[rpc] <Method> answered an error: ...` (once per message per session) for a handler that
  answers `{ error }` instead of throwing, `[rpc] <Method>: appid arrived signed` once per method, `artwork=<status>(<source>)` in the
  `[sync]` line, and `ra=hash-fail(.rvz)` naming the ROM extension (a compressed disc image cannot be hashed).
- **A failed `EnsureFresh` is no longer silent.** The sync reported "no parts" as if nothing was found; the call's own error now
  lands in the plugin log and the window.
- **Dusklight on Linux** is recognised by its versioned AppImage (`Dusklight-v2.0.3-linux-x86_64.AppImage`: `programs` takes a trailing
  `*`, a marker may be `{exe}`) and its save file is also looked for in `~/.local/share/TwilitRealm/Dusklight` (a guess from SDL's
  data folder, not yet confirmed by a Linux log).

## [0.6.6-beta] - 2026-10-30

### Fixed

- **Switch and other consoles without a RetroAchievements id searched ScreenScraper wrongly.** The Linux 0.6.5-beta log showed every
  such game sending a request ScreenScraper always refuses (HTTP 400, "systemeid obligatoire"), then a name search with no console,
  so Pokemon Violet, Sword, Scarlet and Brilliant Diamond found nothing. Detect now passes the decided platform, the name search runs
  on that console's ScreenScraper id (Switch 225), and a game with no ROM hash skips the refused request.

### Added

- **A cut or rotated log keeps its head.** The start-up and `[host]` lines (OS, distro, Flatpak, Steam Deck, curl / secret-tool / libcurl,
  versions, which accounts are set) are kept in memory and written again at the top of a fresh file after a rotation, and put in front
  of a shared tail that no longer holds them. A report with only the middle of a run no longer hides which box it came from.
- **RetroAchievements 401 says why.** One line per session tells whether the stored login looks damaged (a space or quote at an edge, a
  control or non-ASCII character, a token that is not 16 letters and digits, a missing part) or is well formed and was refused by
  RetroAchievements (token reset, password changed, other account), with the matching advice. Lengths and character classes only; no
  user name or token, and the old `%q` user name in the warning is gone.
- **A source that fails is no longer shown as "no match".** When ScreenScraper, RetroAchievements, IGDB or Steam's store fails for a
  game, Find matches shows a warning on that game that names the source and the cause: "ScreenScraper timed out. Its server may be
  busy; try this game again in a minute", "RetroAchievements looks offline (its server answered with an error). Nothing is wrong on
  your side; try again later", or a network, firewall or certificate hint. The `[detect]` line says how many sources did not answer.
- **Find matches ends with a network summary** in the log: per source, requests sent, failed, paused and the kind of the last failure.

## [0.6.5-beta] - 2026-10-30

### Changed

- **Setup messages use green, yellow and red.** "Confirmed 1 game and fetching them." showed in red, the colour of an
  error. A message now starts with a tick (green: done), a warning sign (yellow: done with a catch, or you need to act,
  like "No game is in scope of your rules") or nothing (red: an error). Confirming now reads "✓ Confirmed 1 game;
  fetching it now."
- **The log says more about a fetch.** Each game the sync walks now gets one `[sync] sync game "<name>"` line with its
  route, whether web and ScreenScraper are on for it, and what each part answered (`identity=ok(steam-store)`,
  `metadata=unsupported`, ...). Before, only failures were logged, so "it ran and fetched nothing" left no trace. A game
  with several failed parts now lists all of them, not the first.

### Fixed

- **Find matches on Linux looked up nothing.** Every game answered "not in the library (72 shortcuts read)": Steam hands
  shortcut ids above 0x7FFFFFFF to the plugin as negative numbers, and the Library Setup window (Find matches, Yes / No,
  Confirm all) compared them as they came with the unsigned ids in `shortcuts.vdf`. It now turns them back first.

## [0.6.4-beta] - 2026-10-29

### Added

- **Linux downloads images and manuals.** ScreenScraper media, manuals and RetroAchievements badges used to fail on Linux
  ("WinINet is Windows-only"). They now go through `curl` when it is installed; the address (which carries your ScreenScraper
  account) is sent to curl on its input, never on a command line. Without curl the log names it.
- **The start-up log says how to keep keys encrypted on Linux** when no `secret-tool` is installed.
- **A `[host]` line at start-up** says what this machine offers: distro, Flatpak, Steam Deck, desktop, and whether `curl`, `wget`,
  `secret-tool`, `flatpak-spawn` and libcurl are there (tool names and yes / no only). Send it with a report and the next step is clear.
- **A failed download names its reason.** `curl` failures in the log read `curl exit 6: could not resolve host (dns)` (also refused,
  timeout, TLS), and a missing curl inside Flatpak says so.
- **RetroArch's login source is logged** (`[retroarch] login: source=cfg|keychain|none`, keychain files present or not), and the
  Emulator Status window explains, on Linux, that RetroArch's encrypted keychain cannot be read and to add your RetroAchievements key.
- **On Linux your keys file is private to you** (`chmod 600` on the `.env` after every save) when no keyring is available.

### Removed

- `silent_exec.lua`, an unused Windows-only process launcher (`cmd.exe`, kernel32).

### Fixed

- **Linux: multi-disc `.m3u` playlists with relative entries** now resolve (the entry was joined with a backslash, so the disc was
  never found and its hash never computed).
- **Linux: the emulator list shows what you have installed.** DuckStation, PCSX2, Dolphin, PPSSPP, RPCS3 and shadPS4 were looked
  up only under their Windows spellings, so they read "not detected"; they are now found in any capitalisation under
  `~/.config`, `~/.local/share` and Flatpak folders.
- **Linux: the Windows emulator-log list is no longer probed** (it could only point at paths that do not exist there).

## [0.6.3-beta] - 2026-10-28

### Added

- **Verbose beta logging across the whole new-user flow.** Every step leaves a line in the plugin log: boot
  (`ready` with the installed-surfaces count, plus safe mode, legacy-plugin, sections and preload failures);
  rules added/edited/deleted (shape and match count, never names or patterns); sources added/removed and
  status-read failures; credential saves (key names and the store, never values); every scan (`N games, M in
  scope, W to set up (fresh F, achievements A)`); every Find-matches sweep (looked up / proposed / need a link /
  no sources / errors); every refused answer with its error; settings-plumbing failures (config API, backend
  copy, heal, live subscribe). The log keeps 2 MiB before rotating (was 512 KiB) so beta reports keep their depth.

### Fixed

- **Library Setup step 4 lists only the games your rules put in scope — also after onboarding.** Reopening the
  window used to list every shortcut (72 instead of 30 in the report), because the scope filter only applied
  during onboarding. The header counts the out-of-scope rest (`Games to set up: N (M out of scope)`), and says
  so when no game is in scope. Only **Refresh library** still shows every game.
- **Every Detect now says what each source answered.** One `[detect]` line per game in the plugin log names the
  verdict and each source's outcome — a hit, a miss, skipped and why (`off`, `no-account`, `console`,
  `steam-hit`), a rejection, or the error — instead of failing silently. A "Find matches did nothing" report
  now has evidence for every game.
- **Transport failures name their kind and what to check.** A request with no HTTP response is classified
  (`[dns]`, `[refused]`, `[timeout]`, `[tls]`, `[http-module]`), and the first failure per source logs the
  likely cause — a firewall blocking outbound HTTPS, DNS, a proxy — instead of a bare error. A missing
  `http` module (the prime suspect for the Linux "nothing fetched" report) is an ordinary logged failure,
  never a silent throw; the shutdown summary and `GetDiagnostics` carry per-source failure counts.
- **Steam store search sends its User-Agent the way Millennium's binding reads it** (top-level `user_agent`;
  the header form is ignored by libcurl), and the Linux binary-download error says plainly it is Windows-only.

## [0.6.2-beta] - 2026-10-28

### Added

- **Confirm all proposed in Library Setup**: the games list has a **Confirm all proposed (N)** button that validates every
  proposed match at once (reversing the earlier no-batch decision), then fetches the confirmed games in one run. Answered
  games and games with nothing proposed are skipped, never changed; a game whose link fails is reported and the rest still
  confirm.

### Fixed

- **Library Setup says why nothing was found.** Detect names how many shortcuts it read when an id does not resolve
  (`not in the library (N shortcuts read)`, or no-shorcuts-read with the wrong-user hint), instead of the bare
  string. When no metadata lookup ran at all (no source picked or credentialed), the game is flagged and the window
  says "No source searched it: turn on a source in step 1 (Metadata), then Find matches again" instead of a silent
  "Needs a link".
- **The sync walk reports failures and stops re-walking settled games.** Each game whose parts error is counted in
  the progress bar (`17 / 24 games, 1 failed`) and named once in the plugin log (`sync game "<name>": <error>`); the
  done line says how many failed. Achievements no source could answer ("unsupported") now count as settled like
  metadata fallbacks (ADR-0096): they are re-walked only when achievements gain an answerer mid-session (a source
  turned on, an account saved), so an unchanged library no longer replays the same bar every launch.
- **A setup with no accounts no longer re-fetches its whole library on every sync.** An empty fallback record is asked
  again when a source gains an account (the record stamps what the web tier could answer when it was saved), otherwise on
  the normal 24 h cadence — not every 30 min. The sync walk skips settled fallbacks unless a picked source holds an
  account (ADR-0096). Opening the settings panel never started a fetch itself; it showed the start-up or rule-triggered
  sync re-walking unsettled games.
- **Log pointers for faster reports.** A background sync logs why it started (`startup`, `rules`, `services`,
  `confirmed`, `fetch-now`), how many games it walks (new vs missing) and when it is done; a fallback asked again
  because an account was added says so. Every settings write logs its key (`saved`, `did not stick`, `not saved`),
  the start-up logs how many keys the Configuration API and the backend copy hold, and a heal from the backend copy
  is logged with the key names — values never reach the log.

- **Confirming all proposed games no longer times out on a big library.** Every game was confirmed in a single
  call, and 216 games outgrew Millennium's 30-second answer window (`RPC timeout for child`). The window now confirms
  ten games per call with a `Confirming X of N...` line; a failed chunk keeps the earlier confirmations, and clicking
  again resumes where it stopped.
- **RetroAchievements sets attach by ROM hash only, never by title alone.** A title match (19XX, say) put the set on
  the page, but unlocking needs a supported hash, so its achievements could never unlock. Detect no longer proposes a
  set the hash does not support, and Confirm checks the hash again (a swapped ROM, or a proposal from before this fix,
  skips the set with a warning while the Game Info links still apply).
- **The plugin log names more of what a report needs.** The start-up block carries the plugin name and version, every
  setting (sources on/off, options, routing) as flags and counts, per-part stored health (error vs unsupported), and
  the reason a forced lookup answered from disk; the Library Analytics counts land when the panel opens, and a shutdown
  line totals the session's requests, paused sources and errors. Counts and flags only — no names, keys or paths.

## [0.6.1-beta] - 2026-10-27

### Added

- **The Game Data editor filters by Analytics group**: the **Show** dropdown in Manual Edit lists every Library Analytics
  row with its count (All games, Metadata match, Achievements match, Ignored by your rules, Games with issues) instead of
  the **Only games with issues** toggle, so each group can be worked through where it is counted. **Fix issues** still
  opens the editor on the games with issues.

### Fixed

- **The Library Setup count refreshes without reopening the panel**: changing the rules, or the background fetch they
  start finishing, re-reads **Games to set up** at once. It used to stay stale until the settings panel was closed and
  opened again.

## [0.6.0-beta] - 2026-10-27

### Added

- **Onboarding guide**: [Onboarding.md](Onboarding.md) walks through the first run step by step: sources, achievements,
  rules and confirming each game, plus skipping, the new-onboarding prompt after an update and starting over for one game.
- **Library Setup**: a window opened from the top of the plugin's settings (Library Setup › Start). It walks you through
  your sources, achievements and rules, then lists every non-Steam game. **Find matches** looks each one up and proposes a
  match (a Steam game, an IGDB or ScreenScraper game, a RetroAchievements set found by the ROM); you answer each game:
  **Yes**, **No** (then link it by hand, with its platform), **No achievements**, or **Skip**. Only the games you confirm are
  downloaded, and a game you confirmed is never asked again. After setup, **Review your games** opens the same list and says
  how many new games wait for you, and **Refresh library** looks up the games you have not answered yet and fetches again
  the confirmed games that miss data.

### Changed

- **Onboarding is required, for new and existing installs.** The first time you open the plugin's settings, the Library Setup window
  opens by itself and explains each step: what every source gives and needs, how RetroAchievements finds a game (the hash of its
  ROM), and the two kinds of rules. Until you finish it, or choose **(I know what I'm doing, skip)**, the other settings are greyed
  out and the plugin fetches nothing new on its own, even on an install that already holds data. **Next** needs at least one
  source on; with more than 150 non-Steam games waiting to be set up, the Rules step must bring them to 150 or fewer first, and
  step 4 lists only the games your rules put in scope.
- **The Steam Store Mirror is no longer an achievements source.** Steam's achievements are a list a custom game cannot unlock. Steam
  lists stored by an earlier version are removed when they hold no unlocks (a list with unlocks is kept); a game matched to a Steam
  game now asks for RetroAchievements, an achievement pack, or **No achievements** in Library Setup. It stays a source of Game Info and
  artwork.
- **Auto routing is removed; no rules means the plugin scans nothing.** Routing Rules start with **Scan just these** and
  **Exclude these**; an **Advanced rule** keeps the service, title and regex options. Onboarding needs at least one rule.
- **Routing Rules has one "Add rule"**, which opens a large window: pick a simple rule (Scan just these, Exclude these) or an
  advanced one. The Library Setup steps along the top are clickable. The **Refresh library** row and the Steam achievements note are
  gone from the settings panel. The activity cards and community content start **off** on a first run (downloaded media is still
  kept 7 days); Library Analytics no longer calls every game "excluded" when you have no rule yet.
- **A new onboarding is offered after an update**: the first time you open the settings, a small window asks whether to run it, with
  checkmarks to start from zero and to keep your saved credentials, settings and games metadata. Nothing is deleted: what is cleared is moved
  to a backup folder in the plugin's data folder. Skipping asks no more.

- **The card you confirm shows the RetroAchievements game's developer, genre and release year** (kept, so it is looked up once). "Start from zero" in the new-onboarding window switches the keep options off. A Steam match confirms with facts too: the card shows the store game's platform, release year, developer and genres, and names that Game Info, artwork and community come from Steam.
- **Settings › Delete metadata** (last section): delete one game's metadata from the last block of the Game Data editor (editor window and Properties › Cartridge) when the onboarding or a fetch goes wrong. The game is asked again in Library Setup. The library-wide block (and "Delete everything") is removed.
- **Native ports** are an achievements source next to RetroAchievements and Emulators, with an info window listing the supported ports
  (Bloodborne PC, Dusklight) and where they are found in your library.
- **The log says more** (for the logs you share): the emulators found, the native ports and how many games launch each, the sources
  on and the number of rules, and each onboarding step with its counts. No names, keys, paths or rule text.
- **Games step of onboarding**: one "Games to set up" row, the list waits (greyed out) until you click Find matches, and each proposal
  shows platform, release year, genres, developer and collections so you can confirm the right game. The settings count only the games your
  rules put in scope; "Excluded by rules" is now "Ignored by your rules". The skip link is on the first step only.
- **The 150-game limit is now a warning**: the Rules step says how many games will be scanned and asks if that is what you want, in green (up to 150), yellow (up to 250) or red, and a rule is still required. The first step is named Metadata, the Steam rows are tighter with bold labels, the Achievements step lists the supported emulators and native ports, "Add service" became "Add source", "Scan just these" became "Scan only these", and the Add source windows are smaller.
- **Onboarding polish**: a welcome line and the sources explained as Steam rows; the Rules step shows three counts (non-Steam games
  detected, scoped within your rules, waiting to be set up) and the rule window shows how many games a rule catches; skipping asks
  for a confirmation; no source is pre-selected (the Steam Store Mirror, emulators and RetroAchievements start off); Add service and
  Add source open in their own window; the collections list shows every collection instead of cutting it off; the games list opens on
  the first game it shows; "Detect" is now "Find matches".
- The log says the setup gate at start-up (`[startup] setup gate: ...`) and writes a line per saved setting (the key only), with a
  warning when a value read back differs from the one written.
- **A game you link to IGDB or ScreenScraper keeps refreshing from that game**: a link used to be saved as your own edit,
  so its details never updated. Now the game's Game Info is refreshed from the exact game you linked, by its id, never
  looked up by name again, so a refresh cannot swap it for another game. Revert unlinks it; if you also edited the
  details, Revert first drops your edit and goes back to the linked game. Games linked before this version stay as they
  were (your own edit) until you Revert and link them again.
- **Nothing is downloaded for your games until you run Library Setup**: a new install no longer fetches Game Info,
  artwork or achievements for your whole library at start-up; it waits for you to run Library Setup. If you already use
  the plugin, your library counts as set up and every game you have keeps refreshing as before. A game added after setup
  waits until you confirm it in the list.
- **Data an earlier version stored wrong is repaired once, at the first start after an update**: the first such repair
  marks every game whose Steam achievements were saved with raw ids and no icons, so they are rebuilt when you open them.

### Fixed

- **Onboarding: a confirmed game is done.** The list moves to the next game instead of opening a long editor; tweak a game later in the other menus. The Game Info editor opens with the fields of a game fetched a moment ago instead of empty.
- **A game matched to Steam is no longer reported as missing achievements**: the Steam mirror gives none, so it is marked "no achievements" when you confirm it. Confirming a game now fills in its Game Info on the spot (from the Steam match, or IGDB / ScreenScraper), and the card shows the fields filled in, to check or leave.
- **Passwords and keys are hidden as you type** in Add source, with an eye button at the right of the field to show them (hidden by default).
- **The plugin could stop during onboarding's "Find matches"** on a game RetroAchievements knows (a bug in how its facts were kept, from the previous build). Fixed. A source you did not turn on, or that has no account, is also no longer asked.
- **Confirming a RetroAchievements game failed with "could not fetch game data"** when your RetroAchievements login lives in RetroArch (not in `.env`).
- **Collection rules never matched any game** (every count in the Rules step was zero): Steam's collections were read as empty. Fixed.
- **The Add source windows no longer list a source you already added.**
- **A game's art could stay empty forever after it was confirmed** (seen live: a Steam match with no grid art). When the game's data was first resolved before its page was ever opened, the session remembered the answer but not where it put it, and every later view silently did nothing. The answer is now resolved again when nothing is stored, so the art (and identity) land on the next view.

- **Shortcuts without an `appid` in Steam's shortcuts file were ignored.** Steam itself writes an `appid` for every non-Steam game, but
  Lutris, Heroic, Bottles, Steam ROM Manager and others (common on Linux) often do not; the plugin then read the library as empty
  (`shortcuts=0` in the log) and fetched nothing. Such a game now gets the id Steam derives from its exe and name. The log's
  `[startup]` section says whether the file was found and how many games had no id of their own.
- A shortcut whose id Steam reports as a negative number (every id above 2147483647) no longer fails the Steam Store mapping lookup
  with "persists non-Steam shortcuts only"; the backend turns it back into the unsigned id. Seen on Linux, not Linux-specific.
- **Linux**: emulator and trophy detection no longer reads only Windows folders. `%APPDATA%`, `%LOCALAPPDATA%` and
  `%USERPROFILE%` now map to `~/.config`, `~/.local/share` and `$HOME` (or `XDG_CONFIG_HOME` / `XDG_DATA_HOME`), and the log and
  settings files of RetroArch, DuckStation, PCSX2, Dolphin, PPSSPP, RPCS3 and shadPS4 are looked up under their Linux names.
  The plugin log hides `/home/<user>` and starts with `[startup] os=...`, naming the data folder. Not yet checked on a Linux
  machine; Flatpak and Proton locations are still to do.

- **Revert in the Game Data editor fills the game in again at once**: reverting a game whose page you had not opened since
  Steam started left its Game Info empty until you opened the page; it is now fetched right away.

- **Steam achievements show their real names and icons again**: Steam changed the page the achievement names, descriptions
  and icons are read from, so a game matched to a Steam game (Escape from Tarkov, say) showed raw ids such as
  `WelcomeToTarkov` and no icons. They are now read from the page's own data and matched to each achievement by id, and
  secret achievements are marked. A list saved with the wrong data is rebuilt the next time the game's page opens.
- **Linking a game to another Steam game replaces its achievements**: after unlinking a wrong match and linking the right
  game, the old game's list and icons stayed until the 24-hour refresh, and its unlocks were counted against the new list.
  A link or unlink now moves the achievements at once. Unlocks are kept per Steam game, so linking back brings the earlier
  ones back.
- **Game Info finds the right game more often**: a game's exact name now wins over a sequel that contains it (Final Fight
  no longer gets Final Fight 3's details, Joe & Mac no longer gets Joe & Mac 2's), a game listed under another name is
  found by that name (Out of This World), and a search with no game of that name gives no match instead of a random one.
- **Games with accented names (Ōkami, Pokémon) and Doom source ports are recognized**: an accented name now matches its
  plain spelling, and a Doom `.wad` file no longer marks a shortcut as a Wii game.
- **RetroAchievements finds Dreamcast, Nintendo DS, Master System and Game Boy Color games**: they were looked up as
  another console's games.

### Security

- **Saved keys and passwords are encrypted at rest.** On Windows they are protected with your Windows account (DPAPI), on Linux they go to your desktop keyring (`secret-tool`); only where neither exists do they stay plain text, and the log says so. Keys saved by an earlier version are converted automatically at the first start after the update, and the old SteamGridDB key file is folded in. If a saved value cannot be opened (another Windows user, another PC), add it again in Settings.

## [0.5.3-beta] - 2026-10-20

### Added

- **Achievement packs come with the plugin, ready to use**: the Dusklight and Bloodborne packs work as soon as the plugin
  is installed, with nothing to copy. Dusklight gets its 50 achievements with RetroAchievements badges as icons (with a
  RetroAchievements key). Your own packs still go in `millennium/config/steam-cartridges/packs`; a pack of yours with an
  included pack's `id` replaces it, so to change one, copy it there and edit the copy.
- **Pick a pack for a game in Manual Edit**: a game without achievements (or one that uses a pack) has an **Achievement
  pack** dropdown in its Achievements block, listing every pack. **Use pack** gives the game that pack whatever program it
  starts; **Stop using this pack** goes back to automatic. A pack file added while Steam runs shows in the list.

### Changed

- Packs are simpler: a pack whose `exe` names the program a shortcut starts is used for it, and that is all.
- The example packs moved from `examples/achievement-packs` into the plugin. An included pack replaces a built-in game
  only when it is more complete, so Bloodborne keeps its built-in support (which also follows the launcher's settings and
  player profiles). RetroAchievements badges now count as a detail when packs are compared.

### Removed

- The **Achievement packs** section of the settings, with its Import and Reload buttons. Packs are read when Steam starts
  and each time the Achievement pack dropdown shows; a file that is not a valid pack is named, with why, in the plugin's log.

## [0.5.2-beta] - 2026-10-20

### Changed

- The README no longer carries a beta notice, and its notes now match how artwork works: art you set yourself in Steam
  is never replaced.

## [0.5.1-beta] - 2026-10-20

### Added

- **Achievement packs can use RetroAchievements badges as icons**: an achievement may carry `"ra_icon": "476109"`, the
  badge name from its RetroAchievements page. With a RetroAchievements key in the plugin's `.env`, the plugin fetches the
  badge itself (a few per page view, kept in `ra_badges` in its data folder); without a key, or if the download fails,
  the game's icon is shown as before. Your own icons, the `icons` line and a PS4 dump still come first. The Dusklight
  example pack now names a badge for all 50 achievements.

### Changed

- The achievement packs guide is now called `Achievement-Packs.md` (it was all capitals), like the other guide.

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
  [Achievement-Packs.md](Achievement-Packs.md), with two examples.

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
