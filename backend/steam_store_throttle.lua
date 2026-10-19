--- One global gate for store.steampowered.com: serial, at most one request per
--- second, measured on the WALL clock (P4 H2: `os.clock` is CPU time, so the
--- old gate spun for a full second after any idle period).
---
--- Offline circuit breaker (P4 H3): a transport failure (no HTTP response at
--- all) makes every request fail fast with "offline" for OFFLINE_SECONDS, so a
--- disconnected machine never blocks the backend thread for a timeout per view.

local M = {}

M.INTERVAL = 1.0
M.OFFLINE_SECONDS = 300
M.TIMEOUT = 8
M.USER_AGENT = "steam-cartridges (Millennium plugin)"

local last = nil
local offline_until = nil

--- Wall-clock seconds. Millennium's `datetime.now()` returns milliseconds;
--- `os.time()` (whole seconds) is the fallback outside Millennium.
M.now = function()
  local ok, dt = pcall(require, "datetime")
  if ok and type(dt) == "table" and type(dt.now) == "function" then
    local ms = dt.now()
    if type(ms) == "number" then return ms / 1000 end
  end
  return os.time()
end

M.sleep = function(seconds) -- busy wait; there is no sleep primitive in the sandbox
  local t = M.now()
  while M.now() - t < seconds do end
end

--- Block until a request may be made, then stamp it.
function M.acquire()
  local now = M.now()
  if last and now - last < M.INTERVAL then
    M.sleep(M.INTERVAL - (now - last))
  end
  last = M.now()
end

function M.is_offline()
  return offline_until ~= nil and M.now() < offline_until
end

function M._reset()
  last = nil
  offline_until = nil
end

--- Default `http_get(url) -> body | nil, err`: throttled, with our User-Agent.
--- err is "offline" (transport failure or breaker open) or "HTTP <status>".
function M.http_get(url)
  if M.is_offline() then return nil, "offline" end
  local net = require("net")
  M.acquire()
  local res, err = net.get(url, {
    source = "steam-store",
    headers = { ["Accept"] = "application/json", ["User-Agent"] = M.USER_AGENT },
    timeout = M.TIMEOUT,
  })
  if err == "paused" then return nil, "paused" end
  if not res or not res.status or res.status == 0 then
    offline_until = M.now() + M.OFFLINE_SECONDS
    return nil, "offline"
  end
  if res.status ~= 200 or not res.body then return nil, "HTTP " .. tostring(res.status) end
  return res.body
end

return M
