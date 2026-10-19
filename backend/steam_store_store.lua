--- Persistent Steam Store state: <data dir>/steam_store.json (ADR-0032).
---
--- User state; never auto-deleted. Holds ONLY facts about the user's non-Steam
--- shortcuts (mapping, suggestions, rejections, which art slots and library icon we wrote).
--- Native Steam data is never persisted: every keyed appid must be a shortcut.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local SHORTCUT_MIN = 0x80000000
local NEGATIVE_TTL = 7 * 24 * 3600
local FILE = "steam_store.json"

local state = nil
M._path = nil -- test override

local function path() return M._path or data_dir.file(FILE) end

local function blank()
  return { version = 1, mappings = {}, suggestions = {}, rejected = {}, applied_artwork = {}, applied_icon = {}, negative = {} }
end

local function load()
  if state then return state end
  state = blank()
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then
      for k in pairs(state) do
        if type(data[k]) == "table" then state[k] = data[k] end
      end
      state.version = 1
    end
  end
  return state
end

--- Atomic: write <file>.tmp, then rename over the target.
local function save()
  local p = path()
  local tmp = p .. ".tmp"
  local body = json.encode(load())
  local ok, err = utils.write_file(tmp, body)
  if not ok then error("could not write " .. tmp .. ": " .. tostring(err)) end
  pcall(os.remove, p) -- Windows rename does not overwrite
  local renamed, rerr = os.rename(tmp, p)
  if not renamed then
    -- Last resort: direct write so state is never lost.
    local ok2, err2 = utils.write_file(p, body)
    pcall(os.remove, tmp)
    if not ok2 then error("could not save " .. p .. ": " .. tostring(rerr or err2)) end
  end
end

local function key(appid)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then
    error("steam_store persists non-Steam shortcuts only (got appid " .. tostring(appid) .. ")")
  end
  return tostring(math.floor(n))
end

function M._reset() state = nil end
function M.is_shortcut(appid) local n = tonumber(appid); return n ~= nil and n >= SHORTCUT_MIN end

function M.is_rejected(appid, steam_appid)
  local list = load().rejected[key(appid)]
  for _, id in ipairs(list or {}) do
    if tonumber(id) == tonumber(steam_appid) then return true end
  end
  return false
end

function M.get(appid)
  local s, k = load(), key(appid)
  return {
    mapping = s.mappings[k],
    suggestions = s.suggestions[k] or {},
    rejected = s.rejected[k] or {},
    applied = s.applied_artwork[k],
    icon = s.applied_icon[k],
  }
end

function M.get_state()
  local s = load()
  return { mappings = s.mappings, suggestions = s.suggestions, rejected = s.rejected, applied_artwork = s.applied_artwork }
end

--- source: "manual" | "owned" | "search". Non-manual sources are refused for a
--- rejected id (returns nil, "rejected"); manual removes the rejection.
function M.set_mapping(appid, steam_appid, name, source, now)
  local s, k = load(), key(appid)
  steam_appid = tonumber(steam_appid)
  if not steam_appid or steam_appid <= 0 or steam_appid >= SHORTCUT_MIN then
    return nil, "invalid steam appid"
  end
  source = source or "manual"
  if source == "manual" then
    local keep = {}
    for _, id in ipairs(s.rejected[k] or {}) do
      if tonumber(id) ~= steam_appid then keep[#keep + 1] = id end
    end
    s.rejected[k] = #keep > 0 and keep or nil
  elseif M.is_rejected(appid, steam_appid) then
    return nil, "rejected"
  end
  s.mappings[k] = { steam_appid = steam_appid, name = name or "", source = source, at = now or os.time() }
  s.suggestions[k] = nil
  save()
  return s.mappings[k]
end

--- Remove the mapping. Returns { steam_appid, slots, icon? }: the art slots this
--- plugin wrote (the only ones the frontend may clear) and the library icon entry
--- it wrote (icon plan; the caller decides whether to put `previous` back).
function M.clear(appid, reject)
  local s, k = load(), key(appid)
  local mapping, applied = s.mappings[k], s.applied_artwork[k]
  local out = { steam_appid = mapping and mapping.steam_appid or (applied and applied.steam_appid), slots = {}, icon = s.applied_icon[k] }
  for _, slot in ipairs(applied and applied.slots or {}) do out.slots[#out.slots + 1] = slot end
  if reject and out.steam_appid and not M.is_rejected(appid, out.steam_appid) then
    s.rejected[k] = s.rejected[k] or {}
    table.insert(s.rejected[k], out.steam_appid)
  end
  s.mappings[k], s.applied_artwork[k], s.applied_icon[k] = nil, nil, nil
  save()
  return out
end

--- list: { { steam_appid, name, reason } }. Rejected ids are dropped.
function M.add_suggestions(appid, list)
  local s, k = load(), key(appid)
  local out = {}
  for _, it in ipairs(list or {}) do
    if not M.is_rejected(appid, it.steam_appid) then out[#out + 1] = it end
  end
  s.suggestions[k] = #out > 0 and out or nil
  save()
  return out
end

function M.remove_suggestion(appid, steam_appid)
  local s, k = load(), key(appid)
  local keep = {}
  for _, it in ipairs(s.suggestions[k] or {}) do
    if tonumber(it.steam_appid) ~= tonumber(steam_appid) then keep[#keep + 1] = it end
  end
  s.suggestions[k] = #keep > 0 and keep or nil
  save()
end

--- Reject a suggested (or any) match for a shortcut: it is never applied again.
function M.reject(appid, steam_appid)
  local s, k = load(), key(appid)
  if not M.is_rejected(appid, steam_appid) then
    s.rejected[k] = s.rejected[k] or {}
    table.insert(s.rejected[k], tonumber(steam_appid))
  end
  M.remove_suggestion(appid, steam_appid) -- saves
end

--- Record the art slots this plugin wrote (and the attempted slots that failed).
--- Refused with (false, "no mapping") unless the shortcut is still mapped to that
--- same native app: a view that finishes after the user pressed Clear must not
--- resurrect applied_artwork (P4 H5; the orphan seen live on 2315502503).
function M.record_artwork(appid, steam_appid, slots, now, failed)
  local s, k = load(), key(appid)
  local mapping = s.mappings[k]
  if not mapping or tonumber(mapping.steam_appid) ~= tonumber(steam_appid) then
    return false, "no mapping"
  end
  s.applied_artwork[k] = { steam_appid = tonumber(steam_appid), slots = slots or {}, failed = failed or {}, at = now or os.time() }
  save()
  return true
end

--- Record the art slots SteamGridDB filled for a shortcut with no Steam mapping (M5c).
--- `tried` accumulates every slot ever attempted, so a slot the user later clears in
--- Steam is never filled again (until Clear resets applied_artwork). Refused when the
--- shortcut is mapped: the Steam Store path owns art then.
function M.record_sgdb_artwork(appid, slots, tried, now)
  local s, k = load(), key(appid)
  if s.mappings[k] then return false, "mapped" end
  local prev = s.applied_artwork[k]
  local function union(a, b)
    local seen, out = {}, {}
    for _, list in ipairs({ a or {}, b or {} }) do
      for _, v in ipairs(list) do
        v = tonumber(v)
        if v and not seen[v] then seen[v] = true; out[#out + 1] = v end
      end
    end
    table.sort(out)
    return out
  end
  local same = prev and prev.source == "steamgriddb"
  s.applied_artwork[k] = {
    source = "steamgriddb",
    slots = union(same and prev.slots or nil, slots),
    tried = union(same and prev.tried or nil, tried),
    failed = {},
    at = now or os.time(),
  }
  save()
  return true
end

--- Record the library icon this plugin pointed the shortcut at (icon plan): `path` is our
--- file, `previous` the shortcuts.vdf icon value it replaced (put back on Clear). Same
--- ownership rules as the slots: a Steam CDN icon needs the shortcut still mapped to that
--- native app ("no mapping"); a SteamGridDB icon is refused once the shortcut is mapped.
function M.record_icon(appid, entry, now)
  local s, k = load(), key(appid)
  if type(entry) ~= "table" or type(entry.path) ~= "string" or entry.path == "" then return false, "invalid icon" end
  local mapping = s.mappings[k]
  if entry.source == "steamgriddb" then
    if mapping then return false, "mapped" end
  elseif not mapping or tonumber(mapping.steam_appid) ~= tonumber(entry.steam_appid) then
    return false, "no mapping"
  end
  s.applied_icon[k] = {
    path = entry.path,
    previous = type(entry.previous) == "string" and entry.previous or "",
    source = entry.source == "steamgriddb" and "steamgriddb" or "steam-cdn",
    steam_appid = entry.source ~= "steamgriddb" and tonumber(entry.steam_appid) or nil,
    at = now or os.time(),
  }
  save()
  return true
end

--- The user pointed the shortcut at another icon: the user wins, and this plugin never
--- sets or restores its icon again (until Clear forgets the entry).
function M.release_icon(appid)
  local s, k = load(), key(appid)
  local entry = s.applied_icon[k]
  if not entry or entry.released then return entry end
  entry.released = true
  save()
  return entry
end

--- Grid file names Steam writes for a custom art slot (SetCustomArtworkForApp).
local SLOT_SUFFIX = { [0] = "p", [1] = "_hero", [2] = "_logo", [3] = "" }

function M.slot_files(appid, slot)
  local suffix = SLOT_SUFFIX[tonumber(slot)]
  if suffix == nil then return {} end
  local base = key(appid) .. suffix
  return { base .. ".png", base .. ".jpg", base .. ".jpeg" }
end

--- Drop recorded slots whose grid file is gone: the user removed that art in
--- Steam, the user wins, and the slot is never written again (P4 H5).
--- `exists(name)` checks one grid file name. Returns the pruned entry or nil.
function M.prune_missing_slots(appid, exists)
  local s, k = load(), key(appid)
  local applied = s.applied_artwork[k]
  if not applied then return nil end
  local keep, changed = {}, false
  for _, slot in ipairs(applied.slots or {}) do
    local present = false
    for _, name in ipairs(M.slot_files(appid, slot)) do
      if exists(name) then present = true break end
    end
    if present then keep[#keep + 1] = slot else changed = true end
  end
  if changed then
    applied.slots = keep
    save()
  end
  return applied
end

function M.is_negative(norm_title, now)
  local at = load().negative[norm_title]
  return at ~= nil and ((now or os.time()) - tonumber(at)) < NEGATIVE_TTL
end

function M.set_negative(norm_title, now)
  if not norm_title or norm_title == "" then return end
  load().negative[norm_title] = now or os.time()
  save()
end

return M
