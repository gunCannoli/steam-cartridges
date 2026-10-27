--- One-time repair passes: when an update fixes data that earlier versions stored wrong, a repair here fixes what is
--- already on disk, once, at the first start after the update.
---
--- Each repair has an increasing `id`; <data dir>/repairs.json holds the highest one applied. A start runs the repairs
--- above it, in order, and stamps each after it finishes (an interrupted pass runs again). A repair is offline and
--- quick: it marks what must be asked again (the freshness stamp) or corrects what is stored; the network work is the
--- normal, throttled EnsureFresh when a game's page opens. A repair that throws is logged and does not block the next.
---
--- To add one: append { id = <last + 1>, name, run } to REPAIRS. Never edit or reorder an applied one.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "repairs.json"
M._path = nil -- test override

local function path() return M._path or data_dir.file(FILE) end

local function applied()
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then return tonumber(data.applied) or 0 end
  end
  return 0
end

local function stamp(id)
  return utils.write_file(path(), json.encode({ applied = id }))
end

--- 1: Steam achievement lists built from Steam's pre-2026 community page hold raw ids and no icons (steam_schema
--- SCHEMA_VERSION 2). Every shortcut bound to one is asked again on its next view, and a remembered "unsupported" or
--- error for it is forgotten. Unlocks and links are not touched.
local function steam_schemas_rebuilt()
  local store, fresh = require("achievements_store"), require("fresh_policy")
  local current = require("steam_schema").SCHEMA_VERSION
  local checked, marked = 0, 0
  for _, key in ipairs(store.shortcut_keys()) do
    local st = store.get_state(tonumber(key))
    if st and type(st.schema_appid) == "number" and st.source == nil then
      checked = checked + 1
      local schema = st.schema
      if schema == nil or (tonumber(schema.version) or 0) < current or schema.unreadable == true then
        fresh.forget_part(tonumber(key), "achievements")
        marked = marked + 1
      end
    end
  end
  return string.format("%d Steam-linked shortcut(s) checked, %d marked to be built again", checked, marked)
end

--- 2: Library Setup (ADR-0086) keeps a new install from fetching until the user runs it. A library that already holds
--- what an earlier version fetched (Game Info, a Steam link, an achievement list) was set up the old way: mark it done,
--- so an update changes nothing for it. A new install has none of these and stays "not run".
local function existing_library_set_up()
  local setup = require("setup_store")
  if setup.done() then return "already set up" end
  local records = require("web_metadata_db").count() or 0
  local links = 0
  for _ in pairs((require("steam_store_store").get_state() or {}).mappings or {}) do links = links + 1 end
  local lists = #(require("achievements_store").shortcut_keys() or {})
  if records + links + lists == 0 then return "nothing stored: a new install, setup not run" end
  setup.mark_done("existing library")
  return string.format("existing library (%d Game Info record(s), %d Steam link(s), %d achievement list(s)): set up", records, links, lists)
end

--- 3: after Library Setup only validated games are fetched (ADR-0086, plan § 6). Every game that already holds data
--- (a Game Info record, a Steam link, an achievement list) is marked "existing", so it keeps being refreshed as before; a
--- game added later waits for the user's answer in Library Setup.
local function existing_games_kept()
  local ids, seen = {}, {}
  local function add(k)
    local n = tonumber(k)
    if n and n >= 0x80000000 and not seen[n] then seen[n] = true; ids[#ids + 1] = n end
  end
  for k in pairs(require("web_metadata_db").get_all() or {}) do add(k) end
  for k in pairs((require("steam_store_store").get_state() or {}).mappings or {}) do add(k) end
  for _, k in ipairs(require("achievements_store").shortcut_keys() or {}) do add(k) end
  local marked = require("choices_store").mark_existing(ids)
  return string.format("%d game(s) with data, %d marked existing", #ids, marked)
end

--- 4: the Steam Store Mirror is no longer a source of achievements (ADR-0088, onboarding plan phase 1). The Steam
--- achievement lists an earlier version stored are removed, so a game does not show a list nobody can unlock. A list that
--- already holds unlocks is the player's progress and is kept (store.forget refuses it); RetroAchievements lists, packs,
--- trophy and store lists and manual links are not Steam lists and are not touched.
local function steam_lists_removed()
  local store, fresh = require("achievements_store"), require("fresh_policy")
  local removed, kept = 0, 0
  for _, key in ipairs(store.shortcut_keys()) do
    local id = tonumber(key)
    local st = id and store.get_state(id)
    if st and st.source == nil and type(st.schema_appid) == "number" and st.schema ~= nil then
      if store.forget(id) then
        fresh.forget_part(id, "achievements")
        removed = removed + 1
      else
        kept = kept + 1
      end
    end
  end
  return string.format("%d Steam achievement list(s) removed, %d kept (they hold unlocks)", removed, kept)
end

local REPAIRS = {
  { id = 1, name = "steam-achievement-lists", run = steam_schemas_rebuilt },
  { id = 2, name = "library-setup-existing", run = existing_library_set_up },
  { id = 3, name = "library-setup-existing-games", run = existing_games_kept },
  { id = 4, name = "steam-lists-removed", run = steam_lists_removed },
}

--- Runs the repairs not yet applied. Returns how many ran.
function M.run()
  local done, ran = applied(), 0
  for _, repair in ipairs(REPAIRS) do
    if repair.id > done then
      local ok, summary = pcall(repair.run)
      pcall(function()
        require("plog").event("repair", string.format("#%d %s: %s", repair.id, repair.name, ok and tostring(summary) or ("failed: " .. tostring(summary))))
      end)
      if not ok then break end -- stamped nothing: it runs again next start, and later repairs wait for it
      stamp(repair.id)
      ran = ran + 1
    end
  end
  return ran
end

M._REPAIRS = REPAIRS

return M
