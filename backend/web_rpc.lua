--- Web-metadata and artwork RPC handlers (ex steamgriddb-artwork).
---
--- Raw payload_json signatures and return shapes are kept exactly as they were
--- (P1 is refactor-only), so these are deliberately NOT wrapped in rpc.lua's
--- method(): that would change the error shapes the frontend already handles.

local logger = require("logger")
local json = require("json")

local config = require("web_config")
local metadata_db = require("web_metadata_db")
local steam_paths = require("steam_paths")
local shortcuts = require("shortcuts")
local controllers = require("emulator_controllers")
local emulators = require("steam_store_emulators")

local M = {}

--- Check status of providers (Twitch/IGDB, SteamGridDB, ScreenScraper, RetroAchievements)
function M.GetStatus()
  local twitch = config.get_twitch_credentials()
  local sgdb_key = config.get_api_key()
  local ss = config.get_screenscraper_credentials()
  local ra = config.get_retroachievements_credentials()
  return json.encode({
    has_twitch = twitch ~= nil,
    has_sgdb = sgdb_key ~= nil and #sgdb_key > 0,
    has_screenscraper = ss ~= nil,
    has_retroachievements = ra ~= nil,
    status = twitch ~= nil and "ready" or "needs_credentials",
    db_count = metadata_db.count(),
  })
end

--- Robust payload decoder handling raw JSON, tables, and nested Millennium { payload = "..." }
local function decode_payload(payload_json)
  if type(payload_json) == "table" then
    if type(payload_json.payload) == "string" then
      local ok, inner = pcall(json.decode, payload_json.payload)
      if ok and type(inner) == "table" then return inner end
    end
    return payload_json
  end
  local ok, req = pcall(json.decode, payload_json or "{}")
  if not ok or type(req) ~= "table" then return nil end
  if type(req.payload) == "string" then
    local ok_inner, inner = pcall(json.decode, req.payload)
    if ok_inner and type(inner) == "table" then return inner end
  end
  return req
end

--- Save service credentials (Twitch, ScreenScraper, RetroAchievements, SGDB)
function M.SaveServiceCredentials(payload_json)
  local data = decode_payload(payload_json)
  if not data then
    return json.encode({ success = false, error = "invalid_payload" })
  end
  local ok_save = config.save_credentials(data)
  return json.encode({ success = ok_save })
end

--- Controller support inferred from each shortcut's emulator (parity plan Part F,
--- ADR-0038 addendum): { games = { ["<appid>"] = true|false } }; unknown games
--- are left out. Never fails: an unreadable shortcuts.vdf gives an empty map.
function M.GetControllerInference()
  local ok, games = pcall(function()
    local paths = steam_paths.resolve()
    if not paths or not paths.shortcuts then return {} end
    return controllers.for_entries(shortcuts.parse(paths.shortcuts) or {})
  end)
  return json.encode({ games = ok and games or {} })
end

--- Classify shortcuts for Auto Mode routing:
--- "retroarch" -> RetroArch / libretro cores (retroachievements + web scraping)
--- "console_emulator" -> Standalone emulators with native achievements (console_emulators + web scraping)
--- "pc" -> Native PC game (steam_store mirror + local achievements)
function M.GetAutoRoutingProfiles()
  local ok, profiles = pcall(function()
    local paths = steam_paths.resolve()
    if not paths or not paths.shortcuts then return {} end
    local entries = shortcuts.parse(paths.shortcuts) or {}
    local out = {}
    for _, entry in ipairs(entries) do
      if entry.appid then
        local cmd = tostring(entry.exe or "") .. " " .. tostring(entry.launch_options or "")
        local program = emulators.program(entry.exe)
        local head = program:match("^(%w+)[%-_ ]")
        local is_retro = program == "retroarch" or head == "retroarch" or cmd:lower():find("retroarch") ~= nil or cmd:lower():find("_libretro") ~= nil
        local is_emu = emulators.is_emulator(entry.exe) or (head and emulators.is_emulator(head))

        local category = "pc"
        if is_retro then
          category = "retroarch"
        elseif is_emu then
          category = "console_emulator"
        else
          category = "pc"
        end

        local profile = {
          category = category,
          program = program,
        }

        local u_key = tostring(entry.appid)
        out[u_key] = profile
        local num = tonumber(entry.appid)
        if num and num >= 2147483648 then
          local s_key = tostring(num - 4294967296)
          out[s_key] = profile
        end
      end
    end
    return out
  end)
  return json.encode({ profiles = ok and profiles or {} })
end

return M
