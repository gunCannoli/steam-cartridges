--- Store appdetails: fallback metadata source for a mapped native app
--- (the frontend's StoreItemCache is tried first; ADR-0009 ladder).
---
--- The cache is in memory only (7-day TTL). Native Steam data is never written
--- to disk (only non-Steam shortcut state is persisted; ADR-0032).
--- Fetch shape adapted from research/game-data-linker `fetch_game_data` (MIT).

local json     = require("json")
local throttle = require("steam_store_throttle")

local M = {}

local TTL = 7 * 24 * 3600
local cache = {}

function M._reset() cache = {} end

local MONTHS = { jan = 1, feb = 2, mar = 3, apr = 4, may = 5, jun = 6, jul = 7, aug = 8, sep = 9, oct = 10, nov = 11, dec = 12 }

local floor = math.floor

-- Days since 1970-01-01 for a proleptic Gregorian date (timezone independent).
-- No `//` operator: the backend runs on LuaJIT (Lua 5.1 syntax).
local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = floor((y >= 0 and y or y - 399) / 400)
  local yoe = y - era * 400
  local doy = floor((153 * (m + (m > 2 and -3 or 9)) + 2) / 5) + d - 1
  local doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

--- "13 Sep, 2017" | "Sep 13, 2017" | "Sep 2017" | "2017" -> epoch (UTC); else 0.
function M.parse_date(s)
  s = tostring(s or "")
  local d, mon, y = s:match("^(%d+)%s+(%a+),?%s+(%d%d%d%d)$")
  if not d then
    mon, d, y = s:match("^(%a+)%s+(%d+),?%s+(%d%d%d%d)$")
  end
  if not d then
    mon, y = s:match("^(%a+)%s+(%d%d%d%d)$")
    d = "1"
  end
  if not mon then
    y = s:match("^(%d%d%d%d)$")
    if y then return days_from_civil(tonumber(y), 1, 1) * 86400 end
    return 0
  end
  local m = MONTHS[mon:sub(1, 3):lower()]
  if not m then return 0 end
  return days_from_civil(tonumber(y), m, tonumber(d)) * 86400
end

function M.strip_html(s)
  s = tostring(s or "")
  s = s:gsub("<br%s*/?>", " "):gsub("<[^>]*>", "")
  s = s:gsub("&quot;", '"'):gsub("&#39;", "'"):gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&nbsp;", " "):gsub("&amp;", "&")
  return (s:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", ""))
end

local CATEGORY_FLAGS = {
  [2] = "single_player",
  [1] = "multiplayer", [36] = "multiplayer", [49] = "multiplayer",
  [9] = "coop", [38] = "coop",
  [24] = "split_screen", [37] = "split_screen", [39] = "split_screen",
  [28] = "full_controller",
  [18] = "partial_controller",
  [44] = "remote_play_together",
}

--- appdetails `data` -> ConsolidatedMetadata. `achievements` is always false
--- (P5 owns achievements). Every flag is explicit so the frontend never
--- defaults full_controller on.
---@param data table
---@param shortcut_appid? number
function M.to_metadata(data, shortcut_appid)
  local cats = {
    single_player = false, multiplayer = false, coop = false, split_screen = false,
    full_controller = false, partial_controller = false, achievements = false,
    remote_play_together = false,
  }
  for _, c in ipairs(data.categories or {}) do
    local flag = CATEGORY_FLAGS[tonumber(c.id)]
    if flag then cats[flag] = true end
  end
  local genres = {}
  for _, g in ipairs(data.genres or {}) do
    if g.description then genres[#genres + 1] = g.description end
  end
  local desc = M.strip_html(data.short_description)
  return {
    appid = shortcut_appid,
    title = data.name,
    description = desc,
    short_description = desc,
    developers = data.developers or {},
    publishers = data.publishers or {},
    franchises = {},
    release_date = M.parse_date(data.release_date and data.release_date.date),
    genres = genres,
    categories = cats,
    source = "steam-store",
    steam_appid = tonumber(data.steam_appid),
  }
end

--- Fetch (or serve from the in-memory cache) the appdetails `data` table.
---@param steam_appid number
---@param http_get? fun(url: string): string|nil, string|nil
---@param opts? { force?: boolean, now?: number }
---@return table|nil data, string|nil err, boolean|nil cached
function M.fetch(steam_appid, http_get, opts)
  opts = opts or {}
  local now = opts.now or os.time()
  local id = tostring(math.floor(tonumber(steam_appid) or 0))
  local hit = cache[id]
  if hit and not opts.force and now - hit.at < TTL then return hit.data, nil, true end

  http_get = http_get or throttle.http_get
  local body, err = http_get("https://store.steampowered.com/api/appdetails?appids=" .. id .. "&l=english&cc=us")
  if not body then return nil, tostring(err or "request failed") end
  local ok, res = pcall(json.decode, body)
  local entry = ok and type(res) == "table" and res[id] or nil
  if type(entry) ~= "table" or not entry.success or type(entry.data) ~= "table" then
    return nil, "app not found"
  end
  cache[id] = { at = now, data = entry.data }
  return entry.data, nil, false
end

return M
