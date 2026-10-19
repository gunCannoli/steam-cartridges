--- steam-cartridges - the ScreenScraper client (jeuInfos.php).
---
--- One `jeu` record per shortcut, shared by two sources:
---   metadata (M5d)    metadata_service maps it to Game Info
---   media (F2b)       media_service lists its screenshot, title screen and fanart as keys; image bytes are
---                     downloaded on demand into memory (download) and never stored on disk
---
--- ScreenScraper's media URLs carry the developer and user accounts in their query string: they never leave
--- this module and media_service (no record, no file, no log, no RPC answer holds one).

local net         = require("net")
local json        = require("json")
local logger      = require("logger")
local utils       = require("utils")
local config      = require("web_config")

local M = {}

--- In-memory `jeu` records, by shortcut appid (positive results only).
local jeu_cache = {}

--- The raw ScreenScraper `jeu` record for a game (jeuInfos.php): the one client the media
--- (M-series) and metadata (M5d) sources share.
---@param appid number
---@param rom_path string|nil
---@param system_id number|nil
---@param crc string|nil
---@param md5 string|nil
---@param name string|nil  a title to search by when there is no ROM file name
---@return table|nil jeu
---@return string|nil err  "no-credentials" | "request-failed" | "not-found"
function M.fetch_jeu(appid, rom_path, system_id, crc, md5, name)
  if not appid then return nil, "not-found" end
  if jeu_cache[appid] then return jeu_cache[appid] end

  local creds = config.get_screenscraper_credentials()
  if not creds or (creds.dev_user == "" and creds.user == "") then
    -- Fail silently if no ScreenScraper credentials configured (ADR-0014)
    return nil, "no-credentials"
  end

  local dev_id = creds.dev_user ~= "" and creds.dev_user or creds.user
  local dev_pw = creds.dev_pw ~= "" and creds.dev_pw or creds.pass
  local ssid   = creds.user
  local sspw   = creds.pass

  local filename = rom_path and rom_path:match("([^/\\]+)$") or ""
  if filename == "" and name and #name > 0 then filename = name end
  local url = string.format(
    "https://api.screenscraper.fr/api2/jeuInfos.php?devid=%s&devpassword=%s&softname=steam-cartridges&output=json&romtype=rom",
    utils.url_encode(dev_id),
    utils.url_encode(dev_pw)
  )

  if #ssid > 0 and #sspw > 0 then
    url = url .. string.format("&ssid=%s&sspassword=%s", utils.url_encode(ssid), utils.url_encode(sspw))
  end
  if #filename > 0 then
    url = url .. "&romnom=" .. utils.url_encode(filename)
  end
  if system_id and system_id > 0 then
    url = url .. "&systemeid=" .. tostring(system_id)
  end
  if crc and #crc > 0 then
    url = url .. "&crc=" .. utils.url_encode(crc)
  end
  if md5 and #md5 > 0 then
    url = url .. "&md5=" .. utils.url_encode(md5)
  end

  local ok, res = pcall(net.get, url, {
    source = "screenscraper",
    user_agent = "steam-cartridges/1.0",
    timeout = 15,
  })

  -- Never log `url`: it carries the account credentials.
  if not ok or not res or res.status ~= 200 or not res.body then
    logger:info("ScreenScraper API request returned status " .. tostring(res and res.status))
    return nil, "request-failed"
  end

  local decode_ok, data = pcall(json.decode, res.body)
  if not decode_ok or type(data) ~= "table" or not data.response or not data.response.jeu then
    return nil, "not-found"
  end

  jeu_cache[appid] = data.response.jeu
  return jeu_cache[appid]
end

--- ScreenScraper's `systemeid` for a RetroAchievements console id (retroachievements.detect_console_id). The two
--- numberings differ: RetroAchievements' 3 is the SNES, ScreenScraper's 3 is the NES (features plan F2c, phase 0).
M.SS_SYSTEM = {
  [1] = 1,    -- Sega Genesis / Mega Drive
  [2] = 14,   -- Nintendo 64
  [3] = 4,    -- SNES
  [5] = 12,   -- Game Boy Advance
  [7] = 3,    -- NES
  [12] = 57,  -- PlayStation
  [16] = 13,  -- GameCube
  [27] = 75,  -- Arcade (MAME)
  [41] = 61,  -- PSP
}

--- The `jeu` for a shortcut: the ROM file name, console and MD5 read from its shortcuts.vdf entry (the
--- RetroAchievements readers), else the title. Returns what fetch_jeu returns.
---@param appid number
---@param title string|nil
---@param info table|nil  the registry.shortcut entry
function M.jeu_for(appid, title, info)
  local ra = require("retroachievements")
  local rom_path = info and ra.extract_rom_path(info.exe, info.launch_options) or nil
  local md5 = rom_path and ra.compute_rom_md5(rom_path) or nil
  local console_id = info and ra.detect_console_id(info.exe, info.launch_options) or nil
  local system_id = console_id and M.SS_SYSTEM[console_id] or nil
  local has_title = type(title) == "string" and title ~= ""
  -- No ROM and no console (a PC game, a fan game): jeuInfos has nothing to match on, so look the game up by name.
  if not rom_path and has_title and not system_id then return M.search_jeu(appid, title, nil) end
  local jeu, err = M.fetch_jeu(appid, rom_path, system_id, nil, md5, title)
  -- No ROM match (a ROM name or dump ScreenScraper does not know), or no ROM file: look the title up on that console.
  if not jeu and has_title and err ~= "no-credentials" then return M.search_jeu(appid, title, system_id) end
  return jeu, err
end

-- ---------- Name matching (a game with no ROM file) ----------

local function clean_unicode_spaces(s)
  if type(s) ~= "string" then return "" end
  -- Replace UTF-8 non-breaking spaces (\xc2\xa0) and common Unicode spaces with standard space
  s = s:gsub("\xc2\xa0", " ")
  -- Replace Unicode hyphens/dashes with standard dash
  s = s:gsub("\xe2\x80[\x90-\x95]", "-")
  return s
end

--- A title reduced to comparable words: lower case, punctuation and bracketed tags dropped, a leading "the" dropped.
function M.normalize_name(name)
  if type(name) ~= "string" then return "" end
  local s = clean_unicode_spaces(name):lower()
  s = s:gsub("%b()", " "):gsub("%b[]", " ")
  s = s:gsub("[^%w]+", " ")
  s = s:gsub("^%s+", ""):gsub("%s+$", ""):gsub("^the%s+", "")
  return s
end


local function words(s)
  local set, n = {}, 0
  for w in s:gmatch("%S+") do
    if not set[w] then set[w] = true; n = n + 1 end
  end
  return set, n
end

--- How alike two titles are, 0..1: 1 for the same words, else shared words over the longer title's words.
function M.name_score(a, b)
  local na, nb = M.normalize_name(a), M.normalize_name(b)
  if na == "" or nb == "" then return 0 end
  if na == nb then return 1 end
  local wa, ca = words(na)
  local wb, cb = words(nb)
  local shared = 0
  for w in pairs(wa) do if wb[w] then shared = shared + 1 end end
  return shared / math.max(ca, cb)
end

--- Every name a search result carries (`noms`: { region, text } entries, or a plain `nom`).
local function names_of(game)
  local out = {}
  if type(game.noms) == "table" then
    for _, n in ipairs(game.noms) do
      if type(n) == "table" and type(n.text) == "string" then out[#out + 1] = n.text end
    end
  end
  if type(game.nom) == "string" then out[#out + 1] = game.nom end
  return out
end

local function system_text(game)
  local sys = game.systeme
  if type(sys) == "table" then return tostring(sys.text or sys.nom or "") end
  return tostring(game.systemenom or "")
end

--- A PC platform (Windows, DOS, ...): the likely home of a game with no ROM file.
function M.is_pc_system(text)
  local t = tostring(text or ""):lower()
  return t:find("windows", 1, true) ~= nil or t:find("dos", 1, true) ~= nil or t:match("^pc") ~= nil or t:find(" pc", 1, true) ~= nil
end

--- The search result that is the same game as `title`, or nil: its best name must score at least MIN_NAME_SCORE; ties
--- go to a result on the console of the shortcut, else on a PC platform. Returns game, score.
M.MIN_NAME_SCORE = 0.8
--- The score a result gets when only a part of the title equals its name ("AM2R" for "AM2R - Another Metroid 2 Remake"):
--- below a full match, and only given to a result on the shortcut's console or on a PC platform, where a fan game is
--- listed under its short name. A part alone on another platform ("Metroid" for "Metroid - Zero Mission") never matches.
M.PART_SCORE = 0.85

local function title_parts(title)
  local parts = {}
  local t = clean_unicode_spaces(title)
  local head = t:match("^(.-)%s+[%-:]%s") or t:match("^(.-):")
  local tail = t:match("^.-%s+[%-:]%s+(.+)$")
  if head and head ~= "" then parts[#parts + 1] = head end
  if tail and tail ~= "" then parts[#parts + 1] = tail end
  return parts
end


function M.best_match(title, games, console_id)
  local best, best_score
  local parts = title_parts(title)
  for _, g in ipairs(type(games) == "table" and games or {}) do
    if type(g) == "table" and g.id ~= nil then
      local sys_id = type(g.systeme) == "table" and tonumber(g.systeme.id) or tonumber(g.systemeid)
      local home = (console_id and sys_id == console_id) or (not console_id and M.is_pc_system(system_text(g)))
      local score = 0
      for _, name in ipairs(names_of(g)) do
        local s = M.name_score(title, name)
        if s > score then score = s end
        if home then
          -- a part of the title equals the name or a part of the name (the head "AM2R" of "AM2R - Return of Samus")
          local name_parts = title_parts(name)
          name_parts[#name_parts + 1] = name
          for _, part in ipairs(parts) do
            for _, np in ipairs(name_parts) do
              if M.name_score(part, np) == 1 and M.PART_SCORE > score then score = M.PART_SCORE end
            end
          end
        end
      end
      if score >= M.MIN_NAME_SCORE then
        local bonus = 0
        if console_id and sys_id == console_id then bonus = 0.02
        elseif not console_id and M.is_pc_system(system_text(g)) then bonus = 0.01 end
        if not best or score + bonus > best_score then best, best_score = g, score + bonus end
      end
    end
  end
  return best, best_score
end

--- Searches ScreenScraper by name (jeuRecherche.php), takes the matching game and fetches its record by id. The same
--- shape fetch_jeu returns; a search with no match is "not-found" and is not repeated this session.
local search_missed = {}
--- What the last name search did (GetDiagnostics `ss_search`): the title, HTTP statuses, result count, the match. Holds no
--- account and no address.
M.last_search = nil
function M.search_jeu(appid, title, system_id)
  if not appid or search_missed[appid] then return nil, "not-found" end
  if jeu_cache[appid] then return jeu_cache[appid] end
  local creds = config.get_screenscraper_credentials()
  if not creds or (creds.dev_user == "" and creds.user == "") then return nil, "no-credentials" end

  local dev_id = creds.dev_user ~= "" and creds.dev_user or creds.user
  local dev_pw = creds.dev_pw ~= "" and creds.dev_pw or creds.pass
  local function api(endpoint, extra)
    local url = string.format("https://api.screenscraper.fr/api2/%s?devid=%s&devpassword=%s&softname=steam-cartridges&output=json",
      endpoint, utils.url_encode(dev_id), utils.url_encode(dev_pw))
    if #creds.user > 0 and #creds.pass > 0 then
      url = url .. string.format("&ssid=%s&sspassword=%s", utils.url_encode(creds.user), utils.url_encode(creds.pass))
    end
    return url .. extra
  end
  local trace = { title = title, system_id = system_id }
  M.last_search = trace
  local function get(url, stage)
    local ok, res = pcall(net.get, url, { source = "screenscraper", user_agent = "steam-cartridges/1.0", timeout = 15 })
    trace[stage .. "_status"] = ok and res and res.status or (ok and "no-response" or "error")
    if ok and res and res.status ~= 200 and type(res.body) == "string" then trace[stage .. "_text"] = res.body:sub(1, 60) end
    if not ok or not res or res.status ~= 200 or not res.body then
      -- The request address carries the accounts: only the status is logged.
      logger:info("ScreenScraper API request returned status " .. tostring(res and res.status))
      return nil
    end
    local decoded_ok, data = pcall(json.decode, res.body)
    if not decoded_ok or type(data) ~= "table" or type(data.response) ~= "table" then
      trace[stage .. "_text"] = res.body:sub(1, 60)
      return false
    end
    return data.response
  end

  -- ScreenScraper's search wants plain words, so try the title as words first, then the part before a dash or colon
  -- ("AM2R - Another Metroid 2 Remake" -> "AM2R"); every candidate list is scored against the full title.
  local queries, seen = {}, {}
  local function add_query(q)
    q = M.normalize_name(q)
    if q ~= "" and not seen[q] then seen[q] = true; queries[#queries + 1] = q end
  end
  add_query(title)
  local cleaned = clean_unicode_spaces(title)
  if cleaned ~= title then add_query(cleaned) end
  add_query(cleaned:match("^(.-)%s+[%-:]%s") or cleaned:match("^(.-):"))

  trace.queries = {}
  local game, score, games
  for _, q in ipairs(queries) do
    local extra = "&recherche=" .. utils.url_encode(q)
    if system_id and system_id > 0 then extra = extra .. "&systemeid=" .. tostring(system_id) end
    local found = get(api("jeuRecherche.php", extra), "search")
    if found == nil then return nil, "request-failed" end
    games = found and found.jeux or nil
    game, score = M.best_match(title, games, system_id)
    local count = 0
    for _, g in ipairs(type(games) == "table" and games or {}) do
      if type(g) == "table" and g.id ~= nil then count = count + 1 end
    end
    local cands = {}
    for idx = 1, math.min(3, type(games) == "table" and #games or 0) do
      local g = games[idx]
      if type(g) == "table" and g.id ~= nil then
        cands[#cands + 1] = { id = tostring(g.id), names = names_of(g), system = system_text(g) }
      end
    end
    trace.queries[#trace.queries + 1] = { q = q, candidates = count, first = cands, match = game and tostring(game.id) or nil, score = score }
    if game then break end
  end
  trace.match = game and tostring(game.id) or nil
  trace.score = score
  logger:info(string.format("ScreenScraper name search for %q: %s", title,
    game and string.format("matched game %s (%.2f)", tostring(game.id), score) or "no match"))
  if not game then
    search_missed[appid] = true
    return nil, "not-found"
  end

  local info = get(api("jeuInfos.php", "&gameid=" .. utils.url_encode(tostring(game.id))), "info")
  if info == nil then return nil, "request-failed" end
  if not info or type(info.jeu) ~= "table" then
    search_missed[appid] = true
    return nil, "not-found"
  end
  jeu_cache[appid] = info.jeu
  return jeu_cache[appid]
end

-- ---------- Community media (features plan F2b) ----------

--- ScreenScraper media types Steam's Community Content section can show, and the card each becomes. Image types
--- only: a media ScreenScraper names as another format is not offered (is_image_format), and one whose bytes are not an
--- image is dropped when it is downloaded.
M.MEDIA_KINDS = {
  sstitle = "screenshot", ss = "screenshot", fanart = "artwork",
  mixrbv2 = "artwork", mixrbv1 = "artwork", ["box-2D"] = "artwork", ["box-2D-back"] = "artwork", ["box-3D"] = "artwork",
  ["support-2D"] = "artwork", figurine = "artwork", flyer = "artwork", themehs = "artwork",
}
local MEDIA_ORDER = { "sstitle", "ss", "fanart", "mixrbv2", "mixrbv1", "box-2D", "box-2D-back", "box-3D", "support-2D", "figurine", "flyer", "themehs" }
--- The caption under every card.
M.MEDIA_TITLES = {
  sstitle = "Title screen", ss = "Screenshot", fanart = "Fan art",
  mixrbv2 = "Recalbox mix", mixrbv1 = "Recalbox mix (v1)", ["box-2D"] = "Box: front", ["box-2D-back"] = "Box: back", ["box-3D"] = "3D box",
  ["support-2D"] = "Cartridge / disc", figurine = "Figurine", flyer = "Flyer", themehs = "HyperSpin theme",
}
--- Region preference when a type exists for several regions (world first).
local REGION_RANK = { wor = 1, us = 2, eu = 3, ss = 4, jp = 5 }
--- The size a card is laid out with until the bytes are read (GetMediaImage returns the real one).
M.DEFAULT_SIZE = { screenshot = { 640, 480 }, artwork = { 1920, 1080 } }
--- ScreenScraper scales the image down to this width (mediaJeu.php `maxwidth`).
M.MAX_WIDTH = 1280

local function key_of(m)
  return tostring(m.type) .. "(" .. tostring(m.region or "") .. ")"
end

--- File formats a card can show. ScreenScraper names each media's format; one it names as something else (the HyperSpin
--- theme is a zip) is never offered, so it costs no download. A media without a format is kept: its bytes decide.
local IMAGE_FORMATS = { png = true, jpg = true, jpeg = true }

--- Whether a media's `format` (ScreenScraper's own field, nil when absent) is one a card can show.
function M.is_image_format(format)
  return type(format) ~= "string" or IMAGE_FORMATS[format:lower()] == true
end

--- The images a `jeu` offers for the Community section, one item per type (best region), as keys only:
--- { kind, source = "screenscraper", key = "ss(wor)", title?, width, height }. Never a URL.
function M.media_items(jeu)
  local by_type = {}
  for _, m in ipairs(type(jeu) == "table" and type(jeu.medias) == "table" and jeu.medias or {}) do
    if type(m) == "table" and M.MEDIA_KINDS[m.type] and type(m.url) == "string" and m.url ~= "" and M.is_image_format(m.format) then
      local list = by_type[m.type] or {}
      list[#list + 1] = { rank = REGION_RANK[m.region or "wor"] or 9, key = key_of(m) }
      by_type[m.type] = list
    end
  end
  local items = {}
  for _, t in ipairs(MEDIA_ORDER) do
    local list = by_type[t]
    if list then
      table.sort(list, function(a, b) if a.rank ~= b.rank then return a.rank < b.rank end return a.key < b.key end)
      local kind = M.MEDIA_KINDS[t]
      local size = M.DEFAULT_SIZE[kind]
      local item = { kind = kind, source = "screenscraper", key = list[1].key, width = size[1], height = size[2], title = M.MEDIA_TITLES[t] }
      items[#items + 1] = item
    end
  end
  return items
end

-- ---------- Manuals (features plan F2c) ----------

--- ScreenScraper's media type for a game manual (a PDF), one per region.
M.MANUAL_TYPE = "manuel"
--- The card's layout size: 16:9 and 513-1023 wide is Steam's ordinary small cell (class 34, as IGDB screenshots); 1280 wide is a tall cell Steam dropped.
M.MANUAL_COVER = { 960, 540 }
--- A manual larger than this is not downloaded (the WinINet reader holds it in memory).
M.MAX_MANUAL_BYTES = 48 * 1024 * 1024

--- The manual card of a `jeu`, best region first (REGION_RANK), or nil: { kind = "manual", source, key, title,
--- width, height }. Never a URL.
function M.manual_item(jeu)
  local best
  for _, m in ipairs(type(jeu) == "table" and type(jeu.medias) == "table" and jeu.medias or {}) do
    if type(m) == "table" and m.type == M.MANUAL_TYPE and type(m.url) == "string" and m.url ~= "" then
      local rank = REGION_RANK[m.region or "wor"] or 9
      local key = key_of(m)
      if not best or rank < best.rank or (rank == best.rank and key < best.key) then best = { rank = rank, key = key } end
    end
  end
  if not best then return nil end
  return { kind = "manual", source = "screenscraper", key = best.key, title = "Manual",
    width = M.MANUAL_COVER[1], height = M.MANUAL_COVER[2] }
end

--- The bytes of one manual URL, in memory (net.get_binary, no `maxwidth`: a PDF is not scaled). Never logs the URL.
---@return string|nil body, string|nil err
function M.download_document(url)
  local res, err = net.get_binary(url, {
    source = "screenscraper",
    user_agent = "steam-cartridges/1.0",
    max_bytes = M.MAX_MANUAL_BYTES,
  })
  if not res then return nil, tostring(err) end
  if res.status ~= 200 then return nil, "status " .. tostring(res.status) end
  if type(res.body) ~= "string" or res.body:sub(1, 5) ~= "%PDF-" then return nil, "not a pdf" end
  return res.body
end

--- The URL of the media item `key` in `jeu` and its format (nil when ScreenScraper names none), or nil. Stays in the
--- backend (it carries the accounts).
function M.media_url(jeu, key)
  for _, m in ipairs(type(jeu) == "table" and type(jeu.medias) == "table" and jeu.medias or {}) do
    if type(m) == "table" and type(m.url) == "string" and key_of(m) == key then return m.url, m.format end
  end
  return nil
end

local function u16(s, i) return s:byte(i) * 256 + s:byte(i + 1) end
local function u32(s, i) return u16(s, i) * 65536 + u16(s, i + 2) end

--- "jpg" | "png" from the first bytes, or nil (ScreenScraper answers an error as text with HTTP 200).
function M.image_type(body)
  if type(body) ~= "string" then return nil end
  if body:sub(1, 3) == "\255\216\255" then return "jpg" end
  if body:sub(1, 8) == "\137PNG\r\n\26\n" then return "png" end
  return nil
end

--- Width and height from a PNG IHDR or a JPEG SOF segment, or nil.
function M.image_size(body, ext)
  if ext == "png" and #body >= 24 then return u32(body, 17), u32(body, 21) end
  if ext ~= "jpg" then return nil end
  local i = 3
  while i + 8 <= #body do
    if body:byte(i) ~= 0xFF then return nil end
    local marker = body:byte(i + 1)
    if marker >= 0xC0 and marker <= 0xCF and marker ~= 0xC4 and marker ~= 0xC8 and marker ~= 0xCC then
      return u16(body, i + 7), u16(body, i + 5)
    end
    i = i + 2 + u16(body, i + 2)
  end
  return nil
end

--- The bytes of one media URL, scaled to MAX_WIDTH, in memory (net.get_binary). Never logs the URL.
---@return string|nil body, string ext_or_err, number|nil width, number|nil height
function M.download(url)
  local sep = url:find("?", 1, true) and "&" or "?"
  local res, err = net.get_binary(url .. sep .. "maxwidth=" .. M.MAX_WIDTH, {
    source = "screenscraper",
    user_agent = "steam-cartridges/1.0",
  })
  if not res then return nil, tostring(err) end
  if res.status ~= 200 then return nil, "status " .. tostring(res.status) end
  local ext = M.image_type(res.body)
  if not ext then return nil, "not an image" end
  local w, h = M.image_size(res.body, ext)
  return res.body, ext, w, h
end

return M
