--- Library Setup (ADR-0086, plan § 6): scan, detect, validate. A service: it owns the proposals and the user's choices
--- (proposals_store, choices_store) and applies a validated answer through the services that own each piece of data
--- (steam_store_store for a Steam link, metadata_service for an IGDB / ScreenScraper link, ach_service for the
--- achievement source). It never writes to Steam; the surfaces do, from the record, after the fetch.
---
---   scan(collections)          offline: every shortcut, its platform verdict, its answer or proposal
---   detect(appid, collections) lookups only (Steam store, RetroAchievements by ROM hash, IGDB, ScreenScraper): stores the
---                              proposal, nothing else
---   validate(appid, answer, collections)  yes | no | linked | no_achievements | skip | reset
---
--- Detect and validate use the network: their RPCs are user actions (net.with_consent).

local verdict   = require("platform_verdict")
local choices   = require("choices_store")
local proposals = require("proposals_store")
local platforms = require("platforms")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  entries = nil,      -- fun() -> shortcuts.vdf entries ; nil = registry.entries
  ra = nil,           -- fun(entry) -> { id, title, by = "hash" | "title" } | nil ; nil = RetroAchievements lookups
  steam = nil,        -- fun(title) -> { appid, name, kind } | nil ; nil = steam_store_search (no negative cache write)
  steam_details = nil, -- fun(steam_appid) -> metadata | nil ; nil = appdetails fetch + to_metadata
  igdb = nil,         -- fun(appid, title, info, names) -> metadata | nil ; nil = web_igdb.fetch_game_metadata
  screenscraper = nil, -- fun(appid, title, info) -> metadata | nil ; nil = screenscraper_media.jeu_for -> metadata
  now = function() return os.time() end,
}

local function entries()
  if M.deps.entries then return M.deps.entries() end
  return require("registry").entries()
end

--- A shortcut's appid above 0x7FFFFFFF reaches the backend signed from CEF (knowledgebase "Signed vs Unsigned 32-bit AppId"),
--- while shortcuts.vdf entries and every store are keyed unsigned: turn it back before comparing or keying.
local function unsigned(appid)
  local n = tonumber(appid)
  if n and n < 0 and n >= -0x80000000 then n = n + 0x100000000 end
  return n
end

local function entry_of(appid)
  local n = unsigned(appid)
  for _, e in ipairs(entries()) do
    if tonumber(e.appid) == n then return e end
  end
  return nil
end

--- Did a web metadata lookup actually run in the current detect (a test stub, or a picked and credentialed
--- source)? Read by detect: a game with no proposal and no search gets `no_sources` on its row, so the window can
--- say "turn on a source first" instead of a silent "Needs a link".
local searched_web = false

--- Why an appid does not resolve: how many shortcuts were read, so a report tells a changed file apart from a
--- wrong user (0 read) or a renumbered entry (N read, id missing).
local function entry_or_missing(appid)
  local all = entries()
  for _, e in ipairs(all) do
    if tonumber(e.appid) == unsigned(appid) then return e end
  end
  if #all == 0 then return nil, "not in the library (no shortcuts read - is this the right Steam user?)" end
  return nil, "not in the library (" .. #all .. " shortcuts read)"
end

local function year_of(ts)
  ts = tonumber(ts)
  if not ts or ts <= 0 then return nil end
  return tonumber(os.date("!%Y", ts))
end

-- ---------------------------------------------------------------------------------------------- lookups (detect)

--- Hash only, never title alone: unlocking needs a supported hash, so a title match would attach achievements that can
--- never unlock (visual-only). A ROM whose hash maps to nothing proposes no set at all, and without a hashable ROM
--- there is no proposal either (same rule as get_or_fetch). No hit: nil + why (the [detect] log line).
local function ra_lookup(entry)
  if M.deps.ra then
    local hit = M.deps.ra(entry)
    if hit then return hit end
    return nil, "miss"
  end
  local ra = require("retroachievements")
  local rom = ra.extract_rom_path(entry.exe, entry.launch_options)
  if not rom then return nil, "no-rom" end
  local md5 = ra.compute_rom_md5(rom)
  -- The extension says why (a compressed disc image such as .rvz cannot be hashed); it is a file type, not a name.
  if not md5 then return nil, "hash-fail" .. (tostring(rom):match("(%.%w+)$") and ("(" .. tostring(rom):match("(%.%w+)$"):lower() .. ")") or "") end
  local id = ra.get_game_id_by_md5(md5)
  if not id then return nil, "unmapped" end
  local console = ra.detect_console_id(entry.exe, entry.launch_options)
  return { id = tonumber(id), title = ra.game_title(console, id), by = "hash" }
end

--- Developer, genre and release year of the RetroAchievements game, for the card the user confirms (ADR-0095).
local function ra_info(entry, id)
  if M.deps.ra_info then return M.deps.ra_info(entry, id) end
  return require("retroachievements").game_info(id, entry.exe)
end

--- Did the user turn this source on (the settings copy, ADR-0090)? Nothing is on by default (ADR-0091), and a source that is off or has no
--- account is never asked: Detect asked ScreenScraper with no account and the backend died (seen live 2026-10-27, ADR-0096).
local function source_on(flag, has_account)
  local ok, services = pcall(function() return require("settings_store").get_all().services end)
  if not ok or type(services) ~= "table" or services[flag] ~= true then return false, "off" end
  if has_account then
    local ok_a, has = pcall(has_account)
    if ok_a and has then return true end
    return false, "no-account"
  end
  return true
end

local function steam_lookup(title)
  if M.deps.steam then
    searched_web = true
    local hit = M.deps.steam(title)
    if hit then return hit end
    return nil, "miss"
  end
  local on, why = source_on("steamStoreEnabled")
  if not on then return nil, why end
  searched_web = true
  local search = require("steam_store_search")
  local res = search.search(title, nil, nil) -- no store: Detect writes no negative cache
  if type(res) == "table" and res.error then return nil, "error:" .. tostring(res.error):sub(1, 60) end
  local hit = search.proposal(res)
  if hit then return hit end
  return nil, "miss"
end

local function igdb_lookup(appid, title, info, names)
  if M.deps.igdb then
    searched_web = true
    local meta = M.deps.igdb(appid, title, info, names)
    if meta then return meta end
    return nil, "miss"
  end
  local on, why = source_on("igdbEnabled", function() return require("web_config").get_twitch_credentials() end)
  if not on then return nil, why end
  searched_web = true
  local meta = require("web_igdb").fetch_game_metadata(appid, title, info, names)
  if meta then return meta end
  return nil, "miss" -- the [net] lines beside this one carry a transport cause, if there was one
end

local function screenscraper_lookup(appid, title, info)
  if M.deps.screenscraper then
    searched_web = true
    local meta = M.deps.screenscraper(appid, title, info)
    if meta then return meta end
    return nil, "miss"
  end
  local on, why = source_on("screenscraperEnabled", function() return require("web_config").get_screenscraper_credentials() end)
  if not on then return nil, why end
  searched_web = true
  local jeu, err = require("screenscraper_media").jeu_for(appid, title, info)
  if not jeu then
    if err == "no-credentials" then return nil, "no-account" end
    if err == "request-failed" then return nil, "error:request-failed" end
    return nil, "miss"
  end
  return require("metadata_service").screenscraper_to_metadata(jeu, appid, title)
end

--- The Steam game's store details for the card the user confirms (a search hit names the game only).
--- Lookups only: nothing stored but the proposal. Never throws (a miss leaves the hit as is).
local function steam_details(steam_appid)
  if M.deps.steam_details then return M.deps.steam_details(steam_appid) end
  local ok, appdetails = pcall(require, "steam_store_appdetails")
  if not ok then return nil end
  local ok_f, data = pcall(appdetails.fetch, steam_appid)
  if not ok_f or type(data) ~= "table" then return nil end
  local ok_m, meta = pcall(appdetails.to_metadata, data, 0)
  if not ok_m or type(meta) ~= "table" then return nil end
  return meta
end

--- The signals of a verdict, as the list shows them ("core snes9x", "folder ps2").
local function signal_lines(v)
  local out = {}
  for _, s in ipairs(v.signals or {}) do out[#out + 1] = s.kind .. " " .. tostring(s.detail) end
  return out
end

-- ---------------------------------------------------------------------------------------------- rows

--- The row of one game, as the setup list shows it. Offline.
local function platform_name(id)
  local p = id and platforms.BY_ID[id]
  return p and p.name or nil
end

local function row(e, collections)
  local appid = tonumber(e.appid)
  local choice = choices.get(appid)
  local proposal = proposals.proposal(appid)
  local v = verdict.verdict(e.name or "", e, nil, choice and choice.platform and { platform = choice.platform } or nil, collections)
  local status
  if choice then
    status = choice.kind -- validated | existing | skipped
  elseif v.state == "conflict" then
    status = "conflict"
  elseif proposal == nil then
    status = "not-detected"
  elseif proposal == false then
    status = "needs-link"
  else
    status = "proposed"
  end
  local ach_source
  pcall(function()
    local st = require("achievements_store").get_state(appid)
    ach_source = st and (st.source or (st.schema_appid ~= nil and tostring(st.schema_appid))) or nil
  end)
  local meta = require("web_metadata_db").get(appid)
  -- Detect's verdict included the Steam hit (scan has none): a proposal carries its own state and platform.
  local shown = (not choice and type(proposal) == "table" and proposal.state) and proposal or v
  return {
    appid = appid,
    name = e.name or "",
    state = shown.state,
    platform = shown.platform,
    platform_name = platform_name(choice and choice.platform or shown.platform),
    candidates = v.candidates,
    signals = signal_lines(v),
    status = status,
    choice = choice,
    proposal = proposal or nil,
    metadata = meta and { title = meta.matched_title or meta.title, igdb_id = meta.igdb_id, ss_id = meta.ss_id } or nil,
    achievements = ach_source,
  }
end

--- Every shortcut, offline. `collections`: { ["<appid>"] = { collection names } } from the app (Steam's collections).
function M.scan(collections)
  local counts = {} -- rows by status, for the [scan] log line
  collections = type(collections) == "table" and collections or {}
  local out = {}
  for _, e in ipairs(entries()) do
    local r = row(e, collections[tostring(e.appid)])
    out[#out + 1] = r
    counts[r.status or "?"] = (counts[r.status or "?"] or 0) + 1
  end
  -- The manual link's platform list (the Steam one first, as `steam`).
  local list = {}
  for _, p in ipairs(platforms.LIST) do
    if p.id ~= "pc" then list[#list + 1] = { id = p.id, name = p.name } end
  end
  pcall(function()
    local parts = {}
    for status, n in pairs(counts) do parts[#parts + 1] = status .. " " .. n end
    table.sort(parts)
    require("plog").event("scan", #out .. " games" .. (#parts > 0 and (" (" .. table.concat(parts, ", ") .. ")") or ""))
  end)
  return { games = out, platforms = list }
end

--- One line per looked-up game in the plugin log ([detect]): the verdict and what each source said (a hit, a
--- miss, skipped and why, or the error). Find-matches reports of "nothing was fetched" had no evidence until this
--- (October 2026, Linux). Never throws.
local function log_detect(appid, title, verdict_text, attempts, result)
  pcall(function()
    local middle = #attempts > 0 and (table.concat(attempts, ", ") .. " => ") or ""
    require("plog").event("detect", string.format("%s (%s): %s; %s%s",
      tostring(title), tostring(appid), tostring(verdict_text), middle, tostring(result)))
  end)
end

-- What went wrong, in the user's words, by the kind the network layer recorded (net.lua: classify, or "offline" for an HTTP 5xx).
local ISSUE_TEXT = {
  timeout = "timed out. Its server may be busy; try this game again in a minute.",
  offline = "looks offline (its server answered with an error). Nothing is wrong on your side; try again later.",
  dns = "could not be reached: its address did not resolve. Check your connection, VPN or DNS, then try again.",
  refused = "refused the connection. A firewall may be blocking it, or the service is down; try again later.",
  tls = "could not be reached securely (a proxy or old certificates on this system).",
  ["http-module"] = "could not be reached: Millennium's network module is missing.",
  transport = "did not answer (network problem or the service is down). Try again in a minute.",
}
local ISSUE_SOURCES = {
  { "ScreenScraper", { "screenscraper" } },
  { "RetroAchievements", { "retroachievements" } },
  { "IGDB", { "igdb" } },
  { "Steam's store", { "steam-store", "steam-web", "steam-appdetails" } },
}

local function failed_counts()
  local ok, s = pcall(function() return require("net").stats() end)
  return ok and s or { failed = {}, last_error = {} }
end

--- What to tell the user for each source whose requests failed while one game was looked up (`before`: net.stats() taken
--- first). A failure is never shown as a plain "no match": the sentence names the source and the cause (timeout, offline, ...).
local function source_issues(before)
  local after = failed_counts()
  local out = {}
  for _, s in ipairs(ISSUE_SOURCES) do
    local rose, last = false, nil
    for _, key in ipairs(s[2]) do
      if (after.failed[key] or 0) > ((before.failed or {})[key] or 0) then
        rose = true
        last = after.last_error[key] or last
      end
    end
    if rose then
      local kind = type(last) == "string" and last:match("^%[([%w%-]+)%]") or "transport"
      out[#out + 1] = s[1] .. " " .. (ISSUE_TEXT[kind] or ISSUE_TEXT.transport)
    end
  end
  return out
end

M._source_issues = source_issues -- test seam

--- Look one game up and store what to propose. Lookups only: no record, no link, no artwork, nothing to Steam.
function M.detect(appid, collection_names)
  local e, missing = entry_or_missing(appid)
  if not e then
    log_detect(appid, "?", "no entry", {}, "missing: " .. tostring(missing))
    return { error = missing }
  end
  appid = unsigned(appid)
  searched_web = false
  local net_before = failed_counts()
  local title = e.name or ""
  local v = verdict.verdict(title, e, nil, nil, collection_names)
  if v.state == "conflict" then
    proposals.set_proposal(appid, false, M.deps.now())
    log_detect(appid, title, "conflict", {}, "conflict: a manual link")
    return row(e, collection_names)
  end

  local p = { platform = v.platform, state = v.state }
  local attempts = {} -- what each source said, for the [detect] log line

  -- RetroAchievements first: a ROM hash names the game exactly, and its title is IGDB's second name.
  local ok_ra, ra, ra_why = pcall(ra_lookup, e)
  local ra_taken = ok_ra and ra and not proposals.is_rejected(appid, "ra:" .. tostring(ra.id))
  if not ok_ra then attempts[#attempts + 1] = "ra=error:" .. tostring(ra):sub(1, 60)
  elseif ra == nil then attempts[#attempts + 1] = "ra=" .. tostring(ra_why or "miss")
  elseif proposals.is_rejected(appid, "ra:" .. tostring(ra.id)) then attempts[#attempts + 1] = "ra=rejected:" .. tostring(ra.id)
  else attempts[#attempts + 1] = "ra=hit:" .. tostring(ra.id) end
  if ra_taken then
    p.ra_game_id, p.ra_title, p.ra_by = ra.id, ra.title, ra.by
    local ok_i, info = pcall(ra_info, e, ra.id)
    if ok_i and type(info) == "table" then
      if info.developer then p.developers = { info.developer } end
      if info.genre then p.genres = { info.genre } end
      p.year = p.year or info.year
    end
  end

  -- Steam: only where no console signal says otherwise (a tag, an emulator, a ROM, a folder, a collection).
  if v.state ~= "unknown" and v.state ~= "steam" then attempts[#attempts + 1] = "steam=skipped:console" end
  if v.state == "unknown" or v.state == "steam" then
    local ok_s, hit, hit_why = pcall(steam_lookup, v.title)
    local steam_taken = ok_s and hit and not proposals.is_rejected(appid, "steam:" .. tostring(hit.appid))
    if not ok_s then attempts[#attempts + 1] = "steam=error:" .. tostring(hit):sub(1, 60)
    elseif hit == nil then attempts[#attempts + 1] = "steam=" .. tostring(hit_why or "miss")
    elseif proposals.is_rejected(appid, "steam:" .. tostring(hit.appid)) then attempts[#attempts + 1] = "steam=rejected:" .. tostring(hit.appid)
    else attempts[#attempts + 1] = "steam=hit:" .. tostring(hit.appid) end
    if steam_taken then
      p.steam_appid, p.steam_name, p.steam_kind = hit.appid, hit.name, hit.kind
      -- The hit names the game only: its store details (year, developer, genre) join the proposal,
      -- like the RetroAchievements facts above, so the user confirms with the facts in front of them.
      local ok_d, detail = pcall(steam_details, hit.appid)
      if ok_d and type(detail) == "table" then
        p.year = year_of(detail.release_date) or p.year
        if type(detail.genres) == "table" and #detail.genres > 0 then p.genres = detail.genres end
        if type(detail.developers) == "table" and #detail.developers > 0 then p.developers = detail.developers end
      end
      v = verdict.verdict(title, e, hit, nil, collection_names)
      p.state, p.platform = v.state, v.platform
    end
  end

  -- Game Info: IGDB with the verdict's platform and the RetroAchievements title, else ScreenScraper.
  if not p.steam_appid then
    local info = {}
    for k, val in pairs(e) do info[k] = val end
    info.platform = v.platform
    local ok_i, meta, meta_why = pcall(igdb_lookup, appid, title, info, p.ra_title and { p.ra_title } or nil)
    local igdb_taken = ok_i and meta and meta.igdb_id and not proposals.is_rejected(appid, "igdb:" .. tostring(meta.igdb_id))
    if not ok_i then attempts[#attempts + 1] = "igdb=error:" .. tostring(meta):sub(1, 60)
    elseif meta == nil then attempts[#attempts + 1] = "igdb=" .. tostring(meta_why or "miss")
    elseif meta.igdb_id and proposals.is_rejected(appid, "igdb:" .. tostring(meta.igdb_id)) then attempts[#attempts + 1] = "igdb=rejected:" .. tostring(meta.igdb_id)
    elseif meta.igdb_id then attempts[#attempts + 1] = "igdb=hit:" .. tostring(meta.igdb_id)
    else attempts[#attempts + 1] = "igdb=miss" end
    if igdb_taken then
      p.igdb_id, p.igdb_name, p.year = meta.igdb_id, meta.matched_title, year_of(meta.release_date) or p.year
      p.platforms, p.genres, p.franchises, p.developers = meta.platform_names or meta.platforms, meta.genres or p.genres, meta.franchises, meta.developers or p.developers
      p.themes, p.game_modes, p.perspectives = meta.themes, meta.game_mode_names, meta.perspectives
      attempts[#attempts + 1] = "ss=skipped:igdb-hit"
    else
      local ok_ss, ss, ss_why = pcall(screenscraper_lookup, appid, title, info)
      local ss_taken = ok_ss and ss and ss.ss_id and not proposals.is_rejected(appid, "ss:" .. tostring(ss.ss_id))
      if not ok_ss then attempts[#attempts + 1] = "ss=error:" .. tostring(ss):sub(1, 60)
      elseif ss == nil then attempts[#attempts + 1] = "ss=" .. tostring(ss_why or "miss")
      elseif ss.ss_id and proposals.is_rejected(appid, "ss:" .. tostring(ss.ss_id)) then attempts[#attempts + 1] = "ss=rejected:" .. tostring(ss.ss_id)
      elseif ss.ss_id then attempts[#attempts + 1] = "ss=hit:" .. tostring(ss.ss_id)
      else attempts[#attempts + 1] = "ss=miss" end
      if ss_taken then
        p.ss_id, p.ss_name, p.year = ss.ss_id, ss.matched_title or ss.title, year_of(ss.release_date) or p.year
        p.platforms, p.genres, p.franchises, p.developers = ss.platforms, ss.genres or p.genres, ss.franchises, ss.developers or p.developers
      end
    end
  end

  if p.steam_appid then
    attempts[#attempts + 1] = "igdb=skipped:steam-hit"
    attempts[#attempts + 1] = "ss=skipped:steam-hit"
  end
  p.title = p.steam_name or p.igdb_name or p.ss_name or p.ra_title
  p.signals = signal_lines(v)
  -- No console signal and IGDB lists the game on Windows: it is a PC game (IGDB's release list is the evidence).
  if not p.platform and v.state == "unknown" and type(p.platforms) == "table" then
    for _, name in ipairs(p.platforms) do
      if tostring(name):lower():find("windows", 1, true) then
        p.platform = "pc"
        p.signals[#p.signals + 1] = "released on " .. tostring(name)
        break
      end
    end
  end
  proposals.set_proposal(appid, p.title and p or false, M.deps.now())
  local out = row(e, collection_names)
  if p.title == nil and not searched_web then out.no_sources = true end
  local issues = source_issues(net_before)
  if #issues > 0 then out.source_issues = issues end
  local result = p.title and ("proposed \"" .. tostring(p.title) .. "\"") or (not searched_web and "no-sources" or "needs-link")
  if #issues > 0 then result = result .. string.format(" [%d source(s) did not answer: the window asks the user to try again]", #issues) end
  log_detect(appid, title, tostring(p.state) .. "/" .. tostring(p.platform), attempts, result)
  return out
end

-- ---------------------------------------------------------------------------------------------- validate

local function forget_parts(appid)
  local fresh = require("fresh_policy")
  for _, part in ipairs({ "identity", "metadata", "artwork", "media", "achievements" }) do
    pcall(fresh.forget_part, appid, part)
  end
end

--- A RetroAchievements set attaches only when the ROM hash maps to that same game: re-verified at confirm, so a
--- proposal stored before the hash gate (or a ROM swapped since Detect) cannot attach a set that never unlocks.
--- Returns true, or false + a warning for the card. A hash RetroAchievements never heard of is a definite miss
--- (ra_cache remembers it); anything else without an answer means the set could not be verified.
local function ra_hash_ok(entry, ra_game_id)
  local ra = require("retroachievements")
  local rom = entry and ra.extract_rom_path(entry.exe, entry.launch_options)
  if not rom then return false, "no ROM found to verify the RetroAchievements set" end
  local md5 = ra.compute_rom_md5(rom)
  if not md5 then return false, "the ROM could not be hashed to verify the RetroAchievements set" end
  local id = ra.get_game_id_by_md5(md5)
  if tonumber(id) == tonumber(ra_game_id) then return true end
  if id then return false, "the ROM hash belongs to another RetroAchievements game" end
  local known, known_id = require("ra_cache").game_for(md5)
  if known and not known_id then return false, "the ROM hash is not supported by RetroAchievements for this set" end
  return false, "the RetroAchievements set could not be verified" end

--- Make the proposal the game's own: its Steam link, or its IGDB / ScreenScraper Game Info and RetroAchievements set.
local function apply_proposal(appid, p, entry)
  local choice = { kind = "validated", platform = p.platform }
  local warnings = {}
  if p.steam_appid and (p.state == "steam" or p.state == "steam-proposed") then
    local mapping, err = require("steam_store_store").set_mapping(appid, p.steam_appid, p.steam_name, "manual")
    if not mapping then return nil, err or "could not link the Steam game" end
    pcall(function() require("achievements_store").rebind(appid, p.steam_appid) end)
    choice.platform, choice.steam_appid = "steam", p.steam_appid
    -- The Steam mirror gives no achievements (ADR-0088), so a Steam-matched game has none: no "missing achievements" for it (ADR-0100).
    local none = require("ach_service").set_source(appid, "none")
    if not none.error then choice.achievements = "none" end
  else
    local metadata = require("metadata_service")
    if p.igdb_id then
      local r = metadata.link_igdb(appid, p.igdb_id, p.igdb_name)
      if r.error then return nil, r.error end
      choice.igdb_id = p.igdb_id
    elseif p.ss_id then
      local r = metadata.link_screenscraper(appid, p.ss_id, p.ss_name)
      if r.error then return nil, r.error end
      choice.ss_id = p.ss_id
    end
    if p.ra_game_id then
      local ok_v, verr = ra_hash_ok(entry, p.ra_game_id)
      if not ok_v then
        warnings[#warnings + 1] = "RetroAchievements skipped: " .. verr
      else
        local r = require("ach_service").set_source(appid, "ra", p.ra_game_id)
        if r.error then warnings[#warnings + 1] = r.error else choice.ra_game_id, choice.achievements = p.ra_game_id, "ra" end
      end
    end
  end
  return choice, nil, warnings
end

--- What the game is linked to now (after a manual link in the editor), as a choice.
local function current_links(appid)
  local choice = { kind = "validated" }
  local mapping = require("steam_store_store").get(appid).mapping
  if mapping then choice.steam_appid, choice.platform = mapping.steam_appid, "steam" end
  local meta = require("web_metadata_db").get(appid)
  if meta then choice.igdb_id, choice.ss_id = meta.igdb_id, meta.ss_id end
  pcall(function()
    local st = require("achievements_store").get_state(appid)
    local id = st and st.schema_appid
    if type(id) == "string" and id:match("^ra_") then choice.ra_game_id, choice.achievements = tonumber(id:sub(4)), "ra"
    elseif st and st.source then choice.achievements = st.source end
  end)
  -- A Steam link with no other achievement source: none (the Steam mirror gives none, ADR-0100).
  if choice.steam_appid and not choice.achievements then
    local none = require("ach_service").set_source(appid, "none")
    if not none.error then choice.achievements = "none" end
  end
  return choice
end

--- The user's answer for one game:
---   { yes = true }               the proposal is right: it becomes the game's links, and the game may be fetched
---   { no = true }                the proposal is wrong: dropped and never proposed again (a manual link follows)
---   { linked = true, platform? }  the user linked it by hand (the editor): what is linked now is the answer; `platform`
---                                the one the user picked (else the Steam one when a Steam game is linked)
---   { no_achievements = true }   the game has no achievements (final)
---   { skip = true }              leave the game alone: never fetched
---   { reset = true }             forget the answer (the game waits again)
--- A refused answer, in the log: { error } answers are silent otherwise, and the window only shows them on the card.
local function log_validate_error(appid, err)
  pcall(function()
    require("plog").event("setup", "validate " .. tostring(appid) .. " failed: " .. tostring(err):sub(1, 120))
  end)
end

function M.validate(appid, answer, collection_names)
  local e, missing = entry_or_missing(appid)
  if not e then
    log_validate_error(appid, "missing: " .. tostring(missing))
    return { error = missing }
  end
  appid = unsigned(appid)
  answer = type(answer) == "table" and answer or {}
  local now = M.deps.now()
  local warnings

  if answer.yes then
    local p = proposals.proposal(appid)
    if type(p) ~= "table" then log_validate_error(appid, "nothing proposed for this game") return { error = "nothing proposed for this game" } end
    local choice, err, warns = apply_proposal(appid, p, e)
    if not choice then log_validate_error(appid, err) return { error = err } end
    warnings = warns
    choices.set(appid, choice, now)
    proposals.clear_proposal(appid)
    forget_parts(appid)
  elseif answer.no then
    local p = proposals.proposal(appid)
    if type(p) == "table" then
      if p.steam_appid then proposals.reject(appid, "steam:" .. tostring(p.steam_appid)) end
      if p.igdb_id then proposals.reject(appid, "igdb:" .. tostring(p.igdb_id)) end
      if p.ss_id then proposals.reject(appid, "ss:" .. tostring(p.ss_id)) end
      if p.ra_game_id then proposals.reject(appid, "ra:" .. tostring(p.ra_game_id)) end
    end
    proposals.set_proposal(appid, false, now)
  elseif answer.linked then
    local choice = current_links(appid)
    if type(answer.platform) == "string" and platforms.BY_ID[answer.platform] then choice.platform = answer.platform end
    choices.set(appid, choice, now)
    proposals.clear_proposal(appid)
    forget_parts(appid)
  elseif answer.no_achievements then
    local r = require("ach_service").set_source(appid, "none")
    if r.error then log_validate_error(appid, r.error) return { error = r.error } end
    local choice = choices.get(appid) or current_links(appid)
    choice.achievements = "none"
    choices.set(appid, choice, now)
  elseif answer.skip then
    choices.set(appid, { kind = "skipped" }, now)
  elseif answer.reset then
    choices.forget(appid)
  else
    log_validate_error(appid, "no answer")
    return { error = "no answer" }
  end

  pcall(function() require("plog").event("setup", "validate " .. tostring(appid) .. ": " .. (next(answer) or "?")) end)
  local out = row(e, collection_names)
  out.warnings = warnings
  return out
end

--- Confirm every proposed game at once (the setup window's "Confirm all proposed", reversing decision 6): the Yes
--- path of validate, without rebuilding rows (the window re-scans). Answered games and games with nothing
--- proposed are skipped, never clobbered; a game whose link fails is reported and the rest still confirm.
--- Returns { confirmed = [appid...], skipped = n, failed = { [appid] = err } }.
function M.validate_all(appids)
  local now = M.deps.now()
  local confirmed, skipped, failed = {}, 0, {}
  local seen = {}
  for _, id in ipairs(type(appids) == "table" and appids or {}) do
    local appid = unsigned(id)
    if appid and not seen[appid] then
      seen[appid] = true
      local e = entry_of(appid)
      local p = e and proposals.proposal(appid)
      if not e or type(p) ~= "table" or choices.get(appid) then
        skipped = skipped + 1
      else
        local choice, err = apply_proposal(appid, p, e)
        if not choice then
          failed[tostring(appid)] = err or "could not confirm the proposal"
        else
          choices.set(appid, choice, now)
          proposals.clear_proposal(appid)
          forget_parts(appid)
          confirmed[#confirmed + 1] = appid
        end
      end
    end
  end
  pcall(function() require("plog").event("setup", "validate_all: " .. #confirmed .. " confirmed, " .. skipped .. " skipped") end)
  return { confirmed = confirmed, skipped = skipped, failed = failed }
end

return M
