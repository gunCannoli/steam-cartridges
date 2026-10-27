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

local function entry_of(appid)
  local n = tonumber(appid)
  for _, e in ipairs(entries()) do
    if tonumber(e.appid) == n then return e end
  end
  return nil
end

local function year_of(ts)
  ts = tonumber(ts)
  if not ts or ts <= 0 then return nil end
  return tonumber(os.date("!%Y", ts))
end

-- ---------------------------------------------------------------------------------------------- lookups (detect)

local function ra_lookup(entry)
  if M.deps.ra then return M.deps.ra(entry) end
  local ra = require("retroachievements")
  local console = ra.detect_console_id(entry.exe, entry.launch_options)
  local rom = ra.extract_rom_path(entry.exe, entry.launch_options)
  local id, by
  if rom then
    local md5 = ra.compute_rom_md5(rom)
    if md5 then id = ra.get_game_id_by_md5(md5); by = id and "hash" or nil end
  end
  if not id and console then
    id = ra.find_game_id_by_title(entry.name or "", entry.exe, entry.launch_options, nil)
    by = id and "title" or nil
  end
  if not id then return nil end
  return { id = tonumber(id), title = ra.game_title(console, id), by = by }
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
  if not ok or type(services) ~= "table" or services[flag] ~= true then return false end
  if has_account then
    local ok_a, has = pcall(has_account)
    return ok_a and has and true or false
  end
  return true
end

local function steam_lookup(title)
  if M.deps.steam then return M.deps.steam(title) end
  if not source_on("steamStoreEnabled") then return nil end
  local search = require("steam_store_search")
  return search.proposal(search.search(title, nil, nil)) -- no store: Detect writes no negative cache
end

local function igdb_lookup(appid, title, info, names)
  if M.deps.igdb then return M.deps.igdb(appid, title, info, names) end
  if not source_on("igdbEnabled", function() return require("web_config").get_twitch_credentials() end) then return nil end
  return require("web_igdb").fetch_game_metadata(appid, title, info, names)
end

local function screenscraper_lookup(appid, title, info)
  if M.deps.screenscraper then return M.deps.screenscraper(appid, title, info) end
  if not source_on("screenscraperEnabled", function() return require("web_config").get_screenscraper_credentials() end) then return nil end
  local jeu = require("screenscraper_media").jeu_for(appid, title, info)
  if not jeu then return nil end
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
  collections = type(collections) == "table" and collections or {}
  local out = {}
  for _, e in ipairs(entries()) do
    out[#out + 1] = row(e, collections[tostring(e.appid)])
  end
  -- The manual link's platform list (the Steam one first, as `steam`).
  local list = {}
  for _, p in ipairs(platforms.LIST) do
    if p.id ~= "pc" then list[#list + 1] = { id = p.id, name = p.name } end
  end
  return { games = out, platforms = list }
end

--- Look one game up and store what to propose. Lookups only: no record, no link, no artwork, nothing to Steam.
function M.detect(appid, collection_names)
  local e = entry_of(appid)
  if not e then return { error = "not in the library" } end
  appid = tonumber(appid)
  local title = e.name or ""
  local v = verdict.verdict(title, e, nil, nil, collection_names)
  if v.state == "conflict" then
    proposals.set_proposal(appid, false, M.deps.now())
    return row(e, collection_names)
  end

  local p = { platform = v.platform, state = v.state }

  -- RetroAchievements first: a ROM hash names the game exactly, and its title is IGDB's second name.
  local ok_ra, ra = pcall(ra_lookup, e)
  if ok_ra and ra and not proposals.is_rejected(appid, "ra:" .. tostring(ra.id)) then
    p.ra_game_id, p.ra_title, p.ra_by = ra.id, ra.title, ra.by
    local ok_i, info = pcall(ra_info, e, ra.id)
    if ok_i and type(info) == "table" then
      if info.developer then p.developers = { info.developer } end
      if info.genre then p.genres = { info.genre } end
      p.year = p.year or info.year
    end
  end

  -- Steam: only where no console signal says otherwise (a tag, an emulator, a ROM, a folder, a collection).
  if v.state == "unknown" or v.state == "steam" then
    local ok_s, hit = pcall(steam_lookup, v.title)
    if ok_s and hit and not proposals.is_rejected(appid, "steam:" .. tostring(hit.appid)) then
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
    local ok_i, meta = pcall(igdb_lookup, appid, title, info, p.ra_title and { p.ra_title } or nil)
    if ok_i and meta and meta.igdb_id and not proposals.is_rejected(appid, "igdb:" .. tostring(meta.igdb_id)) then
      p.igdb_id, p.igdb_name, p.year = meta.igdb_id, meta.matched_title, year_of(meta.release_date) or p.year
      p.platforms, p.genres, p.franchises, p.developers = meta.platform_names or meta.platforms, meta.genres or p.genres, meta.franchises, meta.developers or p.developers
      p.themes, p.game_modes, p.perspectives = meta.themes, meta.game_mode_names, meta.perspectives
    else
      local ok_ss, ss = pcall(screenscraper_lookup, appid, title, e)
      if ok_ss and ss and ss.ss_id and not proposals.is_rejected(appid, "ss:" .. tostring(ss.ss_id)) then
        p.ss_id, p.ss_name, p.year = ss.ss_id, ss.matched_title or ss.title, year_of(ss.release_date) or p.year
        p.platforms, p.genres, p.franchises, p.developers = ss.platforms, ss.genres or p.genres, ss.franchises, ss.developers or p.developers
      end
    end
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
  return row(e, collection_names)
end

-- ---------------------------------------------------------------------------------------------- validate

local function forget_parts(appid)
  local fresh = require("fresh_policy")
  for _, part in ipairs({ "identity", "metadata", "artwork", "media", "achievements" }) do
    pcall(fresh.forget_part, appid, part)
  end
end

--- Make the proposal the game's own: its Steam link, or its IGDB / ScreenScraper Game Info and RetroAchievements set.
local function apply_proposal(appid, p)
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
      local r = require("ach_service").set_source(appid, "ra", p.ra_game_id)
      if r.error then warnings[#warnings + 1] = r.error else choice.ra_game_id, choice.achievements = p.ra_game_id, "ra" end
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
function M.validate(appid, answer, collection_names)
  local e = entry_of(appid)
  if not e then return { error = "not in the library" } end
  appid = tonumber(appid)
  answer = type(answer) == "table" and answer or {}
  local now = M.deps.now()
  local warnings

  if answer.yes then
    local p = proposals.proposal(appid)
    if type(p) ~= "table" then return { error = "nothing proposed for this game" } end
    local choice, err, warns = apply_proposal(appid, p)
    if not choice then return { error = err } end
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
    if r.error then return { error = r.error } end
    local choice = choices.get(appid) or current_links(appid)
    choice.achievements = "none"
    choices.set(appid, choice, now)
  elseif answer.skip then
    choices.set(appid, { kind = "skipped" }, now)
  elseif answer.reset then
    choices.forget(appid)
  else
    return { error = "no answer" }
  end

  pcall(function() require("plog").event("setup", "validate " .. tostring(appid) .. ": " .. (next(answer) or "?")) end)
  local out = row(e, collection_names)
  out.warnings = warnings
  return out
end

return M
