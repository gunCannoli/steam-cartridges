--- Persistent achievement state (ADR-0032 & P5): the store only, no network (M10: the keyless Steam
--- schema fetch moved to steam_schema.lua, a source like retroachievements.lua and the trophy readers).
---
--- Storage: <data dir>/achievements.json
--- Caches native Steam schemas by native_appid and tracks local unlocks by shortcut appid.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "achievements.json"
local state = nil
M._path = nil -- test override

local function path() return M._path or data_dir.file(FILE) end

local function blank()
  return { version = 1, schemas = {}, shortcuts = {} }
end

local function load()
  if state then return state end
  state = blank()
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then
      if type(data.schemas) == "table" then state.schemas = data.schemas end
      if type(data.shortcuts) == "table" then state.shortcuts = data.shortcuts end
      state.version = 1
    end
  end
  return state
end

local function save()
  local p = path()
  local tmp = p .. ".tmp"
  local body = json.encode(load())
  local ok, err = utils.write_file(tmp, body)
  if not ok then error("could not write " .. tmp .. ": " .. tostring(err)) end
  pcall(os.remove, p)
  local renamed, rerr = os.rename(tmp, p)
  if not renamed then
    local ok2, err2 = utils.write_file(p, body)
    pcall(os.remove, tmp)
    if not ok2 then error("could not save " .. p .. ": " .. tostring(rerr or err2)) end
  end
end

function M._reset() state = nil end

local function to_schema_key(id)
  -- A source's own list: "ra_<game>", "ps3_<id>", "ps4_<id>", "epic_<namespace>", "xbox_<title id>" (ADR-0056); a number is a native appid.
  if type(id) == "string" and (id:match("^ra_") or id:match("^ps3_") or id:match("^ps4_") or id:match("^epic_") or id:match("^xbox_") or id == "none") then
    return id
  end
  return tostring(math.floor(tonumber(id) or 0))
end

function M.get_schema(native_appid)
  local s = load()
  return s.schemas[to_schema_key(native_appid)]
end

function M.save_schema(native_appid, schema)
  local s = load()
  s.schemas[to_schema_key(native_appid)] = schema
  save()
end

function M.bind_schema(shortcut_appid, schema_id)
  local s = load()
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key]
  if not sc then
    sc = { schema_appid = schema_id, unlocks = {} }
    s.shortcuts[sc_key] = sc
  else
    sc.schema_appid = schema_id
  end
  save()
end

function M.get_state(shortcut_appid, native_appid)
  local s = load()
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key]
  if not sc and native_appid then
    sc = { schema_appid = native_appid, unlocks = {} }
    s.shortcuts[sc_key] = sc
    save()
  end

  local schema_id = sc and sc.schema_appid or native_appid
  if schema_id == "none" or (sc and sc.source == "none") then
    return {
      schema = { title = "none", total = 0, achievements = {} },
      unlocks = {},
      source = "none",
      schema_appid = "none",
    }
  end

  local schema = schema_id and s.schemas[to_schema_key(schema_id)] or nil
  return {
    schema = schema,
    unlocks = sc and sc.unlocks or {},
    -- The source that wrote the unlocks when it is a synced store ("epic", "xbox"; ADR-0056), else nil.
    source = sc and sc.source or nil,
    schema_appid = sc and sc.schema_appid or nil,
  }
end

--- The shortcut's entry, created (bound to `native_appid`) when missing, re-bound when the native app changed.
function M.ensure_shortcut(shortcut_appid, native_appid)
  local nid = tonumber(native_appid) or 0
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local s = load()
  local sc = s.shortcuts[sc_key]
  if not sc then
    sc = { schema_appid = nid, unlocks = {} }
    s.shortcuts[sc_key] = sc
    save()
  elseif nid > 0 and sc.schema_appid ~= nid then
    sc.schema_appid = nid
    save()
  end
  return sc
end

function M.unlock(shortcut_appid, achievement_id, unlock_time)
  local s = load()
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key]
  if not sc then
    sc = { unlocks = {} }
    s.shortcuts[sc_key] = sc
  end
  sc.unlocks = sc.unlocks or {}
  sc.unlocks[tostring(achievement_id)] = {
    unlocked_time = tonumber(unlock_time) or os.time(),
  }
  save()
  return { ok = true, unlocks = sc.unlocks }
end

--- A store sync (ADR-0056): the shortcut's list and its unlocks as the store reports them (the store is the truth,
--- so the unlocks are replaced, not merged), and which store wrote them.
function M.sync(shortcut_appid, schema_id, unlocks, source)
  local s = load()
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key] or {}
  sc.schema_appid = schema_id
  sc.unlocks = unlocks or {}
  sc.source = source
  s.shortcuts[sc_key] = sc
  save()
  return sc
end

--- Atomically updates a schema and shortcut's unlocks in memory, saving once to disk (ADR-0056).
--- Eliminates redundant back-to-back serialization and disk writes of achievements.json.
function M.save_schema_and_sync(shortcut_appid, schema_id, schema, unlocks, source)
  local s = load()
  if schema then
    s.schemas[to_schema_key(schema_id)] = schema
  end
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key] or {}
  sc.schema_appid = schema_id
  sc.unlocks = unlocks or {}
  sc.source = source
  s.shortcuts[sc_key] = sc
  save()
  return sc
end

function M.reset(shortcut_appid)
  local s = load()
  local sc_key = tostring(math.floor(tonumber(shortcut_appid) or 0))
  local sc = s.shortcuts[sc_key]
  if sc then
    sc.unlocks = {}
    save()
  end
  return { ok = true, unlocks = {} }
end

--- Every shortcut key (a string) the store holds an entry for, in no order. Disk only (ADR-0045).
function M.shortcut_keys()
  local keys = {}
  for key in pairs(load().shortcuts) do keys[#keys + 1] = key end
  return keys
end

return M
