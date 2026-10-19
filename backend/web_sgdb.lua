local net = require("net")
local json = require("json")
local logger = require("logger")

local sgdb = {}

--- URL encode helper
local function url_encode(str)
  if not str then return "" end
  return (str:gsub("([^%w%-%_%.%~])", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

--- Strip common noise from shortcut names (e.g. "Game (USA) [v1.0].exe" -> "Game")
function sgdb.clean_title(name)
  if not name or name == "" then return "" end
  local cleaned = name
  -- Strip file extensions
  cleaned = cleaned:gsub("%.%w%w%w?%w?$", "")
  -- Strip parenthesized/bracketed metadata: (USA), [v1.0], (En,Ja), etc.
  cleaned = cleaned:gsub("%b()", "")
  cleaned = cleaned:gsub("%b[]", "")
  -- Replace underscores and dots with spaces
  cleaned = cleaned:gsub("[%.%_]", " ")
  -- Strip redundant trailing whitespace
  cleaned = cleaned:match("^%s*(.-)%s*$") or ""
  return cleaned
end

--- Perform authorized GET request to SteamGridDB API
local function api_get(endpoint, key)
  local headers = {
    ["Authorization"] = "Bearer " .. key,
    ["Accept"] = "application/json",
  }
  local res = net.get(endpoint, { source = "sgdb", headers = headers, timeout = 15 })
  if not res or res.status ~= 200 or not res.body then
    logger:warn("SteamGridDB API request failed (" .. tostring(res and res.status) .. "): " .. endpoint)
    return nil
  end

  local ok, data = pcall(json.decode, res.body)
  if not ok or type(data) ~= "table" or data.success ~= true then
    logger:warn("SteamGridDB returned invalid JSON response for " .. endpoint)
    return nil
  end

  return data.data
end

--- Search for a game by title on SteamGridDB
---@param title string
---@param key string
---@return table|nil match { id, name, release_date }
function sgdb.search_game(title, key)
  local clean = sgdb.clean_title(title)
  if clean == "" then return nil end

  local url = "https://www.steamgriddb.com/api/v2/search/autocomplete/" .. url_encode(clean)
  local data = api_get(url, key)
  if type(data) == "table" and #data > 0 and data[1].id then
    return data[1]
  end

  -- If clean search had no result and title had dashes or colons, try searching prefix
  local prefix = clean:match("^(.-)%s*[:%-]")
  if prefix and #prefix >= 3 then
    local pdata = api_get("https://www.steamgriddb.com/api/v2/search/autocomplete/" .. url_encode(prefix), key)
    if type(pdata) == "table" and #pdata > 0 and pdata[1].id then
      return pdata[1]
    end
  end

  return nil
end

--- Lookup game by Steam AppID
---@param steam_appid number
---@param key string
---@return table|nil match
function sgdb.get_by_steam_appid(steam_appid, key)
  if not steam_appid or steam_appid <= 0 then return nil end
  local url = "https://www.steamgriddb.com/api/v2/games/steam/" .. tostring(steam_appid)
  local data = api_get(url, key)
  if type(data) == "table" and data.id then
    return data
  end
  return nil
end

--- Download a SteamGridDB image (the library icon, icon plan). Replaces the uncalled
--- download_image_base64: the caller writes the raw bytes to a file.
---@param url string
---@return table|nil { body: string, ext: string }
function sgdb.download_image(url)
  if not url or url == "" then return nil end

  local res = net.get(url, { source = "sgdb", headers = { ["Accept"] = "*/*", ["User-Agent"] = "Mozilla/5.0" }, timeout = 25 })
  -- SteamGridDB CDN can cause Millennium's native http.get to return a truncated body (<100 bytes).
  -- Fallback to wsrv.nl proxy if body is truncated or empty.
  if not res or res.status ~= 200 or not res.body or #res.body < 100 then
    if url:match("steamgriddb%.com") then
      local proxy_url = "https://wsrv.nl/?url=" .. url:gsub("^https?://", "")
      local pres = net.get(proxy_url, { source = "sgdb", headers = { ["Accept"] = "*/*" }, timeout = 25 })
      if pres and pres.status == 200 and pres.body and #pres.body >= 100 then
        res = pres
      end
    end
  end

  if not res or res.status ~= 200 or not res.body or #res.body < 100 then
    logger:warn("Failed to download valid image from " .. url .. " (got " .. tostring(res and res.body and #res.body or 0) .. " bytes)")
    return nil
  end

  local ext = "png"
  local url_lower = url:lower()
  if url_lower:find("%.jpe?g") then
    ext = "jpg"
  elseif res.body:sub(1, 3) == "\255\216\255" then
    ext = "jpg"
  end

  return {
    body = res.body,
    ext = ext,
  }
end

--- Fetch artwork bundle (portrait, hero, logo, wide capsule, and the library icon when
--- `want_icon`) for a game id
---@param game_id number
---@param key string
---@param want_icon boolean|nil
---@return table bundle
function sgdb.fetch_artwork_urls(game_id, key, want_icon)
  local out = {
    portrait = nil,
    hero = nil,
    logo = nil,
    wide = nil,
    icon = nil,
  }

  -- 1. Portrait capsule (600x900)
  local grids = api_get("https://www.steamgriddb.com/api/v2/grids/game/" .. tostring(game_id) .. "?dimensions=600x900", key)
  if type(grids) == "table" and grids[1] and grids[1].url then
    out.portrait = grids[1].url
  end

  -- 2. Hero banner (1920x620)
  local heroes = api_get("https://www.steamgriddb.com/api/v2/heroes/game/" .. tostring(game_id), key)
  if type(heroes) == "table" and heroes[1] and heroes[1].url then
    out.hero = heroes[1].url
  end

  -- 3. Transparent logo PNG
  local logos = api_get("https://www.steamgriddb.com/api/v2/logos/game/" .. tostring(game_id) .. "?types=static&nsfw=false", key)
  if type(logos) == "table" and logos[1] and logos[1].url then
    out.logo = logos[1].url
  end

  -- 4. Wide capsule (920x430 or 460x215)
  local wide = api_get("https://www.steamgriddb.com/api/v2/grids/game/" .. tostring(game_id) .. "?dimensions=920x430,460x215", key)
  if type(wide) == "table" and wide[1] and wide[1].url then
    out.wide = wide[1].url
  end

  -- 5. Library icon (PNG or ICO; Steam draws both for a shortcut)
  if want_icon then out.icon = sgdb.fetch_icon_url(game_id, key) end

  return out
end

--- The library icon alone (PNG or ICO; Steam draws both for a shortcut): one request, for a shortcut whose slots
--- are all set. nil when SteamGridDB has none.
---@param game_id number
---@param key string
---@return string|nil url
function sgdb.fetch_icon_url(game_id, key)
  local icons = api_get("https://www.steamgriddb.com/api/v2/icons/game/" .. tostring(game_id) .. "?types=static&nsfw=false&mimes=image/png,image/vnd.microsoft.icon", key)
  if type(icons) == "table" and icons[1] and icons[1].url then return icons[1].url end
  return nil
end

return sgdb
