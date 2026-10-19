--- Source `steam` of the achievements service (ach_service.lua): a native Steam game's achievement
--- schema, keyless, from the public percentages WebAPI and the Community HTML page (ADR-0032 & P5).
--- Moved out of achievements_store.lua (M10): the store stores, this fetches.

local json  = require("json")
local store = require("achievements_store")

local M = {}

function M.strip_html(s)
  s = tostring(s or "")
  s = s:gsub("<br%s*/?>", " "):gsub("<[^>]*>", "")
  s = s:gsub("&quot;", '"'):gsub("&#39;", "'"):gsub("&#039;", "'")
  s = s:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&nbsp;", " "):gsub("&amp;", "&")
  return (s:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Parses Steam Community achievements HTML page into list of { icon, name, description }
function M.parse_community_html(html)
  local items = {}
  if not html or #html == 0 then return items end

  for block in html:gmatch('<div class="achieveRow%s*">(.-)<div style="clear: both;"></div>') do
    local icon = block:match('<div class="achieveImgHolder">%s*<img src="([^"]+)"')
    local title = block:match('<div class="achieveTxt">.-<h3>(.-)</h3>')
    local desc  = block:match('<div class="achieveTxt">.-<h5>(.-)</h5>')
    items[#items + 1] = {
      icon = icon or "",
      name = M.strip_html(title or ""),
      description = M.strip_html(desc or ""),
    }
  end

  return items
end

--- Parses Steam WebAPI GetGlobalAchievementPercentagesForApp response into list of { id, percent }
function M.parse_webapi_percentages(body)
  local items = {}
  if not body or #body == 0 then return items end
  local ok, data = pcall(json.decode, body)
  if not ok or type(data) ~= "table" then return items end
  local pct_table = data.achievementpercentages
  if type(pct_table) ~= "table" or type(pct_table.achievements) ~= "table" then return items end

  for _, entry in ipairs(pct_table.achievements) do
    if entry.name then
      items[#items + 1] = {
        id = tostring(entry.name),
        percent = tonumber(entry.percent) or 0,
      }
    end
  end
  return items
end

--- Merges WebAPI percentages and Community HTML into canonical schema.
function M.merge_schema(native_appid, webapi_items, html_items)
  local achievements = {}
  html_items = html_items or {}

  for i, api_item in ipairs(webapi_items) do
    local html = html_items[i]
    local name = (html and #html.name > 0) and html.name or api_item.id
    local desc = html and html.description or ""
    local icon = html and html.icon or ""
    achievements[#achievements + 1] = {
      id = api_item.id,
      name = name,
      description = desc,
      icon = icon,
      global_pct = api_item.percent,
    }
  end

  return {
    native_appid = tonumber(native_appid) or 0,
    total = #achievements,
    fetched_at = os.time(),
    achievements = achievements,
  }
end

local function default_http_get(url, is_json)
  local net = require("net")
  local accept = is_json and "application/json" or "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  local ok, res = pcall(net.get, url, {
    source = "steam-web",
    headers = {
      ["Accept"] = accept,
      ["User-Agent"] = "steam-cartridges (Millennium plugin)",
    },
    timeout = 10,
  })
  if not ok or not res or not res.status or res.status ~= 200 or not res.body then
    return nil, (res and res.status) and ("HTTP " .. tostring(res.status)) or "request failed"
  end
  return res.body
end

--- Fetches a schema keylessly from Steam public endpoints (not stored: get_or_fetch stores it).
function M.fetch(native_appid, http_get_json, http_get_html)
  local id = tostring(math.floor(tonumber(native_appid) or 0))
  if id == "0" then return nil, "invalid native appid" end

  local get_json = http_get_json or function(u) return default_http_get(u, true) end
  local get_html = http_get_html or function(u) return default_http_get(u, false) end

  local api_url = "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=" .. id
  local api_body, err = get_json(api_url)
  if not api_body then
    return nil, "percentages fetch failed: " .. tostring(err)
  end

  local webapi_items = M.parse_webapi_percentages(api_body)
  if #webapi_items == 0 then
    return nil, "no achievements found in percentages"
  end

  local html_url = "https://steamcommunity.com/stats/" .. id .. "/achievements/"
  local html_body = get_html(html_url)
  local html_items = html_body and M.parse_community_html(html_body) or {}

  local schema = M.merge_schema(id, webapi_items, html_items)
  return schema
end

--- The shortcut's schema (stored, else fetched and stored) and its unlocks.
function M.get_or_fetch(shortcut_appid, native_appid, http_get_json, http_get_html)
  local nid = tonumber(native_appid) or 0
  local sc = store.ensure_shortcut(shortcut_appid, nid)
  local schema = (nid > 0) and store.get_schema(nid) or nil
  if not schema and nid > 0 then
    local fetched, err = M.fetch(nid, http_get_json, http_get_html)
    if not fetched then
      return { schema = nil, unlocks = sc.unlocks, error = err }
    end
    store.save_schema(nid, fetched)
    schema = fetched
  end
  return {
    schema = schema,
    unlocks = sc.unlocks or {},
  }
end

return M
