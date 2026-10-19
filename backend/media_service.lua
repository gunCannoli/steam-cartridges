--- Community media: what Steam's Community Content section shows for a shortcut with no Steam match
--- (features plan F2, ADR-0046). One `media` part per shortcut: videos, screenshots and artworks.
---
--- Sources, each only when the frontend allows it (settings + routing, as for metadata):
---   igdb           the IGDB game Game Info already shows (ctx.igdb_id, from the metadata part): YouTube
---                  trailers, screenshots, artworks. No title search: a game without an IGDB id has no IGDB
---                  media, so the media never belongs to another game than the one Game Info names.
---   screenscraper  the `jeu` the metadata source matched (screenscraper_media.jeu_for): screenshot, title
---                  screen, fanart. Stored as keys; image() downloads the bytes on demand, into memory, and keeps
---                  them on disk for `cacheDays` (media_cache, ADR-0051), as the manual's PDF and cover.
--- A shortcut with a Steam match gets Steam's own community content (native-links, ADR-0038): unsupported.
---
--- ADR-0014: a missing account or a failed lookup is silent (needs-setup / error), never a toast.
--- The ScreenScraper URLs carry the account: nothing here returns, stores or logs one.

local store = require("media_store")
local cache = require("media_cache")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  igdb_query = nil,    -- nil = web_igdb.query(apicalypse)
  ss_jeu = nil,        -- nil = screenscraper_media.jeu_for(appid, title, info) -> jeu | nil, err
  provided = nil,      -- fun(appid) -> pushed record | nil ; nil = provided_store.get (ADR-0067)
  shortcut_info = nil, -- nil = registry.shortcut (the shortcuts.vdf entry)
  download = nil,      -- nil = screenscraper_media.download(url) -> body, ext, width, height
  download_document = nil, -- nil = screenscraper_media.download_document(url) -> body | nil, err
  fresh = nil,         -- nil = fresh_policy
  cache = nil,         -- nil = media_cache
  now = function() return os.time() end,
}

local IGDB_IMAGE = "https://images.igdb.com/igdb/image/upload/"
local IGDB_FIELDS = "fields videos.video_id, videos.name, screenshots.image_id, screenshots.width, screenshots.height, "
  .. "artworks.image_id, artworks.width, artworks.height; "

local function now_ms() return math.floor((M.deps.now or os.time)() * 1000) end
local function fresh() return M.deps.fresh or require("fresh_policy") end
local function disk() return M.deps.cache or cache end

--- The names a game's downloads have in media_cache: one namespace per kind, the key after it.
local function image_name(key) return "image " .. key end
local function manual_name(key) return "manual " .. key end
local function cover_name(key) return "cover " .. key end
--- A key whose media is not an image (the HyperSpin theme zip): remembered so the next start refuses it without the
--- ScreenScraper lookup that finding out costs (3-15 s, and the whole feed waits for it).
local function not_image_name(key) return "not-image " .. key end

local function shortcut_info(appid)
  if M.deps.shortcut_info then return M.deps.shortcut_info(appid) end
  return require("registry").shortcut(appid)
end

local function igdb_query(q) return (M.deps.igdb_query or require("web_igdb").query)(q) end

--- The media an extension pushed for the shortcut (ADR-0067: Epic, Xbox screenshots, public URLs), or nil. Disk only.
local function provided_items(appid)
  local rec = M.deps.provided and M.deps.provided(appid) or require("provided_store").get(appid)
  if type(rec) ~= "table" or type(rec.media) ~= "table" then return nil, nil end
  return rec.media, rec.source
end

local function ss_jeu(appid, title, info)
  return (M.deps.ss_jeu or require("screenscraper_media").jeu_for)(appid, title, info)
end

--- One IGDB game -> media items (pure): { kind, source = "igdb", youtube?, url?, thumb?, width?, height?, title? }.
function M.igdb_items(game)
  local items = {}
  if type(game) ~= "table" then return items end
  for _, v in ipairs(type(game.videos) == "table" and game.videos or {}) do
    if type(v) == "table" and type(v.video_id) == "string" and v.video_id ~= "" then
      items[#items + 1] = { kind = "video", source = "igdb", youtube = v.video_id, title = v.name }
    end
  end
  local function images(list, kind)
    for _, a in ipairs(type(list) == "table" and list or {}) do
      if type(a) == "table" and type(a.image_id) == "string" and a.image_id ~= "" then
        items[#items + 1] = {
          kind = kind,
          source = "igdb",
          url = IGDB_IMAGE .. "t_1080p/" .. a.image_id .. ".jpg",
          thumb = IGDB_IMAGE .. "t_screenshot_big/" .. a.image_id .. ".jpg",
          width = tonumber(a.width) or 1920,
          height = tonumber(a.height) or 1080,
        }
      end
    end
  end
  images(game.screenshots, "screenshot")
  images(game.artworks, "artwork")
  return items
end

local function part(status, data, extra)
  local p = { status = status, data = data, checkedAt = now_ms() }
  for k, v in pairs(extra or {}) do p[k] = v end
  return p
end

--- The media part for a shortcut. ctx = { title, route = { bucket, via }, identity?, igdb_id?, allowWeb?,
--- allowScreenscraper?, noNetwork?, force? }.
function M.ensure(appid, ctx)
  ctx = ctx or {}
  local route = ctx.route or {}
  if route.bucket == "none" then return part("unsupported") end
  local identity = ctx.identity
  if identity and identity.data and identity.data.native then return part("unsupported", nil, { message = "steam" }) end
  -- The page is open: its downloads stay on disk through the next prune (ADR-0051).
  if cache.days(ctx.cacheDays) > 0 then pcall(disk().touch, appid) end

  local stored = store.get(appid)
  if route.via == "pending" then
    if stored then return part("ok", stored, { source = "local" }) end
    return part("pending")
  end

  local igdb_id = tonumber(ctx.igdb_id)
  local use_igdb = ctx.allowWeb and igdb_id ~= nil
  local use_ss = ctx.allowScreenscraper and true or false
  local pushed, pushed_source = provided_items(appid)
  local use_store = pushed ~= nil
  local can_fetch = ((use_igdb or use_ss) and not ctx.noNetwork) or use_store
  if stored then
    local due = ctx.force or fresh().is_stale(appid, "media", { status = "ok" }, now_ms())
    if use_store and not ctx.noNetwork and not due then
      -- Pushed media the stored list does not have yet (an extension reported after the last refresh): refresh now.
      local has = false
      for _, it in ipairs(type(stored.items) == "table" and stored.items or {}) do
        if it.source == pushed_source then has = true break end
      end
      due = not has
    end
    if not (due and can_fetch) then return part("ok", stored, { source = "local" }) end
  elseif not can_fetch then
    return part(ctx.noNetwork and "pending" or "unsupported")
  end

  local items, data = {}, {}
  local answered, sources, setup_missing = false, {}, false
  -- What an extension pushed first (ADR-0067), then IGDB, then ScreenScraper; domain/community-media orders the cards.
  if use_store then
    answered = true
    sources[#sources + 1] = pushed_source
    for _, it in ipairs(pushed) do items[#items + 1] = it end
  end
  use_igdb = use_igdb and not ctx.noNetwork
  use_ss = use_ss and not ctx.noNetwork
  if use_igdb then
    igdb_id = math.floor(igdb_id)
    local ok, res = pcall(igdb_query, IGDB_FIELDS .. "where id = " .. igdb_id .. ";")
    if ok and type(res) == "table" then
      answered = true
      data.igdb_id = igdb_id
      sources[#sources + 1] = "igdb"
      for _, it in ipairs(M.igdb_items(res[1])) do items[#items + 1] = it end
    end
  end
  if use_ss then
    local ok, jeu, err = pcall(ss_jeu, appid, ctx.title or "", shortcut_info(appid))
    if ok and type(jeu) == "table" then
      answered = true
      data.ss_id = tonumber(jeu.id)
      sources[#sources + 1] = "screenscraper"
      local media = require("screenscraper_media")
      for _, it in ipairs(media.media_items(jeu)) do items[#items + 1] = it end
      local manual = media.manual_item(jeu)
      if manual then items[#items + 1] = manual end
    elseif ok and err == "not-found" then
      answered = true -- a definite "no such game": no media, not a failure
    elseif ok and err == "no-credentials" then
      setup_missing = true
    end
  end

  if not answered then
    if stored then
      fresh().touch(appid, "media", now_ms(), "error") -- due again after the short error TTL
      return part("ok", stored, { source = "local" })
    end
    if setup_missing and not use_igdb then return part("needs-setup", nil, { message = "screenscraper account" }) end
    local net = require("net")
    if (use_igdb and net.is_paused("igdb")) or (use_ss and net.is_paused("screenscraper")) then
      return part("pending", nil, { message = "paused" })
    end
    return part("error", nil, { message = "no media source answered" })
  end

  data.items = items
  store.set(appid, data)
  fresh().touch(appid, "media", now_ms())
  return part("ok", data, { source = table.concat(sources, "+") })
end

--- One ScreenScraper media item's bytes as base64 (GetMediaImage): { base64, ext, width?, height? }, or nil
--- and an error. The URL is looked up here and never leaves this function. With `days` > 0 the bytes come from disk
--- when an earlier download kept them (no ScreenScraper call at all), and a download is kept (ADR-0051).
function M.image(appid, key, title, days)
  if type(key) ~= "string" or key == "" then return nil, "missing key" end
  local media = require("screenscraper_media")
  local keep = cache.days(days) > 0
  if keep then
    if disk().get(appid, not_image_name(key)) then return nil, "not an image" end
    local stored = disk().get(appid, image_name(key))
    local ext = stored and media.image_type(stored)
    if ext then
      local width, height = media.image_size(stored, ext)
      return { base64 = require("utils").base64_encode(stored), ext = ext, width = width, height = height }
    end
  end
  local ok, jeu, err = pcall(ss_jeu, appid, title or "", shortcut_info(appid))
  if not ok or type(jeu) ~= "table" then return nil, ok and tostring(err or "not-found") or "not-found" end
  local url, format = media.media_url(jeu, key)
  if not url then return nil, "unknown key" end
  -- A record cached before the format filter may still name a non-image (the HyperSpin theme zip): no download for it.
  if not media.is_image_format(format) then
    if keep then disk().set(appid, not_image_name(key), "1") end
    return nil, "not an image"
  end
  local body, ext, width, height = (M.deps.download or media.download)(url)
  if not body then
    if keep and ext == "not an image" then disk().set(appid, not_image_name(key), "1") end
    return nil, ext
  end
  if keep then disk().set(appid, image_name(key), body) end
  return { base64 = require("utils").base64_encode(body), ext = ext, width = width, height = height }
end

--- One downloaded manual, kept while the frontend reads it in chunks: { appid, key, body, at }. One at a time.
local manual_doc = nil
--- A copy younger than this is reused by chunk 0: a download that outlasts the caller's 30 s RPC limit still completes here,
--- and the caller's retry must find it instead of downloading again (a 7.5 MiB manual took 30+ s live, 2026-10-01).
M.MANUAL_DOC_TTL = 600
--- Bytes per GetManualChunk answer (base64 makes it 4/3 larger on the RPC).
M.MANUAL_CHUNK_BYTES = 1024 * 1024

--- Chunk `index` (0-based) of a ScreenScraper manual as base64 (GetManualChunk): { base64, index, chunks, size }, or nil
--- and an error. Chunk 0 downloads the PDF into memory (or reuses a copy under MANUAL_DOC_TTL old); the other chunks read
--- that copy. The URL never leaves here.
function M.manual_chunk(appid, key, title, index, days)
  if type(key) ~= "string" or key == "" then return nil, "missing key" end
  index = math.floor(tonumber(index) or 0)
  if index < 0 then return nil, "bad index" end
  local held = manual_doc and manual_doc.appid == appid and manual_doc.key == key and os.time() - manual_doc.at < M.MANUAL_DOC_TTL
  if not held then
    manual_doc = nil
    local keep = cache.days(days) > 0
    -- A PDF kept on disk by an earlier download (ADR-0051): no ScreenScraper call.
    local body = keep and disk().get(appid, manual_name(key)) or nil
    if body and body:sub(1, 5) ~= "%PDF-" then body = nil end
    if not body then
      local media = require("screenscraper_media")
      local ok, jeu, err = pcall(ss_jeu, appid, title or "", shortcut_info(appid))
      if not ok or type(jeu) ~= "table" then return nil, ok and tostring(err or "not-found") or "not-found" end
      local url = media.media_url(jeu, key)
      if not url then return nil, "unknown key" end
      local derr
      body, derr = (M.deps.download_document or media.download_document)(url)
      if not body then return nil, derr end
      if keep then disk().set(appid, manual_name(key), body) end
    end
    manual_doc = { appid = appid, key = key, body = body, at = os.time() }
  end
  local body = manual_doc.body
  local chunks = math.max(1, math.ceil(#body / M.MANUAL_CHUNK_BYTES))
  if index >= chunks then return nil, "bad index" end
  local from = index * M.MANUAL_CHUNK_BYTES + 1
  local piece = body:sub(from, from + M.MANUAL_CHUNK_BYTES - 1)
  if index == chunks - 1 then manual_doc = nil end -- the last chunk read: free the copy
  return { base64 = require("utils").base64_encode(piece), index = index, chunks = chunks, size = #body }
end


--- The stored first-page cover of a manual (GetManualCover): { base64 } or {} when none is stored (or `days` is 0).
function M.manual_cover(appid, key, days)
  if type(key) ~= "string" or key == "" then return nil, "missing key" end
  if cache.days(days) == 0 then return {} end
  local body = disk().get(appid, cover_name(key))
  if not body then return {} end
  return { base64 = require("utils").base64_encode(body) }
end

--- Store a manual's first-page cover from base64 (SaveManualCover): { ok = true }, { ok = false } when `days` is 0
--- (nothing goes to disk), or nil and an error.
function M.save_manual_cover(appid, key, base64, days)
  if type(key) ~= "string" or key == "" then return nil, "missing key" end
  if cache.days(days) == 0 then return { ok = false } end
  local body = require("shortcut_icon").decode_base64(base64)
  if not body then return nil, "not base64" end
  local ok, err = disk().set(appid, cover_name(key), body)
  if not ok then return nil, err end
  return { ok = true }
end

--- Delete the downloads of every game not opened in the last `days` days (PruneMediaCache, ADR-0051).
function M.prune_cache(days)
  return disk().prune(days)
end

return M
