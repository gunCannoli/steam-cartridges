--- When is a part of a record stale? (migration plan M7a).
---
--- Per (appid, part) the time it was last checked, in ms, in <data dir>/freshness.json (a new file,
--- so no existing format changes): { version = 1, parts = { ["<appid>"] = { identity = ms, metadata = ms,
--- achievements = ms } } }. One table of TTLs decides what is stale. ADR-0060 adds, per part, the status of
--- the last check when it was not ok (`achievements_status = "unsupported"`), so a part with nothing stored
--- is not looked up again until that status comes due (M.remembered).
---
--- Never stale: anything with source "custom" (a user's manual edit, K15), an identity with a native
--- Steam match (sticky; the user clears it in settings) and achievements the user marked "none".

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local HOUR = 3600 * 1000
local DAY = 24 * HOUR

--- TTLs in ms. `false` = never stale.
M.TTL = {
  identity_ok_no_native = 7 * DAY,     -- same as the store search negative cache
  metadata_ok = 24 * HOUR,             -- igdb / screenscraper / fallback: Flow B
  achievements_ok = 24 * HOUR,         -- the schema; unlocks are read on every open by their own channels
  achievements_ra = 30 * 60 * 1000,    -- RetroAchievements unlocks: one profile plays on several devices, so a page
                                       -- open asks again, at most this often per game (the user's choice: spare RA)
  media_ok = 7 * DAY,                  -- community media (features plan F2): trailers and art rarely change
  unsupported = 24 * HOUR,             -- a route or source may change (credentials, settings)
  error = 30 * 60 * 1000,              -- retry soon, never in a loop
}

local FILE = "freshness.json"
local state = nil
M._path = nil -- test override

local function path() return M._path or data_dir.file(FILE) end

local function load()
  if state then return state end
  state = { version = 1, parts = {} }
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" and type(data.parts) == "table" then state.parts = data.parts end
  end
  return state
end

local function save()
  local tmp = path() .. ".tmp"
  local ok, err = utils.write_file(tmp, json.encode(load()))
  if not ok then error("could not write " .. tmp .. ": " .. tostring(err)) end
  pcall(os.remove, path())
  if not os.rename(tmp, path()) then
    utils.write_file(path(), json.encode(load()))
    pcall(os.remove, tmp)
  end
end

--- Errors seen this session, per (appid, part), for the parts whose error is not stored on disk (identity,
--- artwork). EnsureFresh answers a repeat within M.TTL.error from here instead of the network, so the
--- frontend keeps no retry timer of its own (M10). Memory only: freshness.json does not change.
local recent = {}

function M._reset() state = nil; recent = {} end

local function key(appid) return tostring(math.floor(tonumber(appid) or 0)) end

--- Unix ms when this part was last checked, or nil.
function M.checked_at(appid, part)
  local entry = load().parts[key(appid)]
  return entry and tonumber(entry[part]) or nil
end

--- The TTL for a part in a given result state, or false (never stale).
--- `info` is a status string or a Part-like table { status, source, data }.
local function ttl_for(part, info)
  local status = type(info) == "table" and info.status or info
  local source = type(info) == "table" and info.source or nil
  if source == "custom" then return false end
  if status == "none" then return false end -- the user's "no achievements" mark; cleared by the user only
  if status == "error" then return M.TTL.error end
  if status == "ok" then
    if part == "identity" then
      local native = type(info) == "table" and info.data and info.data.native
      if native then return false end
      return M.TTL.identity_ok_no_native
    end
    if part == "metadata" then return M.TTL.metadata_ok end
    if part == "achievements" then
      if source == "retroachievements" then return M.TTL.achievements_ra end
      return M.TTL.achievements_ok
    end
    if part == "media" then return M.TTL.media_ok end
    return M.TTL.metadata_ok
  end
  if status == "unsupported" then return M.TTL.unsupported end
  return 0 -- pending, needs-setup, partial, unknown: always worth asking again
end

--- Is this part due for a refresh at `now` (ms)? Never checked counts as stale, except when the
--- policy says "never".
function M.is_stale(appid, part, info, now)
  local ttl = ttl_for(part, info)
  if ttl == false then return false end
  local at = M.checked_at(appid, part)
  if not at then return true end
  return (now or 0) - at >= ttl
end

--- The ok TTL an error check is backdated against (touch), so it comes due after M.TTL.error.
local function error_base(part)
  return (part == "identity" and M.TTL.identity_ok_no_native) or (part == "media" and M.TTL.media_ok)
    or M.TTL.metadata_ok
end

--- Record a check at `now` (ms). An `error` result is backdated so it comes due after the short
--- error TTL instead of the long ok TTL. `unsupported` and `error` are remembered (M.remembered); an `unsupported`
--- one keeps `sig` (what the caller could answer then), when given.
function M.touch(appid, part, now, status, sig)
  local s = load()
  local k = key(appid)
  s.parts[k] = s.parts[k] or {}
  local at = now
  if status == "error" then
    at = now - (error_base(part) - M.TTL.error)
  end
  s.parts[k][part] = at
  s.parts[k][part .. "_status"] = (status == "unsupported" or status == "error") and status or nil
  s.parts[k][part .. "_sig"] = (status == "unsupported" and type(sig) == "string") and sig or nil
  -- Bookkeeping only: a disk error costs a refetch later, never a failed EnsureFresh.
  return pcall(save)
end

--- The status of the last check of a part when it was "unsupported" or "error", else nil.
function M.last_status(appid, part)
  local entry = load().parts[key(appid)]
  local status = entry and entry[part .. "_status"]
  if status == "unsupported" or status == "error" then return status end
  return nil
end

--- ADR-0060: a check that found no source (`unsupported`, for M.TTL.unsupported) or failed (`error`, for
--- M.TTL.error) and has not come due at `now` (ms): { status, at }, else nil. A part with nothing stored
--- answers this instead of asking its sources again on every view, ingest run and observer poll.
--- With `sig`, an `unsupported` found with another signature (or none) is not remembered: the caller can answer
--- more now (ADR-0072).
function M.remembered(appid, part, now, sig)
  local status = M.last_status(appid, part)
  if not status then return nil end
  if status == "unsupported" and sig ~= nil then
    local entry = load().parts[key(appid)]
    if not entry or entry[part .. "_sig"] ~= sig then return nil end
  end
  local at = M.checked_at(appid, part)
  if not at then return nil end
  local ttl = status == "unsupported" and M.TTL.unsupported or error_base(part)
  if (now or 0) - at >= ttl then return nil end
  return { status = status, at = at }
end

--- Remember an error part at `now` (ms); an ok result forgets it.
function M.remember_error(appid, part, now, value)
  recent[key(appid) .. ":" .. part] = { at = now, value = value }
end

function M.forget_error(appid, part)
  recent[key(appid) .. ":" .. part] = nil
end

--- The error part seen for (appid, part) less than M.TTL.error ago, or nil.
function M.recent_error(appid, part, now)
  local k = key(appid) .. ":" .. part
  local e = recent[k]
  if not e then return nil end
  if (now or 0) - e.at >= M.TTL.error then
    recent[k] = nil
    return nil
  end
  return e.value
end


--- Every shortcut key (a string) with a check recorded, in no order (prune_removed.lua).
function M.keys()
  local out = {}
  for k in pairs(load().parts) do out[#out + 1] = k end
  return out
end

--- How many games last ended each part in "error" vs "unsupported" (freshness.json): counts only, for the
--- startup health line. `parts` names the parts to count; unknown entries are skipped, never throw.
---@param parts string[]
---@return table<string, { error: integer, unsupported: integer }>
function M.error_counts(parts)
  local out = {}
  for _, part in ipairs(type(parts) == "table" and parts or {}) do
    if type(part) == "string" then out[part] = { error = 0, unsupported = 0 } end
  end
  local all = load().parts
  if type(all) ~= "table" then return out end
  for _, entry in pairs(all) do
    if type(entry) == "table" then
      for part, c in pairs(out) do
        local st = entry[part .. "_status"]
        if st == "error" then c.error = c.error + 1 elseif st == "unsupported" then c.unsupported = c.unsupported + 1 end
      end
    end
  end
  return out
end

--- Forget one part's check, so it counts as never checked (and any remembered unsupported / error with it).
function M.forget_part(appid, part)
  local entry = load().parts[key(appid)]
  if not entry then return true end
  entry[part], entry[part .. "_status"], entry[part .. "_sig"] = nil, nil, nil
  recent[key(appid) .. ":" .. part] = nil
  return pcall(save)
end

--- Forget every check of a shortcut (prune_removed.lua).
function M.forget(appid)
  load().parts[key(appid)] = nil
  return pcall(save)
end

return M
