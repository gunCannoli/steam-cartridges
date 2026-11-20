--- Extensions push a game's data (ADR-0067): the frontend's extension API (`reportGame`, `reportAchievementSet`,
--- `forgetGame`) calls these. Store-agnostic: the core never asks a store; it keeps what an extension found.
---   ProvideGame          { appid, source, provider, title?, metadata?, media? }        -> { ok, changed }
---   ForgetProvidedGame   { appid }                                                      -> { ok }
---   ProvideAchievements  { appid, source, provider, key, schema = { achievements }, unlocks = { [id] = unix }, native? }
---                        -> { ok, part, new = { ids } }

local core      = require("rpc")
local provided  = require("provided_store")
local ach_store = require("achievements_store")

local method = core.method

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  steam_fetch = nil, -- fun(native) -> schema | nil ; nil = steam_schema.fetch
  native = nil,      -- fun(appid) -> native appid | nil ; nil = the saved Steam mapping
  now = nil,         -- fun() -> unix seconds
  get_binary = nil,  -- fun(url, opts) -> { status, body } | nil, err ; nil = net.get_binary
}

local function now() return (M.deps.now or os.time)() end

local SHORTCUT_MIN = 0x80000000

local function shortcut(appid)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then return nil end
  return math.floor(n)
end

local function text(v) return type(v) == "string" and v ~= "" and v or nil end

--- Media items an extension may push: public URLs only (a ScreenScraper-style `key` is the core's own).
local function clean_media(list, source)
  local out, seen = {}, {} -- one item per address: a store may list a picture twice
  for _, it in ipairs(type(list) == "table" and list or {}) do
    local id = type(it) == "table" and (text(it.url) or text(it.youtube)) or nil
    if id and not seen[id] then
      seen[id] = true
      out[#out + 1] = {
        kind = (it.kind == "video" or it.kind == "artwork") and it.kind or "screenshot",
        source = source,
        url = text(it.url), thumb = text(it.thumb), youtube = text(it.youtube), title = text(it.title),
        width = tonumber(it.width), height = tonumber(it.height),
      }
    end
  end
  return out
end

--- The art an extension may push: https URLs for the four slots' keys and the library icon (anything else is dropped).
local ART_KEYS = { "portrait", "hero", "logo", "wide", "icon" }
local function clean_art(art)
  if type(art) ~= "table" then return nil end
  local out, any = {}, false
  for _, k in ipairs(ART_KEYS) do
    local u = text(art[k])
    if u and u:match("^https://") and #u <= 600 then out[k] = u any = true end
  end
  return any and out or nil
end
M.clean_art = clean_art

--- { appid, source, provider, title?, metadata?, media?, artwork? }: keep what an extension found for a shortcut.
function M.provide_game(data)
  local appid = shortcut(data.appid)
  local source = text(data.source)
  if not appid or not source then return { error = "need a shortcut appid and a source" } end
  local meta = type(data.metadata) == "table" and data.metadata or nil
  if meta then
    meta.appid = appid
    meta.store_source = source -- the record remembers who wrote it (metadata_service: provided data replaces others)
  end
  local changed = provided.set(appid, {
    source = source,
    provider = text(data.provider) or source,
    title = text(data.title),
    metadata = meta,
    media = data.media ~= nil and clean_media(data.media, source) or nil,
    art = clean_art(data.artwork),
    fill = data.fill ~= false, -- may IGDB / ScreenScraper fill what the store leaves empty (the extension's setting)
    at = now(),
  })
  return { ok = true, changed = changed }
end

--- { appid, url } or { appid, slot }: the bytes of one picture the store pushed for this shortcut (its `artwork`), as base64,
--- for when the page's own fetch failed: that address, or the store's picture for a slot (hero, portrait, wide, logo, icon) when
--- the Steam match has no such picture on its CDN. Only an address the store pushed for that game is fetched; the body is at
--- most MAX_ART_BYTES.
M.MAX_ART_BYTES = 6 * 1024 * 1024
function M.fetch_provided_art(data)
  local appid = shortcut(data.appid)
  local rec = provided.get(appid)
  local url = text(data.url)
  local slot = text(data.slot)
  if slot and not url then
    url = type(rec) == "table" and type(rec.art) == "table" and text(rec.art[slot]) or nil
    if not url then return { missing = true } end -- the store pushed no picture for this slot: an answer, not a fault
  end
  if not appid or not url then return { error = "need a shortcut appid and a url (or a slot the store pushed art for)" } end
  local allowed, n = false, 0
  for _, u in pairs(type(rec) == "table" and type(rec.art) == "table" and rec.art or {}) do
    if u == url then allowed = true end
  end
  if not allowed then
    for _ in pairs(type(rec) == "table" and type(rec.art) == "table" and rec.art or {}) do n = n + 1 end
    return { error = string.format("not an address pushed for this game (record=%s, art=%d, url=%d chars)", tostring(type(rec) == "table"), n, #url) }
  end
  local get = M.deps.get_binary or function(u, o) return require("net").get_binary(u, o) end
  local res, err = get(url, { source = "provided-art", max_bytes = M.MAX_ART_BYTES })
  if type(res) ~= "table" or tonumber(res.status) ~= 200 or type(res.body) ~= "string" or #res.body < 100 then
    return { error = "not fetched: " .. tostring(err or (type(res) == "table" and res.status) or "no answer") }
  end
  local head = res.body:sub(1, 4)
  local ext = head:sub(1, 2) == "\255\216" and "jpg" or head == "\137PNG" and "png" or nil
  if not ext then return { error = "not a jpg or png" } end
  return { base64 = require("utils").base64_encode(res.body), ext = ext }
end

function M.forget_game(data)
  local appid = shortcut(data.appid)
  if not appid then return { error = "need a shortcut appid" } end
  provided.set(appid, nil)
  return { ok = true }
end

--- Every id of `items` is in Steam's list (pure).
local function covered_by(items, steam)
  if type(steam) ~= "table" or type(steam.achievements) ~= "table" or #items == 0 then return false end
  local ids = {}
  for _, a in ipairs(steam.achievements) do ids[tostring(a.id)] = true end
  for _, a in ipairs(items) do
    if not ids[tostring(a.id)] then return false end
  end
  return true
end

--- An achievement name as a matching key: lower case, letters and digits only (UTF-8 bytes kept, so other scripts still match).
local function name_key(s)
  return (tostring(s or ""):lower():gsub("[^%w\128-\255]", ""))
end

--- Steam keeps an achievement's picture as a bare file name (`<40 hex>.jpg`) under its app's folder; its UI draws a full
--- address, so a bare name on a shortcut's achievement is a blank box. The address for the app the picture belongs to.
M.STEAM_ICON_BASE = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/"
function M.steam_icon_url(icon, native)
  icon = text(icon)
  if not icon then return nil end
  local hash = icon:match("^(%x+)%.%a+$")
  if hash and #hash == 40 and tonumber(native) and tonumber(native) > 0 then
    return M.STEAM_ICON_BASE .. string.format("%d", tonumber(native)) .. "/" .. icon
  end
  return icon
end

--- Steam's list is the primary source of icons, locked icons, rarity and the hidden flag (the user, 2026-11-19): an item whose
--- name is the same as one Steam achievement's (a name Steam lists twice never matches: a guess is worse than a blank) takes
--- Steam's values wherever Steam has them. The store's ids, names and descriptions stay (the unlocks are keyed by its ids), and
--- an item the store marked hidden stays hidden. Mutates `items`. Returns how many items matched and the ids that kept the
--- store's own icon (no match, or Steam has none): the caller may still fix those icons. Pure apart from that.
function M.enrich_from_steam(items, steam, native, skip_icons)
  native = tonumber(native) or tonumber(type(steam) == "table" and steam.native_appid or nil)
  if type(items) ~= "table" or type(steam) ~= "table" or type(steam.achievements) ~= "table" then return 0, {} end
  local by_name, dup = {}, {}
  for _, s in ipairs(steam.achievements) do
    local k = type(s) == "table" and name_key(s.name) or ""
    if k ~= "" then
      if by_name[k] then dup[k] = true else by_name[k] = s end
    end
  end
  local filled, kept = 0, {}
  for _, it in ipairs(items) do
    local k = type(it) == "table" and name_key(it.name) or ""
    local s = k ~= "" and not dup[k] and by_name[k] or nil
    local took_icon = false
    if s then
      local touched = false
      -- Steam's art comes as a pair: the colour icon and the grey one a locked achievement shows.
      if text(s.icon) and not skip_icons then
        it.icon = M.steam_icon_url(s.icon, native)
        it.icon_locked = M.steam_icon_url(s.icon_locked, native)
        touched, took_icon = true, true
      end
      if tonumber(s.global_pct) then it.global_pct = tonumber(s.global_pct) touched = true end
      if s.hidden == true then it.hidden = true touched = true end
      if touched then filled = filled + 1 end
    end
    if not took_icon then kept[#kept + 1] = tostring(it.id) end
  end
  return filled, kept
end

--- How much of `items` Steam's list names too: matched / #items, by unique name (pure). The check that a title match is the
--- same game (Prey 2006 and Prey 2017 share a title and not their achievements).
function M.name_overlap(items, steam)
  if type(items) ~= "table" or #items == 0 or type(steam) ~= "table" or type(steam.achievements) ~= "table" then return 0 end
  local seen, dup = {}, {}
  for _, s in ipairs(steam.achievements) do
    local k = type(s) == "table" and name_key(s.name) or ""
    if k ~= "" then
      if seen[k] then dup[k] = true else seen[k] = true end
    end
  end
  local n = 0
  for _, it in ipairs(items) do
    local k = type(it) == "table" and name_key(it.name) or ""
    if k ~= "" and seen[k] and not dup[k] then n = n + 1 end
  end
  return n / #items
end
M.MIN_OVERLAP = 0.6

--- The Steam app a game's title names exactly, or nil (the resolver service looks; nothing is saved). The achievements must still
--- agree with Steam's list (name_overlap) before it is used.
local function title_native(title)
  title = text(title)
  if not title then return nil end
  if M.deps.search then return M.deps.search(title) end
  return require("resolve_identity").exact_title_native(title)
end

local function saved_native(appid)
  if M.deps.native then return M.deps.native(appid) end
  local ok, mapping = pcall(function()
    local saved = require("resolve_identity").saved(appid)
    return saved and saved.data and saved.data.native and saved.data.native.appid
  end)
  return ok and tonumber(mapping) or nil
end

--- Whether an app's achievement pictures are served at all: its first picture is fetched once per session (a recent Steam app
--- can list hashes its CDN does not have: Fortress Merge, 404 everywhere). Without them the store's own pictures are kept.
local icons_served = {}
function M._reset_icons() icons_served = {} end
local function steam_icons_ok(native, steam)
  if icons_served[native] ~= nil then return icons_served[native] end
  local url
  for _, a in ipairs(type(steam) == "table" and type(steam.achievements) == "table" and steam.achievements or {}) do
    url = M.steam_icon_url(a.icon, native)
    if url and url:match("^https://") then break end
    url = nil
  end
  if not url then icons_served[native] = true return true end -- nothing to check: leave it as it was
  local get = M.deps.get_binary or function(u, o) return require("net").get_binary(u, o) end
  local ok, res = pcall(get, url, { source = "steam-icons", max_bytes = 200000 })
  local served = ok and type(res) == "table" and tonumber(res.status) == 200 and type(res.body) == "string" and #res.body > 100
    and (res.body:sub(1, 2) == string.char(255, 216) or res.body:sub(2, 4) == "PNG") or false
  -- a failure to ask (the net is down, a pause) is not proof the CDN lacks them: only a definite answer is kept
  if not served and ok and type(res) == "table" and tonumber(res.status) and tonumber(res.status) ~= 404 then return true end
  if not ok or type(res) ~= "table" then return true end
  icons_served[native] = served
  if not served then require("logger"):info("[provided] Steam app " .. string.format("%d", native) .. " lists achievement pictures its CDN does not serve: the store's own are kept") end
  return served
end

--- Steam's list for a native app: stored, else fetched and stored.
local function steam_list(native)
  local s = ach_store.get_schema(native)
  if s then return s end
  local fetched = (M.deps.steam_fetch or require("steam_schema").fetch)(native)
  if fetched then ach_store.save_schema(native, fetched) end
  return fetched
end

--- { appid, source, provider, key, schema = { achievements }, unlocks = { [id] = unix }, native? }: the player's
--- achievements as the extension found them (the extension is the truth: the unlocks are replaced). Steam's own list
--- (names and icons in the user's language) is kept when the shortcut's Steam match covers every id (ADR-0056 rule).
function M.provide_achievements(data)
  local appid = shortcut(data.appid)
  local source = text(data.source)
  local key = text(data.key)
  local items = type(data.schema) == "table" and type(data.schema.achievements) == "table" and data.schema.achievements or nil
  if not appid or not source or not key or not items or #items == 0 then
    return { error = "need a shortcut appid, a source, a key and a non-empty list" }
  end
  local before = (ach_store.get_state(appid) or {}).unlocks or {}
  local unlocks = {}
  for id, at in pairs(type(data.unlocks) == "table" and data.unlocks or {}) do
    local t = type(at) == "table" and at.unlocked_time or at
    unlocks[tostring(id)] = { unlocked_time = tonumber(t) or 0 }
  end
  local schema_id = source .. "_" .. key
  local schema = {
    native_appid = 0, total = #items, achievements = items, source = source, fetched_at = now(),
    title = text(data.schema.title),
  }
  -- The Steam match: the saved mapping, else the game's title (exact store-search hit); either way the achievements must agree.
  local native = tonumber(data.native) or saved_native(appid)
  local by_title = false
  local waiting = false
  if not (native and native > 0) then
    -- ADR-0086: nothing is looked up on the web until the user ran Library Setup
    local open = (M.deps.allowed or function() return require("net").allowed() end)()
    if open then
      native = title_native(data.schema.title)
      by_title = native ~= nil
    else
      waiting = true
    end
  end
  local enriched, steam_state, kept = 0, waiting and "waiting-for-library-setup" or "no-match", {}
  local overlap = 0
  if native and native > 0 then
    local ok, steam = pcall(steam_list, native)
    local pictures = ok and type(steam) == "table" and steam_icons_ok(native, steam)
    if ok and pictures and covered_by(items, steam) then
      schema_id, schema = native, steam
      steam_state = "covers"
    elseif ok and type(steam) == "table" then
      overlap = M.name_overlap(items, steam)
      if overlap >= M.MIN_OVERLAP or (not pictures and covered_by(items, steam)) then
        enriched, kept = M.enrich_from_steam(items, steam, native, not pictures)
        steam_state = (pictures and "" or "no-pictures-") .. (by_title and "by-title" or "by-name")
      else
        steam_state = "mismatch"
        for _, it in ipairs(items) do kept[#kept + 1] = tostring(it.id) end
      end
    else
      steam_state = "unavailable"
    end
  else
    for _, it in ipairs(items) do kept[#kept + 1] = tostring(it.id) end
  end
  -- A title match whose achievements agree is the same game: the match is saved, so its Game Info is Steam's own page info
  -- (metadata_service: a store's data comes second). A saved match of the user's is never replaced.
  if by_title and (steam_state:find("by-title", 1, true) or steam_state == "covers") and not saved_native(appid) then
    pcall(function() require("steam_store_store").set_mapping(appid, native, text(data.schema.title), "search") end)
  end
  require("logger"):info(string.format("[provided] %s set: items=%d steam=%s overlap=%d%% filled=%d kept-store-icons=%d", source, #items,
    steam_state, math.floor(overlap * 100), enriched, #kept))
  ach_store.save_schema_and_sync(appid, schema_id, schema, unlocks, source)
  local new = {}
  for id in pairs(unlocks) do
    if not before[id] then new[#new + 1] = id end
  end
  table.sort(new)
  return { ok = true, part = require("ach_service").local_part(appid), new = new, enriched = enriched, kept = kept }
end

M.ProvideGame = method("ProvideGame", M.provide_game)
M.ForgetProvidedGame = method("ForgetProvidedGame", M.forget_game)
M.FetchProvidedArt = method("FetchProvidedArt", M.fetch_provided_art)
M.ProvideAchievements = method("ProvideAchievements", M.provide_achievements)

return M
