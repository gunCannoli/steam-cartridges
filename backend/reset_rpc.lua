--- Reset facade (ADR-0093): the "new onboarding" prompt lets the user start over and choose what to keep.
---
--- Nothing is deleted: what is cleared is moved into <data dir>/backup-<time>/ and the stores that hold it in memory forget it.
--- Settings live in Millennium's config too; the frontend clears those keys itself (settings.ts resetSettings) after this.

local core     = require("rpc")
local data_dir = require("data_dir")
local fs       = require("fs")

local method = core.method

local M = {}

local GROUPS = {
  credentials = { ".env", "sgdb_key.txt" },
  settings    = { "settings.json" },
  metadata    = {
    "library_metadata.json", "achievements.json", "community_media.json", "freshness.json", "steam_store.json",
    "game_choices.json", "proposals.json", "provided_games.json", "ra_cache.json",
  },
}

--- The in-memory stores of the files above forget what they hold (each reads its file again on next use).
local STORES = {
  "settings_store", "achievements_store", "choices_store", "proposals_store", "fresh_policy", "media_store",
  "provided_store", "ra_cache", "steam_store_store", "web_metadata_db", "web_config",
}

--- Moves `names` from the data folder into `folder`. Returns how many moved.
local function move(names, folder)
  local moved = 0
  for _, name in ipairs(names) do
    local from = data_dir.file(name)
    local ok_exists, exists = pcall(fs.is_file, from)
    if ok_exists and exists then
      pcall(fs.create_directories, folder)
      if pcall(fs.rename, from, folder .. "/" .. name) then moved = moved + 1 end
    end
  end
  return moved
end

--- { zero = bool, clear = { credentials, settings, metadata } } -> { moved, backup }
--- `zero` false: nothing is cleared, the onboarding runs over what is there. `zero` true: the groups in `clear` are moved
--- aside and the setup state is cleared (the onboarding starts as on a new install).
M.ResetPluginData = method("ResetPluginData", function(data)
  local clear = type(data.clear) == "table" and data.clear or {}
  local folder = data_dir.file("backup-" .. os.date("%Y%m%d-%H%M%S"))
  local moved = 0
  if data.zero == true then
    for group, names in pairs(GROUPS) do
      if clear[group] == true then moved = moved + move(names, folder) end
    end
    local setup = require("setup_store")
    setup.clear()
  end
  for _, name in ipairs(STORES) do
    pcall(function()
      local mod = require(name)
      if type(mod._reset) == "function" then mod._reset() end
    end)
  end
  pcall(function() require("plog").event("onboarding", string.format("reset for a new onboarding: zero=%s, %d file(s) moved aside", tostring(data.zero == true), moved)) end)
  return { moved = moved, backup = moved > 0 and folder or nil }
end, { user_action = true })

--- Forgets everything the plugin fetched or learned about one game: its Game Info record, the proposal and the answer (so Library Setup asks again),
--- the freshness stamps, the downloaded media, its Steam link, a pushed achievement set and its achievements (list and unlocks: they are part of
--- the game's metadata and come back when the game is set up again, ADR-0098). Settings and credentials stay.
local function forget_game(appid)
  local n = tonumber(appid)
  if not n then return end
  pcall(function() require("web_metadata_db").delete(n) end)
  pcall(function() require("choices_store").forget(n) end)
  pcall(function() require("proposals_store").forget(n) end)
  pcall(function() require("media_store").delete(n) end)
  pcall(function() require("fresh_policy").forget(n) end)
  pcall(function() require("achievements_store").erase(n) end)
  pcall(function() require("provided_store").delete(n) end)
  pcall(function() require("steam_store_store").clear(n, false) end)
end

--- { appid = number } -> { ok }
M.DeleteGameMetadata = method("DeleteGameMetadata", function(data)
  if not tonumber(data.appid) then error("missing appid") end
  forget_game(data.appid)
  pcall(function() require("plog").event("metadata", "deleted for one game by the user") end)
  return { ok = true }
end, { user_action = true })

return M
