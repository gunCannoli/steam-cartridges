--- steam-cartridges - backend entry point.
---
--- Supplies the library grid with capture timestamps for non-Steam games.
---
--- The app detail page is not built here. Steam renders it from its own
--- components once the frontend restores the section and feeds Steam's own
--- store (ADR-0022), so the backend only supplies what Steam genuinely does
--- not have: evidence a shortcut was played, from its screenshot index.

-- Stability guardrail (ADR-0058): disable LuaJIT trace compiler to run strictly in the
-- fast handcrafted x86-64 bytecode interpreter.
-- In Millennium's 64-bit LuaVM host bridge (millennium.luavm64.exe), JIT-compiled traces
-- clobber non-volatile registers R14/R15 across the C++ boundary, corrupting the return
-- string buffer pointer and crashing with EXCEPTION_ACCESS_VIOLATION (0xC0000005) at 0x1087C.
if jit and jit.off then
  jit.off()
end

-- The plugin's own log file (plog.lua): installed before any other module, so each `require("logger")` below gets the tee.
require("plog").install()

local logger      = require("logger")
local millennium  = require("millennium")
local steam_paths = require("steam_paths")

local data_dir    = require("data_dir")
local migrate     = require("migrate")
local config      = require("web_config")
local metadata_db = require("web_metadata_db")

local RPC     = require("rpc")
local WEB_RPC = require("web_rpc")
local STORE_RPC = require("steam_store_rpc")
local ACH_RPC   = require("achievements_rpc")
local RECORD_RPC = require("record_rpc")
local PROVIDED_RPC = require("provided_rpc")
local PACKS_RPC = require("packs_rpc")
local SETUP_RPC = require("setup_rpc")
local LIBRARY_RPC = require("library_rpc")
local SETTINGS_RPC = require("settings_rpc")
local RESET_RPC = require("reset_rpc")
local LOG_RPC = require("log_rpc")

-- Library Setup gate (ADR-0086): the plugin fetches on its own only after the user ran setup; a call the user started
-- passes anyway (rpc.method's user_action). net knows nothing of setup; this is where the two meet.
require("net").gate = function() return require("setup_store").gate_open() end

-- Millennium exposes globals to the frontend as callable methods.
GetLibraryStats = RPC.GetLibraryStats
GetDiagnostics  = RPC.GetDiagnostics
TestServiceConnection = RPC.TestServiceConnection

-- Web metadata + artwork handlers keep their raw payload_json signatures.
GetStatus            = WEB_RPC.GetStatus
GetControllerInference = WEB_RPC.GetControllerInference
GetAutoRoutingProfiles = WEB_RPC.GetAutoRoutingProfiles
SaveServiceCredentials = WEB_RPC.SaveServiceCredentials

-- Steam Store bucket (P3). Flat files, prefixed names.
SteamStoreGetState       = STORE_RPC.SteamStoreGetState
SteamStoreGetMapping     = STORE_RPC.SteamStoreGetMapping
SteamStoreSetMapping     = STORE_RPC.SteamStoreSetMapping
SteamStoreClearMapping   = STORE_RPC.SteamStoreClearMapping
SteamStoreRejectSuggestion = STORE_RPC.SteamStoreRejectSuggestion
SteamStoreSearchCandidates = STORE_RPC.SteamStoreSearchCandidates
SteamStoreRecordArtwork  = STORE_RPC.SteamStoreRecordArtwork
SteamStoreSaveIcon       = STORE_RPC.SteamStoreSaveIcon
SteamStoreRecordIcon     = STORE_RPC.SteamStoreRecordIcon

-- Native Achievements subsystem (P5).
CartridgesAchievementsUnlock       = ACH_RPC.CartridgesAchievementsUnlock
CartridgesAchievementsReset        = ACH_RPC.CartridgesAchievementsReset
CartridgesAchievementsResetSources = ACH_RPC.CartridgesAchievementsResetSources
CartridgesAchievementsGetRetroStatus = ACH_RPC.CartridgesAchievementsGetRetroStatus
CartridgesAchievementsGetNativePortsStatus = ACH_RPC.CartridgesAchievementsGetNativePortsStatus

-- Record facade (migration M4b; M5a adds GetAllRecords; M10 removed the uncalled GetGameRecord).
EnsureFresh    = RECORD_RPC.EnsureFresh
GetAllRecords  = RECORD_RPC.GetAllRecords
SaveCustomMetadata  = RECORD_RPC.SaveCustomMetadata
ClearCustomMetadata = RECORD_RPC.ClearCustomMetadata
SetAchievementSource = RECORD_RPC.SetAchievementSource
ClearAchievementSource = RECORD_RPC.ClearAchievementSource
IgdbLink       = RECORD_RPC.IgdbLink
ScreenscraperLink   = RECORD_RPC.ScreenscraperLink
CheckUnlocks   = RECORD_RPC.CheckUnlocks
GetNewShortcuts = RECORD_RPC.GetNewShortcuts
MarkKnown      = RECORD_RPC.MarkKnown
-- Community media (features plan F2): ScreenScraper image bytes; the rest of the media part comes through EnsureFresh.
GetMediaImage  = RECORD_RPC.GetMediaImage
-- Manuals (features plan F2c): a ScreenScraper PDF, read in 1 MiB chunks.
GetManualChunk = RECORD_RPC.GetManualChunk
GetManualCover = RECORD_RPC.GetManualCover
SaveManualCover = RECORD_RPC.SaveManualCover
-- Downloaded media on disk (ADR-0051): drop the games not opened within the setting's days.
PruneMediaCache = RECORD_RPC.PruneMediaCache

-- Extensions push a game's data (ADR-0067: Game Info, media, achievements; Epic and Xbox from steam-cartridges-third-party).
ProvideGame         = PROVIDED_RPC.ProvideGame
ForgetProvidedGame  = PROVIDED_RPC.ForgetProvidedGame
ProvideAchievements = PROVIDED_RPC.ProvideAchievements

-- Achievement packs (ADR-0081, ADR-0083): the Game Data editor's achievements block.
AchievementPacksList    = PACKS_RPC.AchievementPacksList
AchievementPacksExplain = PACKS_RPC.AchievementPacksExplain

-- Library Setup (ADR-0086): has the user run it; the setup window marks it done.
GetSetupState = SETUP_RPC.GetSetupState
SetSetupDone  = SETUP_RPC.SetSetupDone
-- Settings mirror (ADR-0090): the second copy the frontend falls back to when the Configuration API gives nothing back.
GetSettings  = SETTINGS_RPC.GetSettings
SaveSettings = SETTINGS_RPC.SaveSettings
ResetPluginData = RESET_RPC.ResetPluginData
DeleteGameMetadata = RESET_RPC.DeleteGameMetadata
ClientLog = LOG_RPC.ClientLog

LibraryScan   = LIBRARY_RPC.LibraryScan
LibraryDetect = LIBRARY_RPC.LibraryDetect
ValidateGame  = LIBRARY_RPC.ValidateGame

local function on_load()
  -- Resolve paths eagerly so a misconfigured install shows up in the log at
  -- startup rather than on the first page view.
  local paths, err = steam_paths.resolve()
  if not paths then
    logger:error("could not resolve Steam paths: " .. tostring(err))
  end

  -- Self-check (P0 T5: dotted require / cwd behaviour is unverified, so the
  -- backend uses a flat layout). Log what the runtime actually resolves.
  logger:info("self-check: package.path=" .. tostring(package.path))
  local ok_cwd, cwd = pcall(function() return require("fs").current_path() end)
  logger:info("self-check: cwd=" .. tostring(ok_cwd and cwd or "unavailable")
    .. ", data_dir=" .. tostring(data_dir.path()))

  -- What a bug report needs first: where things are and which services are set up (yes/no, never a value).
  local plog = require("plog")
  local function yn(v) return v and "yes" or "no" end
  local ok_v, mver = pcall(function() return millennium.version() end)
  plog.event("startup", string.format("os=%s millennium=%s steam=%s data_dir=%s log=%s", require("platform").os_name(),
    tostring(ok_v and mver or "unknown"), tostring(paths and paths.root), data_dir.path(), plog.path()))
  plog.event("startup", string.format("credentials: igdb=%s screenscraper=%s steamgriddb=%s retroachievements=%s; shortcuts=%s",
    yn(config.get_twitch_credentials()), yn(config.get_screenscraper_credentials()), yn(config.get_api_key()),
    yn(config.get_retroachievements_credentials()),
    tostring(paths and paths.shortcuts and #(require("shortcuts").parse(paths.shortcuts) or {}) or "unknown")))

  -- Can the data folder be written? Settings, answers and fetched data all live there; the path comes from
  -- millennium.steam_path(), never a hardcoded Steam folder, so a read-only install (Program Files) shows up here.
  do
    local probe = data_dir.file(".write-test")
    local okw = pcall(function() return require("utils").write_file(probe, "ok") end)
    local back = okw and require("utils").read_file(probe)
    pcall(function() os.remove(probe) end)
    plog.event("startup", "data folder writable: " .. ((okw and back == "ok") and "yes" or "NO (settings and fetched data cannot be saved)"))
  end

  -- What a shared log should say about the setup: which emulators and native ports are found, and how the plugin is configured
  -- (booleans and counts only: no name, key, path or rule text).
  pcall(function()
    local parts = {}
    local status = require("retroachievements").get_emulator_status() or {}
    for _, e in ipairs(status.emulators or status) do
      parts[#parts + 1] = string.format("%s=%s", tostring(e.name):gsub("[^%w]+", ""):lower(), e.authenticated and "signed-in" or e.detected and "found" or "not-found")
    end
    plog.event("startup", "emulators: " .. table.concat(parts, ", "))
  end)
  pcall(function()
    local parts = {}
    for _, p in ipairs(require("native_ports").status(require("registry").entries() or {})) do
      parts[#parts + 1] = string.format("%s=%d", tostring(p.id), p.detected)
    end
    plog.event("startup", "native ports (games launching each): " .. table.concat(parts, ", "))
  end)
  pcall(function()
    local v = require("settings_store").get_all()
    local on = {}
    for k, x in pairs(type(v.services) == "table" and v.services or {}) do if x == true and k ~= "rpcs3Enabled" then on[#on + 1] = (k:gsub("Enabled$", "")) end end
    table.sort(on)
    local rules = type(v.routingRules) == "table" and #v.routingRules or 0
    plog.event("startup", string.format("configuration: sources on=[%s], routing rules=%d", table.concat(on, ","), rules))
  end)

  -- Keys an earlier version saved as plain text are protected now (ADR-0099); the log says which store is in use.
  pcall(function()
    local r = require("web_config").protect_existing()
    plog.event("startup", string.format("credentials store: %s (%d protected now, %d already, %d plain)", r.store == "none" and "none: plain text" or r.store, r.protected, r.already, r.plain))
  end)

  -- Why a library can look empty: is the file there, how many shortcuts, and how many had no appid of their own (Linux tools).
  do
    local sp = paths and paths.shortcuts
    local okf, there = pcall(function() return sp and require("fs").is_file(sp) end)
    local list = (okf and there and require("shortcuts").parse(sp)) or {}
    local derived = 0
    for _, e in ipairs(list) do if e.appid_derived then derived = derived + 1 end end
    plog.event("startup", string.format("shortcuts file: %s (%s); entries=%d, without an appid of their own=%d",
      tostring(sp), okf and there and "found" or "NOT FOUND", #list, derived))
  end

  -- A migration failure logs and continues.
  local ok_m, err_m = pcall(migrate.run)
  if not ok_m then
    logger:error("migration failed: " .. tostring(err_m))
  end
  local ok_m2, err_m2 = pcall(migrate.run_v2)
  if not ok_m2 then
    logger:error("migration v2 failed: " .. tostring(err_m2))
  end

  if config.get_twitch_credentials() then
    logger:info("Game Metadata provider loaded (Twitch credentials configured).")
  else
    logger:warn("Game Metadata provider loaded (no Twitch credentials found in .env).")
  end
  logger:info("Metadata database contains " .. tostring(metadata_db.count()) .. " cached game(s).")

  millennium.ready()
  logger:info("Backend loaded.")

  -- Fix what an earlier version stored wrong, once per update (repairs.lua); after ready, so it never delays the backend.
  local ok_r, err_r = pcall(function() return require("repairs").run() end)
  if not ok_r then logger:warn("repair pass failed: " .. tostring(err_r)) end

  -- The gate, so a report answers "did it fetch before onboarding?": none | existing (stored data, onboarding pending) | setup (consent, onboarding pending) | onboarded.
  pcall(function()
    local st = require("setup_store").get()
    local gate = not st.done and "none" or st.onboarded and "onboarded" or st.why == "existing library" and "existing" or "setup"
    require("plog").event("startup", "setup gate: " .. gate .. (st.why and (" (" .. st.why .. ")") or "") .. string.format(", onboarding version %d of %d", st.version or 0, require("setup_store").ONBOARDING_VERSION))
  end)

  -- Forget shortcuts gone from the library for a week (ADR-0078); after ready, so it never delays the backend.
  local ok_p, err_p = pcall(function() return require("prune_removed").run() end)
  if not ok_p then logger:warn("pruning removed shortcuts failed: " .. tostring(err_p)) end
end

local function on_frontend_loaded()
  logger:info("Frontend loaded.")
end

local function on_unload()
  logger:info("Backend unloading.")
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}
