--- Reads Steam's own screenshot index, for the library grid.
---
--- Scope note: this module used to parse recordings too (clip.pb protobuf,
--- DASH manifests, session windows) to build the app detail page. The frontend
--- now gets screenshots and clips from Steam's own APIs instead
--- (ADR-0022), so only the grid's counts are still read here. The removed
--- parsers are in git history if the activity feed ever needs them.
---
--- Screenshots are indexed by userdata/<id>/760/screenshots.vdf, which - unlike
--- shortcuts.vdf - is TEXT VDF:
---
---   "screenshots"
---   {
---     "18310622842007322624"     <- gameid
---     {
---       "0"
---       {
---         "filename"   "18310622842007322624/screenshots/20251024002134_1.jpg"
---         "thumbnail"  "…/thumbnails/20251024002134_1.jpg"
---         "creation"   "1761276095"   <- unix seconds
---         "width"      "3840"
---         "height"     "2160"
---       }
---     }
---   }
---
--- Paths are relative to userdata/<id>/760/remote/.

local fs     = require("fs")
local utils  = require("utils")
local logger = require("logger")
local gameid = require("gameid")

local captures = {}

--- Steam assigns non-Steam shortcuts appids at the top of the 32-bit range.
--- Matches the frontend SDK's NON_STEAM_APP_APPID_MASK.
local NON_STEAM_APPID_MIN = 0x80000000

---@class captures.Screenshot
---@field path string       Absolute path on disk
---@field thumb string|nil  Absolute path to Steam's thumbnail, if present
---@field taken_at integer  Unix seconds
---@field width integer
---@field height integer

--- Parse the text VDF into { [gameid] = { {filename=…, creation=…}, … } }.
---
--- Nesting is what distinguishes a game key from a screenshot index - NOT the
--- length of the number. A Steam appid like "238960" is the same shape as the
--- screenshot index "0"; only depth tells them apart:
---
---   "screenshots"          depth 0
---   {
---     "18310622842007322624"   depth 1  <- game
---     {
---       "0"                    depth 2  <- screenshot
---       {
---         "filename" "…"       depth 3  <- field
---
--- So we track brace depth rather than guessing from the key.
---@param content string
---@return table<string, table[]>
local function parse_screenshots_vdf(content)
  local games = {}
  local depth = 0
  local pending = nil    ---@type string|nil  key awaiting its opening brace
  local current_game = nil
  local current_shot = nil

  for line in content:gmatch("[^\r\n]+") do
    local trimmed = line:match("^%s*(.-)%s*$")

    if trimmed == "{" then
      -- The key we just saw opens a block at this depth.
      if depth == 1 and pending then
        current_game = pending
        games[current_game] = games[current_game] or {}
        current_shot = nil
      elseif depth == 2 and pending and current_game then
        current_shot = {}
        local list = games[current_game]
        list[#list + 1] = current_shot
      end
      pending = nil
      depth = depth + 1
    elseif trimmed == "}" then
      depth = depth - 1
      if depth <= 1 then current_shot = nil end
      if depth <= 0 then current_game = nil end
      pending = nil
    else
      local key, value = trimmed:match('^"([^"]+)"%s+"([^"]*)"$')
      if key then
        -- A key/value pair: only meaningful inside a screenshot block.
        if current_shot and depth == 3 then
          local lowered = key:lower()
          if lowered == "filename" or lowered == "thumbnail" then
            current_shot[lowered] = value
          elseif lowered == "creation" or lowered == "width" or lowered == "height" then
            current_shot[lowered] = tonumber(value)
          end
        end
      else
        -- A bare quoted key: remember it until its brace arrives.
        pending = trimmed:match('^"([^"]+)"$') or pending
      end
    end
  end

  return games
end

local cache = { mtime = -1, games = nil } ---@type table

--- Load and index every screenshot, keyed by gameid string.
---@param paths steam_paths.Paths
---@return table<string, table[]> games
local function load_index(paths)
  if not fs.is_file(paths.screenshots_vdf) then
    return {}
  end

  local mtime = fs.last_write_time(paths.screenshots_vdf) or 0
  if cache.games and cache.mtime == mtime then
    return cache.games
  end

  local content, err = utils.read_file(paths.screenshots_vdf)
  if not content then
    logger:warn("could not read screenshots.vdf: " .. tostring(err))
    return {}
  end

  local games = parse_screenshots_vdf(content)
  cache.mtime = mtime
  cache.games = games
  return games
end

--- Every gameid in the screenshot index that belongs to a non-Steam game.
--- Includes ids whose shortcut has since been deleted - callers decide whether
--- to show those. Skips empty blocks: Steam keeps `"<gameid>" { }` after its
--- screenshots are deleted (WUCHANG, 2026-09-30), and that game has no media.
---@param paths steam_paths.Paths
---@return table<integer, integer> counts  appid -> screenshot count
function captures.non_steam_counts(paths)
  local games = load_index(paths)
  local counts = {}
  for id, list in pairs(games) do
    if #list > 0 and gameid.is_non_steam(id) then
      local appid = gameid.to_appid(id)
      if appid then counts[appid] = #list end
    end
  end
  return counts
end

--- Per-app capture summary for the library grid.
---
--- `newest` is the most recent capture time and doubles as evidence the game
--- was played: Steam leaves `rt_last_time_played` at 0 for shortcuts it did not
--- launch itself, even when screenshots plainly exist.
---
--- Reads the screenshot index only (cheap, already cached). Walking the clips
--- directory for every app is not worth it for a grid.
---@param paths steam_paths.Paths
---@return table<integer, table> stats  appid -> { screenshots, newest }
function captures.library_stats(paths)
  local games = load_index(paths)
  local out = {}

  for id, list in pairs(games) do
    if #list > 0 and gameid.is_non_steam(id) then
      local appid = gameid.to_appid(id)
      if appid then
        local newest = 0
        for _, shot in ipairs(list) do
          local at = shot.creation or 0
          if at > newest then newest = at end
        end
        out[appid] = { screenshots = #list, newest = newest }
      end
    end
  end

  return out
end

return captures
