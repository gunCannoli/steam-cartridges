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

--- Wrap a handler so it decodes/encodes JSON and never throws across the
--- boundary.
---
--- Returning a bare nil crashes Millennium (it tries to parse the result as an
--- integer), so a nil result must become the string 'null'.
---@param name string
---@param func fun(data: table): any
---@return fun(payload: string): string
local function method(name, func)
  return function(payload)
    if jit and jit.off then jit.off() end
    local data = decode_payload(payload) or {}

    local success, result = pcall(func, data)
    if not success then
      logger:error("RPC " .. name .. " failed: " .. tostring(result))
      return json.encode({ error = tostring(result) })
    end

    if result == nil then return "null" end
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
    -- M7a: outgoing requests per source since the backend started, and sources currently paused.
    http_calls       = require("net").stats().http_calls,
    paused           = require("net").stats().paused,
    -- F2: what the last ScreenScraper name search did (no account, no address).
    ss_search        = require("screenscraper_media").last_search,
  }
end)

return RPC
