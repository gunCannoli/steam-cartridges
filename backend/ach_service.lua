--- Achievement schema and unlocks for a shortcut: which source answers? (migration plan M6a).
---
--- Sources, in this order (the chain CartridgesAchievementsGet used to hard-code), each with a
--- `supports` rule so a source is only asked when the shortcut can be one of its games:
---   provided          an extension pushed the player's achievements (ADR-0067: Epic, Xbox from
---                     steam-cartridges-third-party): the stored set is the answer, no network; refreshed only by
---                     the extension's next push
---   (steam            removed, ADR-0088: the Steam Store Mirror is a visual list, not a source)
---   native_port       the shortcut launches a native port (src_native_ports.supports; ADR-0072); this service
---                     persists what the source answers, the source never writes the store
---   rpcs3             a PS3 trophy directory is found from the launch command
---   shadps4           a PS4 trophy directory is found from the launch command
---   retroachievements a ROM path is found from the launch command
---   pack              an achievement pack matches the shortcut (achievement_packs.lua, ADR-0081): the last resort.
---                     A pack can also answer at native_port's place, replacing a built-in port that it is at least
---                     as complete as (D11); the part's source is then "pack" too.
---
--- K2: a PC game with no ROM path is never sent to RetroAchievements, and a shortcut no source
--- supports is `unsupported` and silent (no log line, no request).

local store       = require("achievements_store")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  entry = nil, -- fun(appid) -> { exe, launch_options } | nil ; nil = shortcuts.vdf lookup
  ps3 = nil,   -- fun(appid) -> res, err          ; nil = ps3_trophies.get_or_fetch
  ps4 = nil,   -- fun(appid) -> res, err          ; nil = ps4_trophies.get_or_fetch
  native_port = nil, -- fun(entry, stored) -> answer, err ; nil = src_native_ports.fetch
  native_port_supports = nil, -- fun(entry) -> boolean ; nil = src_native_ports.supports
  pack = nil,          -- fun(entry, stored) -> answer, err ; nil = src_native_ports.fetch_pack
  pack_supports = nil, -- fun(entry) -> boolean ; nil = src_native_ports.pack_supports
  pack_signature = nil, -- fun() -> string ; nil = achievement_packs.signature
  ra = nil,    -- fun(appid, hardcore) -> res, err ; nil = retroachievements.get_or_fetch
  ps3_dir = nil,  -- fun(exe, launch_options) -> dir | nil ; nil = ps3_trophies.find_trophy_dir
  ps4_dir = nil,  -- fun(exe, launch_options) -> dir | nil ; nil = ps4_trophies.find_trophy_dir
  rom_path = nil, -- fun(exe, launch_options) -> path | nil ; nil = retroachievements.extract_rom_path
  provided = nil,    -- fun(appid) -> pushed record | nil ; nil = provided_store.get (ADR-0067)
  now = function() return os.time() end,
}

local function now_ms()
  return math.floor((M.deps.now or os.time)() * 1000)
end

local function default_entry(appid)
  return require("registry").shortcut(appid)
end

local function dep(name, module_name, fn_name)
  return M.deps[name] or function(...) return require(module_name)[fn_name](...) end
end

--- An extension pushed this shortcut's achievements (ADR-0067): the stored set, whose `source` is the pushed one.
local function provided_set(appid)
  local rec = M.deps.provided and M.deps.provided(appid) or require("provided_store").get(appid)
  if type(rec) ~= "table" then return nil end
  local st = store.get_state(appid)
  if not st or not st.schema or st.source ~= rec.source then return nil end
  return { schema = st.schema, unlocks = st.unlocks or {}, source = st.source }
end

--- Persists what src_native_ports answered (a rebuilt schema with every unlock, or only the added unlocks) and
--- names the part's source: "native_port", or "pack" when an achievement pack answered.
local function persist_port(appid, res, err)
  if not res then return nil, err end
  local source = res.source or "native_port"
  if res.rebuilt then
    store.save_schema_and_sync(appid, res.key, res.schema, res.unlocks, source)
  else
    for id, info in pairs(res.added or {}) do store.unlock(appid, id, info.unlocked_time) end
  end
  return { schema = res.schema, unlocks = res.unlocks, answered_by = source }
end

local SOURCES = {
  {
    name = "provided",
    supports = function(ctx) return ctx.appid ~= nil and provided_set(ctx.appid) ~= nil end,
    fetch = function(appid)
      local set = provided_set(appid)
      if not set then return nil, "nothing pushed" end
      return set
    end,
  },
  -- No "steam" source (ADR-0088): the Steam Store Mirror is a visual list that cannot be unlocked in a custom game.
  {
    name = "native_port",
    supports = function(_, entry)
      return entry ~= nil and dep("native_port_supports", "src_native_ports", "supports")(entry) == true
    end,
    fetch = function(appid, _, entry)
      return persist_port(appid, dep("native_port", "src_native_ports", "fetch")(entry, store.get_state(appid)))
    end,
  },
  {
    name = "rpcs3",
    supports = function(_, entry)
      return entry ~= nil and dep("ps3_dir", "ps3_trophies", "find_trophy_dir")(entry.exe, entry.launch_options) ~= nil
    end,
    fetch = function(appid) return dep("ps3", "ps3_trophies", "get_or_fetch")(appid) end,
  },
  {
    name = "shadps4",
    supports = function(_, entry)
      return entry ~= nil and dep("ps4_dir", "ps4_trophies", "find_trophy_dir")(entry.exe, entry.launch_options) ~= nil
    end,
    fetch = function(appid) return dep("ps4", "ps4_trophies", "get_or_fetch")(appid) end,
  },
  {
    name = "retroachievements",
    supports = function(_, entry)
      return entry ~= nil and dep("rom_path", "retroachievements", "extract_rom_path")(entry.exe, entry.launch_options) ~= nil
    end,
    fetch = function(appid, ctx) return dep("ra", "retroachievements", "get_or_fetch")(appid, ctx.hardcore) end,
  },
  {
    name = "pack",
    supports = function(_, entry)
      return entry ~= nil and dep("pack_supports", "src_native_ports", "pack_supports")(entry) == true
    end,
    fetch = function(appid, _, entry)
      return persist_port(appid, dep("pack", "src_native_ports", "fetch_pack")(entry, store.get_state(appid)))
    end,
  },
}

--- Resolve, returning the part and the raw source result (the old RPC's response shape).
--- ctx = { native = number|nil, hardcore = boolean|nil, title = string }
function M._resolve(appid, ctx)
  ctx = ctx or {}
  ctx.appid = appid
  local st = store.get_state(appid)
  if st and (st.source == "none" or st.schema_appid == "none") then
    return { status = "none", source = "none", data = { schema = st.schema, unlocks = {} }, checkedAt = now_ms() }, nil
  end
  local entry = (M.deps.entry or default_entry)(appid)

  local asked, last_err = false, nil
  for _, source in ipairs(SOURCES) do
    local okS, supported = pcall(source.supports, ctx, entry)
    if okS and supported then
      asked = true
      local okF, res, err = pcall(source.fetch, appid, ctx, entry)
      if okF and type(res) == "table" and res.schema then
        return {
          status = "ok",
          source = (source.name == "provided" and res.source) or res.answered_by or source.name,
          data = { schema = res.schema, unlocks = res.unlocks or {} },
          checkedAt = now_ms(),
        }, res
      end
      last_err = (okF and (err or (res and res.error))) or (not okF and tostring(res)) or last_err
    end
  end

  if not asked then
    -- A Steam list an earlier version stored and the user has unlocks in (ADR-0088 repair 4 keeps those) is no longer
    -- refreshed, but it must not turn into "unsupported" and hide.
    if st and st.schema and st.source == nil and type(st.schema_appid) == "number" then return M.local_part(appid), nil end
    return { status = "unsupported", checkedAt = now_ms() }, nil
  end
  return { status = "error", message = tostring(last_err or "no source returned a schema"), checkedAt = now_ms() }, nil
end

local signature = nil
--- What this build can answer: the source names, every native port definition id and the achievement packs (id and
--- revision). A remembered "unsupported" found with another signature is asked again (record_rpc,
--- fresh_policy.remembered). Only the build's part is cached: packs can be added or edited without a restart.
function M.signature()
  if not signature then
    local names = {}
    for _, source in ipairs(SOURCES) do names[#names + 1] = source.name end
    local ok, defs = pcall(function() return require("native_ports").definitions() end)
    local ids = {}
    for _, def in ipairs(ok and defs or {}) do ids[#ids + 1] = tostring(def.id) end
    table.sort(ids)
    signature = table.concat(names, ",") .. "|" .. table.concat(ids, ",")
  end
  local ok, packs = pcall(M.deps.pack_signature or function() return require("achievement_packs").signature() end)
  if ok and type(packs) == "string" and packs ~= "" then return signature .. "|" .. packs end
  return signature
end

--- Full resolution. Returns a Part<{ schema, unlocks }>.
function M.ensure(appid, ctx)
  return (M._resolve(appid, ctx))
end

--- Disk only: the stored schema and unlocks as a part, or nil. Never writes or fetches.
function M.local_part(appid)
  local st = store.get_state(appid)
  if not st or not st.schema then return nil end
  if st.source == "none" or st.schema_appid == "none" then
    return { status = "none", source = "none", data = { schema = st.schema, unlocks = {} }, checkedAt = now_ms() }
  end
  -- `source` tells a synced part (a store's, or RetroAchievements': its freshness is short, fresh_policy) from a local
  -- one. Entries written before the source was stored are RetroAchievements' when their list is ("ra_<game>").
  local source = st.source
  if not source and type(st.schema_appid) == "string" and st.schema_appid:match("^ra_") then source = "retroachievements" end
  return { status = "ok", source = source, data = { schema = st.schema, unlocks = st.unlocks or {} }, checkedAt = now_ms() }
end

--- Every shortcut appid (a number) the store holds an entry for, with or without a schema. Disk only;
--- GetAllRecords uses it so a shortcut with no metadata and no mapping still gets its part (ADR-0045).
function M.stored_appids()
  local ids = {}
  for _, key in ipairs(store.shortcut_keys()) do
    local n = tonumber(key)
    if n then ids[#ids + 1] = n end
  end
  return ids
end


--- Set a shortcut's achievement source by hand (the Game Data editor, Library Setup's validation): "ra" (a
--- RetroAchievements game id or url), "steam" (refused, ADR-0088), "pack" (an achievement pack's id) or "none".
--- Any choice but "pack" drops a pack the user gave the game. Fetches the chosen list now. Moved from record_rpc's
--- SetAchievementSource (Library Setup phase 3: a service, so the setup service can use it too).
---@return table { ok, source, ... } | { error }
function M.set_source(s_appid, source, target)
  local store = require("achievements_store")
  local packs = require("achievement_packs")
  if source ~= "pack" then packs.assign(s_appid, nil) end

  if source == "pack" then
    packs.reload()
    local def = type(target) == "string" and packs.by_id(target) or nil
    if not def then return { error = "no achievement pack named " .. tostring(target) } end
    packs.assign(s_appid, def.pack.id)
    store.sync(s_appid, nil, {}, nil)
    local part = require("ach_service").ensure(s_appid, {})
    require("fresh_policy").touch(s_appid, "achievements", now_ms())
    if not part or part.status ~= "ok" then
      return { error = "the pack " .. def.pack.id .. " gave no achievements: " .. tostring(part and part.message or "unknown") }
    end
    return { ok = true, source = "pack", pack = def.pack.id, total = def.pack.count }
  elseif source == "none" then
    store.sync(s_appid, "none", {}, "none")
    require("fresh_policy").touch(s_appid, "achievements", now_ms())
    return { ok = true, source = "none" }
  elseif source == "ra" then
    if not target or target == "" then return { error = "missing RetroAchievements URL or game id" } end
    local gid_str = tostring(target):match("/game/(%d+)") or tostring(target):match("(%d+)")
    local gid = tonumber(gid_str)
    if not gid or gid <= 0 then return { error = "invalid RetroAchievements game id" } end

    local ra = require("retroachievements")
    -- The same login the normal fetch uses: the emulator's saved one first, then .env (a user with no .env confirmed a game and got
    -- "could not fetch game data" while the same game loaded fine when its page opened).
    local entry = (M.deps.entry or default_entry)(s_appid)
    local creds = ra.get_credentials(entry and entry.exe) or {}
    local schema, unlocks = ra.fetch_game_data(gid, creds.username, creds.token, true, creds.api_key)
    if not schema then
      return { error = "could not fetch game data for RetroAchievements game " .. tostring(gid) }
    end
    local schema_key = "ra_" .. tostring(gid)
    store.save_schema_and_sync(s_appid, schema_key, schema, unlocks or {}, "retroachievements")
    require("fresh_policy").touch(s_appid, "achievements", now_ms())
    return { ok = true, source = "retroachievements", title = schema.title, total = schema.total, game_id = gid }
  elseif source == "steam" then
    return { error = "a Steam achievement list is a visual list only and cannot be unlocked in a custom game: use RetroAchievements or an achievement pack" }
  else
    return { error = "unsupported source: " .. tostring(source) }
  end
end

return M
