local net = require("net")
local json = require("json")
local logger = require("logger")
local config = require("web_config")

local igdb = {}

local cached_token = nil
local token_expires_at = 0

--- Robust multi-binding HTTP POST wrapper
--- Compatible with Millennium's varying Lua http bindings
local function http_post(url, headers, body, timeout)
  return net.post(url, body, { source = "igdb", headers = headers, timeout = timeout or 20 })
end

--- Obtain or refresh Twitch OAuth2 access token for IGDB
---@return string|nil token
local function get_access_token()
  local now = os.time()
  if cached_token and now < token_expires_at then
    return cached_token
  end

  local creds = config.get_twitch_credentials()
  if not creds then
    logger:warn("Twitch credentials (twitch_client_id, twitch_client_secret) not found in .env")
    return nil
  end

  local token_url = "https://id.twitch.tv/oauth2/token?client_id=" .. creds.client_id ..
                    "&client_secret=" .. creds.client_secret ..
                    "&grant_type=client_credentials"

  local res = http_post(token_url, { ["Accept"] = "application/json" }, "", 15)
  if not res or res.status ~= 200 or not res.body then
    logger:error("Failed to authenticate with Twitch OAuth2: " .. tostring(res and res.status) .. " " .. tostring(res and res.body))
    return nil
  end

  local ok, data = pcall(json.decode, res.body)
  if not ok or type(data) ~= "table" or not data.access_token then
    logger:error("Invalid JSON response from Twitch OAuth token endpoint")
    return nil
  end

  cached_token = data.access_token
  local expires_in = tonumber(data.expires_in) or 3600
  token_expires_at = now + (expires_in - 300) -- refresh 5 minutes early
  logger:info("Obtained fresh Twitch OAuth token for IGDB (valid for " .. tostring(expires_in) .. "s)")
  return cached_token
end

--- Clean shortcut name for IGDB search
local function clean_title(name)
  if not name or name == "" then return "" end
  local cleaned = name
  cleaned = cleaned:gsub("%.%w%w%w?%w?$", "") -- strip extensions
  cleaned = cleaned:gsub("%b()", "")          -- strip (USA), (Rev 1), etc.
  cleaned = cleaned:gsub("%b[]", "")          -- strip [v1.0], etc.
  -- Strip regional slash alternatives: "Aero Fighters 3 / Sonic Wings 3" -> "Aero Fighters 3"
  if cleaned:find("/") then
    local first = cleaned:match("^(.-)%s*/")
    if first and #first:gsub("%s+", "") >= 2 then
      cleaned = first
    end
  end
  cleaned = cleaned:gsub("_", " ")            -- replace underscores
  -- Normalize "Mother 1 + 2" -> "Mother 1+2"
  cleaned = cleaned:gsub("%s*%+%s*", "+")
  -- Normalize single-letter dotted acronyms: "E. V. O." -> "E.V.O."
  cleaned = cleaned:gsub("([%a])%.%s+([%a])%.", "%1.%2.")
  cleaned = cleaned:gsub("([%a])%.%s+([%a])%f[%A]", "%1.%2")
  cleaned = cleaned:gsub('"', "")             -- strip quotes
  cleaned = cleaned:gsub("%s+", " ")          -- collapse multiple spaces
  cleaned = cleaned:match("^%s*(.-)%s*$") or ""
  return cleaned
end

--- Escape string for APICalypse query
local function escape_query(str)
  return (str:gsub('"', '\\"'))
end

--- Query IGDB games endpoint
---@param apicalypse_query string
---@return table|nil
local function query_igdb(apicalypse_query)
  local creds = config.get_twitch_credentials()
  if not creds then return nil end

  local token = get_access_token()
  if not token then return nil end

  local headers = {
    ["Client-ID"] = creds.client_id,
    ["Authorization"] = "Bearer " .. token,
    ["Content-Type"] = "text/plain",
    ["Accept"] = "application/json",
  }

  local res = http_post("https://api.igdb.com/v4/games", headers, apicalypse_query, 15)
  if not res or res.status ~= 200 or not res.body then
    logger:warn("IGDB API query failed (status " .. tostring(res and res.status) .. "): " .. tostring(res and res.body))
    return nil
  end

  local ok, data = pcall(json.decode, res.body)
  if not ok or type(data) ~= "table" then
    logger:warn("IGDB returned invalid JSON response")
    return nil
  end

  return data
end

--- Smart sentence truncation: cuts text cleanly at a sentence-ending period (.!?)
--- targeting target_len with leeway, avoiding broken sentences or massive walls of text.
local function truncate_smart(text, target_len, max_leeway)
  if not text or text == "" then return "" end
  text = text:match("^%s*(.-)%s*$")
  target_len = target_len or 400
  max_leeway = max_leeway or 120

  if #text <= target_len then
    return text
  end

  local best_cut = nil
  local pos = 1
  local len = #text

  while pos <= len do
    local dot_start, dot_end = text:find("[%.%!%?][%s\r\n]", pos)
    if not dot_start then
      local last_char = text:sub(len, len)
      if last_char == "." or last_char == "!" or last_char == "?" then
        dot_start = len
      end
      break
    end

    local sentence_end = dot_start
    if sentence_end >= 80 then
      if sentence_end <= (target_len + max_leeway) then
        best_cut = sentence_end
        if sentence_end >= (target_len - 50) then
          break
        end
      else
        if not best_cut then
          best_cut = sentence_end
        end
        break
      end
    end

    pos = dot_end + 1
  end

  if best_cut and best_cut > 0 then
    return text:sub(1, best_cut):match("^%s*(.-)%s*$")
  end

  if #text > target_len + max_leeway then
    local cut = text:sub(1, target_len + max_leeway)
    local last_space = cut:match("^(.*)%s")
    return (last_space or cut) .. "..."
  end

  return text
end

--- Detect platform hints from shortcut info (exe, launch options, tags)
local function detect_platform_hints(shortcut)
  if not shortcut then return {} end
  -- The platform verdict's answer, when the caller has one (Library Setup, plan Q1): IGDB's own platform ids
  -- (platforms.lua), no guessing from the command line. "id:<platform>" names it in the log and keeps #hints > 0.
  if type(shortcut.platform) == "string" then
    local p = require("platforms").BY_ID[shortcut.platform]
    if p and p.igdb then
      local want = {}
      for _, id in ipairs(p.igdb) do want[id] = true end
      return { "id:" .. shortcut.platform, igdb_ids = want }
    end
  end
  local text_parts = {
    shortcut.exe or "",
    shortcut.launch_options or "",
    shortcut.name or "",
  }
  if type(shortcut.tags) == "table" then
    for _, t in ipairs(shortcut.tags) do
      text_parts[#text_parts + 1] = tostring(t)
    end
  end
  for k, v in pairs(shortcut) do
    if type(k) == "number" or tonumber(k) then
      text_parts[#text_parts + 1] = tostring(v)
    end
  end

  local text = string.lower(table.concat(text_parts, " "))
  local hints = {}
  local function add_hint(h) hints[#hints + 1] = h end

  if text:find("snes") or text:find("snes9x") or text:find("bsnes") or text:find("super nintendo") or text:find("super famicom") or text:find("sfc") then
    add_hint("snes")
  end
  if text:find("%f[%a]nes%f[%A]") or text:find("fceumm") or text:find("nestopia") or text:find("mesen") or text:find("famicom") then
    add_hint("nes")
  end
  if text:find("genesis") or text:find("megadrive") or text:find("sega") or text:find("genesis_plus_gx") or text:find("%f[%a]md%f[%A]") then
    add_hint("genesis")
  end
  if text:find("%f[%a]gba%f[%A]") or text:find("mgba") or text:find("vba") or text:find("game boy advance") then
    add_hint("gba")
  end
  if text:find("%f[%a]gb%f[%A]") or text:find("%f[%a]gbc%f[%A]") or text:find("gambatte") or text:find("game boy") then
    add_hint("gb")
  end
  if text:find("%f[%a]n64%f[%A]") or text:find("mupen64") or text:find("parallel") or text:find("nintendo 64") then
    add_hint("n64")
  end
  if text:find("%f[%a]psx%f[%A]") or text:find("%f[%a]ps1%f[%A]") or text:find("duckstation") or text:find("mednafen_psx") or text:find("playstation") then
    add_hint("ps1")
  end
  if text:find("%f[%a]psp%f[%A]") or text:find("ppsspp") then
    add_hint("psp")
  end
  if text:find("arcade") or text:find("mame") or text:find("fbneo") or text:find("cps1") or text:find("cps2") or text:find("cps3") or text:find("neogeo") then
    add_hint("arcade")
  end

  return hints
end

--- Latin letters with accents (UTF-8, U+00C0..U+017F) as their plain letter: "Ōkami" is "Okami", "Pokémon" "Pokemon".
local FOLD_RANGES = {
  { 0xC0, 0xC5, "a" }, { 0xC7, 0xC7, "c" }, { 0xC8, 0xCB, "e" }, { 0xCC, 0xCF, "i" }, { 0xD1, 0xD1, "n" },
  { 0xD2, 0xD6, "o" }, { 0xD8, 0xD8, "o" }, { 0xD9, 0xDC, "u" }, { 0xDD, 0xDD, "y" }, { 0xDF, 0xDF, "ss" },
  { 0xE0, 0xE5, "a" }, { 0xE7, 0xE7, "c" }, { 0xE8, 0xEB, "e" }, { 0xEC, 0xEF, "i" }, { 0xF1, 0xF1, "n" },
  { 0xF2, 0xF6, "o" }, { 0xF8, 0xF8, "o" }, { 0xF9, 0xFC, "u" }, { 0xFD, 0xFF, "y" },
  { 0x100, 0x105, "a" }, { 0x106, 0x10D, "c" }, { 0x10E, 0x111, "d" }, { 0x112, 0x11B, "e" }, { 0x11C, 0x123, "g" },
  { 0x124, 0x127, "h" }, { 0x128, 0x131, "i" }, { 0x134, 0x135, "j" }, { 0x136, 0x138, "k" }, { 0x139, 0x142, "l" },
  { 0x143, 0x14B, "n" }, { 0x14C, 0x151, "o" }, { 0x154, 0x159, "r" }, { 0x15A, 0x161, "s" }, { 0x162, 0x167, "t" },
  { 0x168, 0x173, "u" }, { 0x174, 0x175, "w" }, { 0x176, 0x178, "y" }, { 0x179, 0x17E, "z" },
}
local function fold_accents(s)
  return (s:gsub("([\195-\197])([\128-\191])", function(a, b)
    local cp = (a:byte() - 0xC0) * 64 + (b:byte() - 0x80)
    for _, r in ipairs(FOLD_RANGES) do
      if cp >= r[1] and cp <= r[2] then return r[3] end
    end
    return a .. b
  end))
end

--- A name as compared: lower case, accents folded, "&" is "and", apostrophes and punctuation gone, a leading "the"
--- dropped.
function igdb.name_key(s)
  s = fold_accents(tostring(s or "")):lower():gsub("&", " and "):gsub("\226\128\153", ""):gsub("['`]", "")
  s = s:gsub("[^%w]+", " "):gsub("^%s+", ""):gsub("%s+$", ""):gsub("^the ", "")
  return s
end

--- How a candidate's name relates to the title: "exact", "alternative" (one of its alternative names is exact),
--- "sequel" (it is the title plus a number: "Final Fight 3"), "contains" (one holds the other), or nil.
function igdb.name_match(cand, title)
  local want = igdb.name_key(title)
  if want == "" then return nil end
  local name = igdb.name_key(cand.name)
  -- Spaces do not count either: "Ghouls'n Ghosts" and "Ghouls 'N Ghosts".
  local function same(a, b) return a == b or a:gsub(" ", "") == b:gsub(" ", "") end
  if same(name, want) then return "exact" end
  if type(cand.alternative_names) == "table" then
    for _, alt in ipairs(cand.alternative_names) do
      if same(igdb.name_key(type(alt) == "table" and alt.name or alt), want) then return "alternative" end
    end
  end
  if name:sub(1, #want) == want then
    local rest = name:sub(#want + 1)
    if rest:match("^ [%divx]+$") or rest:match("^ [%divx]+ ") then return "sequel" end
  end
  if name:find(want, 1, true) or want:find(name, 1, true) then return "contains" end
  return nil
end

local MATCH_RANK = { exact = 4, alternative = 3, contains = 2, sequel = 1 }

--- The best name_match of a candidate over several names (the shortcut's title first, then names other sources gave:
--- a RetroAchievements title found by ROM hash spells the game right where the shortcut may not, "Aliens vs. Predator").
function igdb.best_name_match(cand, names)
  local best
  for _, n in ipairs(names) do
    local kind = igdb.name_match(cand, n)
    if kind and (not best or MATCH_RANK[kind] > MATCH_RANK[best]) then best = kind end
  end
  return best
end

--- Score an IGDB candidate to prioritize main games and rich descriptions over ports
local function score_candidate(cand, clean_lower, hints, names)
  local score = 0
  local cat = cand.category or 0
  if cat == 0 then
    score = score + 100 -- main_game
  elseif cat == 8 or cat == 9 or cat == 10 then
    score = score + 70  -- remake, remaster, expanded_game
  elseif cat == 11 then
    score = score + 20  -- port
  else
    score = score + 10
  end

  -- The name decides first (Library Setup accuracy pass, 2026-10-22): an exact name has to beat a sequel that only
  -- contains it ("Final Fight" lost to "Final Fight 3", "Joe & Mac" to "Joe & Mac 2" with the old +80 / +30).
  local kind = igdb.best_name_match(cand, names or { clean_lower })
  if kind == "exact" then
    score = score + 200
  elseif kind == "alternative" then
    score = score + 150
  elseif kind == "sequel" then
    score = score - 40
  elseif kind == "contains" then
    score = score + 30
  end

  -- Of entries with the same name, the one with real data: IGDB keeps re-releases and per-platform copies with no
  -- companies or summary ("Teenage Mutant Ninja Turtles: Tournament Fighters": a 2022 SNES entry without developers
  -- won over the 1993 one, both "--n" variants; seen 2026-10-19).
  if type(cand.involved_companies) == "table" then
    for _, c in ipairs(cand.involved_companies) do
      if type(c) == "table" and c.developer then score = score + 40 break end
    end
  end
  if type(cand.summary) == "string" and #cand.summary > 0 then score = score + 15 end

  -- Canonical slug preference (e.g. "chrono-trigger" vs "chrono-trigger--3")
  if cand.slug and type(cand.slug) == "string" then
    if not cand.slug:find("%-%-") then
      score = score + 50 -- Canonical primary release
    else
      score = score - 20 -- Variant / specific re-release
    end
  end

  -- Platform matching
  local plat_str = ""
  if type(cand.platforms) == "table" then
    local pnames = {}
    for _, p in ipairs(cand.platforms) do
      pnames[#pnames + 1] = tostring(p.name or ""):lower()
      pnames[#pnames + 1] = tostring(p.abbreviation or ""):lower()
    end
    plat_str = table.concat(pnames, " ")
  end

  hints = hints or {}
  if hints.igdb_ids and type(cand.platforms) == "table" then
    for _, p in ipairs(cand.platforms) do
      if type(p) == "table" and hints.igdb_ids[tonumber(p.id)] then score = score + 150 break end
    end
  end
  for _, hint in ipairs(hints) do
    if hint == "snes" then
      if plat_str:find("super nintendo") or plat_str:find("snes") or plat_str:find("super famicom") then
        score = score + 150
      elseif plat_str:find("pc %(microsoft windows%)") or plat_str:find("android") or plat_str:find("ios") then
        score = score - 60
      end
    elseif hint == "nes" then
      if plat_str:find("nintendo entertainment system") or plat_str:find("nes") or plat_str:find("famicom") then
        score = score + 150
      end
    elseif hint == "genesis" then
      if plat_str:find("sega") or plat_str:find("mega drive") or plat_str:find("genesis") then
        score = score + 150
      end
    elseif hint == "gba" then
      if plat_str:find("game boy advance") or plat_str:find("gba") then
        score = score + 150
      end
    elseif hint == "gb" then
      if plat_str:find("game boy") or plat_str:find("gb") then
        score = score + 150
      end
    elseif hint == "n64" then
      if plat_str:find("nintendo 64") or plat_str:find("n64") then
        score = score + 150
      end
    elseif hint == "ps1" then
      if plat_str:find("playstation") or plat_str:find("ps1") or plat_str:find("psx") then
        score = score + 150
      end
    elseif hint == "psp" then
      if plat_str:find("playstation portable") or plat_str:find("psp") then
        score = score + 150
      end
    elseif hint == "arcade" then
      if plat_str:find("arcade") or plat_str:find("neogeo") then
        score = score + 150
      end
    end
  end

  local raw_cand_name = tostring(cand.name or ""):lower()
  if not clean_lower:find("pack") and not clean_lower:find("collection") and not clean_lower:find("bundle") then
    if raw_cand_name:find("action pack") or raw_cand_name:find("collection") or raw_cand_name:find("bundle") then
      score = score - 120
    end
  end

  local summary = cand.summary or ""
  if #summary > 150 then
    score = score + 30
  elseif #summary > 0 and #summary < 80 then
    score = score - 40
  elseif #summary == 0 then
    local parent_summary = (cand.parent_game and cand.parent_game.summary) or ""
    if #parent_summary == 0 then
      score = score - 150
    end
  end
  if summary:lower():find("port of") then
    score = score - 60
  end

  local rdate = tonumber(cand.first_release_date) or 0
  if rdate > 0 and #hints > 0 then
    if rdate < 1000000000 then -- released before year 2001
      score = score + 40
    end
  end

  return score
end

--- An IGDB game (the fields fetch_game_metadata and fetch_by_id ask for) as our metadata record.
---@param appid number
---@param raw_title string
---@param game table
---@return table
function igdb.to_consolidated_metadata(appid, raw_title, game)
  -- Developers & Publishers
  local devs = {}
  local pubs = {}
  if type(game.involved_companies) == "table" then
    for _, comp in ipairs(game.involved_companies) do
      local cname = comp.company and comp.company.name
      if cname then
        if comp.developer then devs[#devs + 1] = cname end
        if comp.publisher then pubs[#pubs + 1] = cname end
      end
    end
  end

  -- Franchises (check both singular franchise and plural franchises)
  local franchises = {}
  local seen_franchises = {}
  local function add_franchise(fn)
    if fn and fn ~= "" and not seen_franchises[fn] then
      seen_franchises[fn] = true
      franchises[#franchises + 1] = fn
    end
  end

  if type(game.franchise) == "table" and game.franchise.name then
    add_franchise(game.franchise.name)
  end
  if type(game.franchises) == "table" then
    for _, f in ipairs(game.franchises) do
      if f.name then add_franchise(f.name) end
    end
  end

  -- Genres
  local genres = {}
  if type(game.genres) == "table" then
    for _, g in ipairs(game.genres) do
      if g.name then genres[#genres + 1] = g.name end
    end
  end

  -- Platforms the game was released on (names, abbreviations when IGDB has one): the frontend infers controller
  -- support from a console release (domain/controller-platforms.ts, ADR-0073).
  local platforms = {}
  local platform_names = {} -- the names alone, for Library Setup's question (no abbreviations)
  if type(game.platforms) == "table" then
    for _, p in ipairs(game.platforms) do
      if type(p) == "table" and type(p.name) == "string" and p.name ~= "" then
        platforms[#platforms + 1] = p.name
        platform_names[#platform_names + 1] = p.name
        if type(p.abbreviation) == "string" and p.abbreviation ~= "" and p.abbreviation ~= p.name then
          platforms[#platforms + 1] = p.abbreviation
        end
      end
    end
  end

  -- Names of a list IGDB returns as { {name = ...}, ... } (Library Setup's question shows them).
  local function names_of(list)
    local out = {}
    if type(list) == "table" then
      for _, item in ipairs(list) do
        if type(item) == "table" and type(item.name) == "string" and item.name ~= "" then out[#out + 1] = item.name end
      end
    end
    return out
  end

  -- Categories from game_modes
  local single_player = false
  local multiplayer = false
  local coop = false
  local split_screen = false

  if type(game.game_modes) == "table" then
    for _, m in ipairs(game.game_modes) do
      local mname = tostring(m.name or ""):lower()
      if mname:find("single") then single_player = true end
      if mname:find("multi") then multiplayer = true end
      if mname:find("co%-op") or mname:find("coop") or mname:find("cooperative") then coop = true end
      if mname:find("split") then split_screen = true end
    end
  else
    -- Default to single player if not specified
    single_player = true
  end

  -- Description priority:
  -- 1. Use summary
  -- 2. Fallback to parent_game summary if port
  -- 3. Only fallback to storyline if summary is completely empty
  local raw_desc = (game.summary and #game.summary > 0) and game.summary or ""
  if (raw_desc == "" or raw_desc:lower():find("port of")) and game.parent_game and game.parent_game.summary and #game.parent_game.summary > 0 then
    raw_desc = game.parent_game.summary
  end
  if raw_desc == "" and game.storyline and #game.storyline > 0 then
    raw_desc = game.storyline
  end

  local alt_names = {}
  if type(game.alternative_names) == "table" then
    for _, alt in ipairs(game.alternative_names) do
      if type(alt) == "table" and alt.name and #alt.name > 0 then
        alt_names[#alt_names + 1] = alt.name
      end
    end
  end

  local main_desc = truncate_smart(raw_desc, 400, 120)

  return {
    appid = appid,
    title = raw_title,
    igdb_id = game.id,
    matched_title = game.name,
    alternative_names = alt_names,
    description = main_desc,
    developers = devs,
    publishers = pubs,
    franchises = franchises,
    release_date = game.first_release_date or 0,
    genres = genres,
    platforms = platforms,
    platform_names = platform_names,
    themes = names_of(game.themes),
    game_mode_names = names_of(game.game_modes),
    perspectives = names_of(game.player_perspectives),
    categories = {
      single_player = single_player,
      multiplayer = multiplayer,
      coop = coop,
      split_screen = split_screen,
      full_controller = true, -- emulator/gamepad shortcut default
    },
    custom_override = false,
  }
end

--- Search for a game on IGDB and convert into consolidated metadata
---@param appid number
---@param raw_title string
---@param shortcut_info table|nil
---@param extra_names string[]|nil  names other sources gave the game (a RetroAchievements title by ROM hash), best
---                                 first; a candidate named so scores as if named like the shortcut
---@return table|nil metadata
function igdb.fetch_game_metadata(appid, raw_title, shortcut_info, extra_names)
  local clean = clean_title(raw_title)
  if clean == "" then return nil end
  local names = { clean }
  for _, n in ipairs(extra_names or {}) do
    if type(n) == "string" and n ~= "" and not n:find("~", 1, true) then names[#names + 1] = n end
  end

  local hints = detect_platform_hints(shortcut_info)
  logger:info("Searching IGDB for: '" .. clean .. "' (raw: '" .. raw_title .. "', hints: " .. table.concat(hints, ", ") .. ")")

  local fields = "fields name, slug, summary, storyline, category, parent_game.name, parent_game.summary, first_release_date, platforms.name, platforms.abbreviation, involved_companies.company.name, involved_companies.developer, involved_companies.publisher, franchise.name, franchises.name, game_modes.name, genres.name, themes.name, player_perspectives.name, alternative_names.name; "
  local query = fields .. 'search "' .. escape_query(clean) .. '"; limit 30;'

  local results = query_igdb(query)
  local from_title = results ~= nil and #results > 0 -- false once a fallback below found the results

  -- Fallback 1: if no matches and title has a colon/dash, try prefix
  if not results or #results == 0 then
    local prefix = clean:match("^(.-)%s*[:%-]")
    if prefix and #prefix >= 3 then
      logger:info("Retrying IGDB search with title prefix: '" .. prefix .. "'")
      local pquery = fields .. 'search "' .. escape_query(prefix) .. '"; limit 30;'
      results = query_igdb(pquery)
    end
  end

  -- Fallback 1b: if no matches and title has a colon/dash, try suffix (e.g. "Search for Eden")
  if not results or #results == 0 then
    local suffix = clean:match("[:%-]%s*(.+)$")
    if suffix and #suffix >= 3 then
      logger:info("Retrying IGDB search with title suffix: '" .. suffix .. "'")
      local squery = fields .. 'search "' .. escape_query(suffix) .. '"; limit 30;'
      results = query_igdb(squery)
    end
  end

  -- Fallback 1c: if title contains "in <base_game>" (ROM hacks like "Patrick Star in Mario Kart Super Circuit")
  if not results or #results == 0 then
    local base = clean:match("%f[%a][iI]n%s+(.+)$")
    if base and #base >= 3 then
      logger:info("Retrying IGDB search with base game from ROM hack: '" .. base .. "'")
      local bquery = fields .. 'search "' .. escape_query(base) .. '"; limit 30;'
      results = query_igdb(bquery)
    end
  end

  -- Fallback 2: if no matches and shortcut contains an arcade/emulator ROM filename, try ROM name
  if (not results or #results == 0) and shortcut_info then
    local cmd = tostring(shortcut_info.exe or "") .. " " .. tostring(shortcut_info.launch_options or "")
    local rom = cmd:match("([^/\\]+)%.[zZ][iI][pP]") or cmd:match("([^/\\]+)%.7[zZ]")
      or cmd:match("([^/\\]+)%.[cC][hH][dD]") or cmd:match("([^/\\]+)%.[cC][uU][eE]")
    if rom and #rom >= 2 and rom:lower() ~= clean:lower() then
      logger:info("Retrying IGDB search with ROM name: '" .. rom .. "'")
      local rquery = fields .. 'search "' .. escape_query(rom) .. '"; limit 30;'
      results = query_igdb(rquery)
    end
  end

  if not results or #results == 0 then
    logger:info("No IGDB match found for '" .. clean .. "'")
    return nil
  end

  local clean_lower = clean:lower()
  local function pick(list)
    local best, best_sc = list[1], -9999
    for _, cand in ipairs(list) do
      local sc = score_candidate(cand, clean_lower, hints, names)
      if sc > best_sc then best, best_sc = cand, sc end
    end
    return best, best_sc
  end
  local best_game, best_score = pick(results)

  -- A title search whose best hit does not carry the title (Library Setup accuracy pass, 2026-10-22): IGDB's search
  -- skips alternative names ("Out of This World" is listed as "Another World"), so ask for the name there; with still
  -- no name match there is no proposal, rather than a random game ("Quickie World").
  if from_title and not igdb.best_name_match(best_game, names) then
    local wheres = {}
    for _, n in ipairs(names) do
      local q = escape_query(n)
      wheres[#wheres + 1] = 'name ~ "' .. q .. '" | alternative_names.name ~ "' .. q .. '"'
    end
    local alt = query_igdb(fields .. "where " .. table.concat(wheres, " | ") .. "; limit 20;")
    if alt and #alt > 0 then
      for _, cand in ipairs(alt) do results[#results + 1] = cand end
      best_game, best_score = pick(results)
    end
    if not igdb.best_name_match(best_game, names) then
      logger:info("No IGDB candidate is named '" .. clean .. "' (best: '" .. tostring(best_game.name) .. "'): no match")
      return nil
    end
  end

  local game = best_game
  logger:info("Matched IGDB game: '" .. tostring(game.name) .. "' (ID: " .. tostring(game.id) .. ", slug: " .. tostring(game.slug) .. ", category: " .. tostring(game.category) .. ", score: " .. tostring(best_score) .. ")")

  return igdb.to_consolidated_metadata(appid, raw_title, game)
end

--- Fetch full metadata for a specific IGDB game ID
---@param appid number
---@param igdb_id number|string
---@param raw_title? string
---@return table|nil, string|nil
function igdb.fetch_by_id(appid, igdb_id, raw_title)
  local id = tonumber(igdb_id)
  if not id or id <= 0 then return nil, "invalid igdb id" end
  local fields = "fields name, slug, summary, storyline, category, parent_game.name, parent_game.summary, first_release_date, platforms.name, platforms.abbreviation, involved_companies.company.name, involved_companies.developer, involved_companies.publisher, franchise.name, franchises.name, game_modes.name, genres.name, themes.name, player_perspectives.name, alternative_names.name; "
  local query = fields .. "where id = " .. tostring(id) .. "; limit 1;"
  local results = query_igdb(query)
  if not results or #results == 0 then return nil, "game not found on igdb" end
  local cand = results[1]
  return igdb.to_consolidated_metadata(appid, raw_title or cand.name, cand)
end

--- One query to IGDB's /v4/games endpoint with this module's Twitch token (features plan F2: the media
--- service asks for a known game's videos, artworks and screenshots). The decoded list, or nil on failure.
---@param apicalypse_query string
---@return table|nil
function igdb.query(apicalypse_query)
  return query_igdb(apicalypse_query)
end

--- Sign in to Twitch with the saved Client ID and Secret, without asking IGDB anything (Settings: "is the account
--- connected?"). Always asks Twitch again, so a just-saved value is what is tested.
---@return boolean ok
---@return string message
function igdb.check()
  local creds = config.get_twitch_credentials()
  if not creds then return false, "No Twitch Client ID and Secret are saved." end
  cached_token, token_expires_at = nil, 0
  local url = "https://id.twitch.tv/oauth2/token?client_id=" .. creds.client_id ..
              "&client_secret=" .. creds.client_secret .. "&grant_type=client_credentials"
  local res, err = http_post(url, { ["Accept"] = "application/json" }, "", 15)
  if not res then return false, "Twitch could not be reached (" .. tostring(err) .. ")." end
  if res.status == 200 and get_access_token() then return true, "Twitch accepted the Client ID and Secret." end
  if res.status == 400 or res.status == 401 or res.status == 403 then
    return false, "Twitch refused the Client ID or Secret (HTTP " .. tostring(res.status) .. "). Check both values."
  end
  return false, "Twitch answered HTTP " .. tostring(res.status) .. "."
end

igdb._score_candidate = score_candidate -- probes and tests: rank candidates without fetching
igdb._detect_platform_hints = detect_platform_hints

return igdb
