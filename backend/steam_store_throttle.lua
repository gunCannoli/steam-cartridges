--- One global gate for store.steampowered.com: serial, at most one request per
--- second, measured on the WALL clock (P4 H2: `os.clock` is CPU time, so the
--- old gate spun for a full second after any idle period).
---
--- Offline circuit breaker (P4 H3): a transport failure (no HTTP response at
--- all) makes every background request fail fast with "offline" for OFFLINE_SECONDS, so a
--- disconnected machine never blocks the backend thread for a timeout per view. It heals itself (0.7.3.3-debug):
--- one probe request goes out every PROBE_SECONDS while it is open, any answer closes it, a request the user starts
--- is never held back, and opening and closing are logged (`[net] steam-store offline breaker ...`).

local M = {}

M.INTERVAL = 1.0
M.OFFLINE_SECONDS = 60
M.PROBE_SECONDS = 15
M.TIMEOUT = 8
M.USER_AGENT = "steam-cartridges (Millennium plugin)"

local last = nil
local offline_until = nil
local probe_at = nil   -- when the breaker last let one request through (or opened)
local refused = 0      -- requests it turned away since it opened

local function say(message)
  pcall(function() require("plog").event("net", "steam-store " .. message) end)
end

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
  probe_at = nil
  refused = 0
end

--- Default `http_get(url) -> body | nil, err`: throttled, with our User-Agent.
--- err is "offline" (transport failure or breaker open) or "HTTP <status>".
---
--- `opts.user_action`: the user pressed Search or Link. The breaker never blocks that (a user's own click is the best
--- probe there is, and an open breaker made every search fail with "offline" without sending anything, 0.7.3.2-debug
--- report): the request goes out, and its answer closes or reopens the breaker like any other.
function M.http_get(url, opts)
  local user = type(opts) == "table" and opts.user_action == true
  if not user and M.is_offline() then
    local t = M.now()
    if probe_at and t - probe_at < M.PROBE_SECONDS then
      refused = refused + 1
      return nil, "offline"
    end
    probe_at = t -- one request goes out to find out whether the store is back
  end
  local net = require("net")
  M.acquire()
  -- `user_agent` as a top-level key: Millennium's binding ignores the header form (knowledgebase "libcurl").
  local res, err = net.get(url, {
    source = "steam-store",
    user_agent = M.USER_AGENT,
    headers = { ["Accept"] = "application/json", ["User-Agent"] = M.USER_AGENT },
    timeout = M.TIMEOUT,
  })
  if err == "paused" or err == "setup" then return nil, err end -- a gate, not the network: not "offline"
  if not res or not res.status or res.status == 0 then
    local was_open = offline_until ~= nil and M.now() < offline_until
    offline_until = M.now() + M.OFFLINE_SECONDS
    probe_at = M.now()
    if not was_open then
      refused = 0
      say(string.format("offline breaker opened for %ds: no response (%s)", M.OFFLINE_SECONDS, user and "a request the user started" or "a background request"))
    end
    return nil, "offline"
  end
  if offline_until ~= nil then
    say(string.format("offline breaker closed: the store answered; %d request(s) were turned away meanwhile", refused))
    offline_until, probe_at, refused = nil, nil, 0 -- the store answered: whatever opened the breaker is over
  end
  if res.status ~= 200 or not res.body then return nil, "HTTP " .. tostring(res.status) end
  return res.body
end

return M
