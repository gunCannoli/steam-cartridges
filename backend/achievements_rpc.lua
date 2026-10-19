--- RPC endpoints for the native achievements subsystem (P5).
--- Wrapped via rpc.method for safe JSON marshalling.

local core     = require("rpc")
local store    = require("achievements_store")

local method = core.method

local RPC = {}

local function normalize_appid(id)
  local n = tonumber(id)
  if not n then return nil end
  if n < 0 then n = n + 0x100000000 end
  return n
end

RPC.CartridgesAchievementsUnlock = method("CartridgesAchievementsUnlock", function(data)
  local shortcut_appid = normalize_appid(data.shortcut_appid)
  local achievement_id = data.achievement_id
  if not shortcut_appid then error("missing shortcut_appid") end
  if not achievement_id then error("missing achievement_id") end
  return store.unlock(shortcut_appid, achievement_id, data.unlock_time)
end)

--- data = { shortcut_appid, native_appid?, sources? = { "rpcs3" | "shadps4" }, title? }
--- Clears the plugin's unlocks, and the chosen sources' files (backed up first): ADR-0054.
RPC.CartridgesAchievementsReset = method("CartridgesAchievementsReset", function(data)
  local shortcut_appid = normalize_appid(data.shortcut_appid)
  if not shortcut_appid then error("missing shortcut_appid") end
  local sources = type(data.sources) == "table" and data.sources or {}
  local result = require("achievements_reset").reset(shortcut_appid, data.native_appid, sources, data.title)
  result.unlocks = {}
  return result
end)

--- Where this shortcut's unlocks come from besides the plugin's store, and which can be reset.
RPC.CartridgesAchievementsResetSources = method("CartridgesAchievementsResetSources", function(data)
  local shortcut_appid = normalize_appid(data.shortcut_appid)
  if not shortcut_appid then error("missing shortcut_appid") end
  return require("achievements_reset").sources(shortcut_appid, data.native_appid)
end)

RPC.CartridgesAchievementsGetRetroStatus = method("CartridgesAchievementsGetRetroStatus", function(data)
  local ra = require("retroachievements")
  return ra.get_emulator_status()
end)

return RPC
