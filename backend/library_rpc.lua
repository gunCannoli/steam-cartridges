--- Library Setup facade (ADR-0086, plan § 6): the setup window's scan, detect and validate. The work is
--- library_service's; this module only decodes and routes. Detect and validate use the network for the user (a lookup,
--- a link): user actions, so the gate opens for them (rpc.method user_action).

local core    = require("rpc")
local library = require("library_service")

local method = core.method

local M = {}

local function need(data, field)
  if data[field] == nil then error("missing " .. field) end
  return data[field]
end

--- { collections = { ["<appid>"] = { names } } } -> { games = [ row ] }. Offline.
M.LibraryScan = method("LibraryScan", function(data)
  return library.scan(data.collections)
end)

--- { appid, collections = { names }, platform? } -> row. Lookups only; stores the proposal.
M.LibraryDetect = method("LibraryDetect", function(data)
  return library.detect(need(data, "appid"), data.collections, data.platform)
end, { user_action = true })

--- { appids = [ number ], collections = { names } } -> { games = [ row ] }. Lookups only; stores proposals.
M.LibraryDetectAll = method("LibraryDetectAll", function(data)
  local appids = type(data.appids) == "table" and data.appids or {}
  local started = os.time()
  local games = library.detect_all(appids, data.collections)
  -- Sensor (0.7.3.3-debug): a chunk that takes longer than the host waits for an answer is lost to the window (the
  -- log showed "RPC timeout for child" with the rows already stored). Say how long each slow chunk took.
  local took = os.time() - started
  if took >= 10 then
    pcall(function() require("plog").event("setup", string.format("Find matches: a batch of %d game(s) took %ds", #appids, took)) end)
  end
  return { games = games }
end, { user_action = true })

--- { appid, answer = { yes | no | linked | no_achievements | skip | reset = true }, collections = { names } }
---   -> row (+ warnings) | { error }
M.ValidateGame = method("ValidateGame", function(data)
  return library.validate(need(data, "appid"), need(data, "answer"), data.collections)
end, { user_action = true })

--- { appids = [...] } -> { confirmed = [...], skipped = n, failed = { [appid] = err } }. The window fetches the
--- confirmed games after; answered games and games with nothing proposed are skipped.
M.ValidateAllProposed = method("ValidateAllProposed", function(data)
  return library.validate_all(type(data.appids) == "table" and data.appids or {})
end, { user_action = true })

return M
