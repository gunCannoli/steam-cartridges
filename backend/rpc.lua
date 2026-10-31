--- The methods the frontend can call.
---
--- Millennium's RPC channel passes strings, so every method takes a JSON
--- payload and returns JSON.
---
--- Deliberately small. The app detail page used to be built here - GetActivity
--- assembled screenshots, recordings and a session-scoped summary, and
--- GetAsset/GetAssets shipped images across as base64 because
--- steamloopback.host would not serve our paths.
---
--- None of that is needed any more: Steam already indexes a non-Steam game's
--- captures and serves them over that origin itself, so the frontend reads
--- them from Steam's own APIs (ADR-0022). What remains is the library grid,
--- which needs capture timestamps Steam genuinely does not hold.

local json        = require("json")
local logger      = require("logger")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")
local captures    = require("captures")

local RPC = {}

-- Per-session memory of the two diagnostics below (module locals, not globals: test_globals).
local M_signed_seen, M_error_seen, M_error_count = {}, {}, 0

--- Robust payload decoder handling raw JSON, tables, and nested Millennium { payload = "..." }
local function decode_payload(payload_json)
  if type(payload_json) == "table" then
    if type(payload_json.payload) == "string" then
      local ok, inner = pcall(json.decode, payload_json.payload)
      if ok and type(inner) == "table" then return inner end
    end
    return payload_json
  end
  local ok, req = pcall(json.decode, payload_json or "{}")
  if not ok or type(req) ~= "table" then return {} end
  if type(req.payload) == "string" then
    local ok_inner, inner = pcall(json.decode, req.payload)
    if ok_inner and type(inner) == "table" then return inner end
  end
  return req
end

--- CEF and some Millennium builds hand an appid over as a signed int32; every store is keyed unsigned.
local function normalise_appids(data, name)
  for _, key in ipairs({ "appid", "shortcut_appid" }) do
    local n = tonumber(data[key])
    if n and n < 0 and n >= -0x80000000 then
      data[key] = n + 0x100000000
      M_signed_seen[name] = (M_signed_seen[name] or 0) + 1
      -- One line per method per session: which calls still arrive signed (a Linux-only difference we could not see before).
      if M_signed_seen[name] == 1 then
        pcall(function() require("plog").event("rpc", name .. ": appid arrived signed, turned unsigned") end)
      end
    end
  end
  return data
end

--- A handler that answers `{ error = "..." }` did not throw, so nothing logged it: a failing call looked like "no result".
--- One line per method and message per session (the first 40), never the payload.
local function note_error_answer(name, result)
  if type(result) ~= "table" or type(result.error) ~= "string" then return end
  local key = name .. "|" .. result.error:sub(1, 80)
  if M_error_seen[key] or M_error_count >= 40 then return end
  M_error_seen[key] = true
  M_error_count = M_error_count + 1
  pcall(function() require("plog").event("rpc", name .. " answered an error: " .. result.error:sub(1, 160)) end)
end

--- Wrap a handler so it decodes/encodes JSON and never throws across the
--- boundary.
---
--- Returning a bare nil crashes Millennium (it tries to parse the result as an
--- integer), so a nil result must become the string 'null'.
--- `opts.user_action`: the user started this call (a manual link, a search, "Check connection"), so it may use the
--- network before Library Setup has run (net.with_consent, ADR-0086). Background calls (a page view, the start-up
--- sync) never set it.
---@param name string
---@param func fun(data: table): any
---@param opts? { user_action: boolean }
---@return fun(payload: string): string
local function method(name, func, opts)
  local user_action = type(opts) == "table" and opts.user_action == true
  return function(payload)
    if jit and jit.off then jit.off() end
    local data = normalise_appids(decode_payload(payload) or {}, name)

    local success, result
    if user_action then
      success, result = pcall(require("net").with_consent, func, data)
    else
      success, result = pcall(func, data)
    end
    if not success then
      logger:error("RPC " .. name .. " failed: " .. tostring(result))
      return json.encode({ error = tostring(result) })
    end

    if result == nil then return "null" end
    note_error_answer(name, result)
    return json.encode(result)
  end
end

--- Exported so other RPC modules (steam_store_rpc) share one wrapper.
RPC.method = method

--- Batched counts for the library grid.
RPC.GetLibraryStats = method("GetLibraryStats", function(_)
  local paths, err = steam_paths.resolve()
  if not paths then error(err or "could not resolve Steam paths") end

  local stats = captures.library_stats(paths)
  local out = {}
  for appid, entry in pairs(stats) do
    -- JSON object keys must be strings.
    out[tostring(appid)] = entry
  end
  return out
end)

--- Diagnostic: what the backend can see. Used by the smoke test.
RPC.GetDiagnostics = method("GetDiagnostics", function(_)
  local paths, err = steam_paths.resolve()
  if not paths then
    return { ok = false, error = err }
  end

  local entries = shortcuts.parse(paths.shortcuts) or {}
  local counts = captures.non_steam_counts(paths)

  local games_with_media, total_shots = 0, 0
  for _, count in pairs(counts) do
    games_with_media = games_with_media + 1
    total_shots = total_shots + count
  end

  return {
    ok               = true,
    steam_root       = paths.root,
    user_id          = paths.user_id,
    shortcuts        = #entries,
    games_with_media = games_with_media,
    screenshots      = total_shots,
    -- M7a: outgoing requests per source since the backend started, failed ones, the last transport
    -- failure per source, and sources currently paused.
    http_calls       = require("net").stats().http_calls,
    http_failed      = require("net").stats().failed,
    http_last_error  = require("net").stats().last_error,
    paused           = require("net").stats().paused,
    -- F2: what the last ScreenScraper name search did (no account, no address).
    ss_search        = require("screenscraper_media").last_search,
  }
end)

--- Settings: "is the account I just saved connected?" { service = "igdb" | "screenscraper" | "steamgriddb" |
--- "retroachievements" } -> { ok, message }. One small request to that service with the saved values; the line it
--- leaves in the plugin log (net.lua) says what came back.
RPC.TestServiceConnection = method("TestServiceConnection", function(data)
  local service = tostring(data.service or "")
  local ok, success, message
  if service == "igdb" then
    ok, success, message = pcall(function() return require("web_igdb").check() end)
  elseif service == "screenscraper" then
    ok, success, message = pcall(function() return require("screenscraper_media").check() end)
  elseif service == "steamgriddb" then
    ok, success, message = pcall(function() return require("web_sgdb").check(require("web_config").get_api_key()) end)
  elseif service == "retroachievements" then
    ok, success, message = pcall(function() return require("retroachievements").check() end)
  else
    return { ok = false, message = "Unknown service." }
  end
  if not ok then
    logger:error("TestServiceConnection " .. service .. " failed: " .. tostring(success))
    return { ok = false, message = "The check failed: " .. tostring(success) }
  end
  pcall(function() require("plog").event("settings", service .. " connection check: " .. tostring(success) .. " - " .. tostring(message)) end)
  return { ok = success == true, message = message }
end, { user_action = true })

return RPC
