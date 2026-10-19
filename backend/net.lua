--- The one outgoing HTTP entry point (migration plan M7a).
---
--- Every backend module that talks to the network goes through `net.get` / `net.post` with a
--- `source` id ("steam-store", "igdb", "retroachievements", "steam-web", "sgdb", "screenscraper").
--- Per source it keeps a call counter (GetDiagnostics `http_calls`) and a circuit breaker:
---   HTTP 429                 -> the source is paused 30 minutes
---   5 consecutive failures   -> the source is paused 15 minutes   (transport error or HTTP >= 500)
--- While a source is paused a call returns `nil, "paused"` without making a request.
---
--- The return value on success is Millennium's own response table ({ status, body, ... }), so
--- callers keep their existing status checks.

local M = {}

M.PAUSE_429_SECONDS = 30 * 60
M.PAUSE_FAILURES_SECONDS = 15 * 60
M.FAILURES_BEFORE_PAUSE = 5

--- Injectable for tests. nil = the real dependency.
M.deps = {
  http = nil, -- nil = require("http")
  binary = nil, -- nil = require("bin_http") (get_binary)
  now = nil,  -- nil = wall clock in seconds
}

local calls = {}     -- source -> count of requests actually made
local failures = {}  -- source -> consecutive failures
local paused = {}    -- source -> epoch seconds until which it is paused

local function http_module()
  return M.deps.http or require("http")
end

--- Wall-clock seconds (Millennium's datetime.now() is milliseconds; os.time() is the fallback).
local function now()
  if M.deps.now then return M.deps.now() end
  local ok, dt = pcall(require, "datetime")
  if ok and type(dt) == "table" and type(dt.now) == "function" then
    local ms = dt.now()
    if type(ms) == "number" then return ms / 1000 end
  end
  return os.time()
end

function M._reset()
  calls, failures, paused = {}, {}, {}
end

function M.is_paused(source)
  local untilt = paused[source]
  if not untilt then return false end
  if now() >= untilt then
    paused[source], failures[source] = nil, 0
    return false
  end
  return true
end

--- { http_calls = { [source] = n }, paused = { [source] = until } } (only currently paused sources).
function M.stats()
  local http_calls, still = {}, {}
  for source, n in pairs(calls) do http_calls[source] = n end
  for source in pairs(paused) do
    if M.is_paused(source) then still[source] = paused[source] end
  end
  return { http_calls = http_calls, paused = still }
end

--- Account one finished request against its source's breaker.
local function record(source, res)
  local status = res and tonumber(res.status)
  if status == 429 then
    paused[source] = now() + M.PAUSE_429_SECONDS
    failures[source] = 0
    return
  end
  local failed = not res or not status or status == 0 or status >= 500
  if failed then
    failures[source] = (failures[source] or 0) + 1
    if failures[source] >= M.FAILURES_BEFORE_PAUSE then
      paused[source] = now() + M.PAUSE_FAILURES_SECONDS
      failures[source] = 0
    end
  else
    failures[source] = 0
  end
end

local function source_of(opts)
  return (opts and opts.source) or "other"
end

local function without_source(opts)
  local out = {}
  for k, v in pairs(opts or {}) do
    if k ~= "source" then out[k] = v end
  end
  return out
end

--- GET. Returns the response table, or `nil, "paused"` (no request made), or `nil, err`.
---@param url string
---@param opts? { source: string, headers?: table, timeout?: number }
function M.get(url, opts)
  local source = source_of(opts)
  if M.is_paused(source) then return nil, "paused" end
  calls[source] = (calls[source] or 0) + 1
  local ok, res = pcall(http_module().get, url, without_source(opts))
  if not ok then
    record(source, nil)
    return nil, tostring(res)
  end
  record(source, res)
  return res
end

--- POST. Millennium's Lua bindings vary, so try the known shapes in order and return the
--- first usable response: 2xx, or 400/401 (a definite answer from the API, e.g. bad
--- credentials), otherwise the first error response seen.
---@param url string
---@param body string
---@param opts? { source: string, headers?: table, timeout?: number }
function M.post(url, body, opts)
  local source = source_of(opts)
  if M.is_paused(source) then return nil, "paused" end
  local http = http_module()
  local o = without_source(opts)
  local headers, timeout = o.headers or {}, o.timeout or 20
  body = body or ""

  local attempts = {}
  if type(http.request) == "function" then
    attempts[#attempts + 1] = function() return http.request(url, { method = "POST", data = body, headers = headers, timeout = timeout }) end
    attempts[#attempts + 1] = function() return http.request(url, { method = "POST", body = body, headers = headers, timeout = timeout }) end
  end
  if type(http.post) == "function" then
    attempts[#attempts + 1] = function() return http.post(url, { method = "POST", data = body, headers = headers, timeout = timeout }) end
    attempts[#attempts + 1] = function() return http.post(url, { method = "POST", body = body, headers = headers, timeout = timeout }) end
    attempts[#attempts + 1] = function() return http.post(url, { data = body, headers = headers, timeout = timeout }) end
    attempts[#attempts + 1] = function() return http.post(url, { body = body, headers = headers, timeout = timeout }) end
  end

  calls[source] = (calls[source] or 0) + 1
  local first_err = nil
  for _, attempt in ipairs(attempts) do
    local ok, res = pcall(attempt)
    if ok and type(res) == "table" and res.status then
      if (res.status >= 200 and res.status < 300) or res.status == 400 or res.status == 401 then
        record(source, res)
        return res
      end
      first_err = first_err or res
    end
  end
  record(source, first_err)
  return first_err
end

--- GET a binary body (an image) into memory through bin_http (features plan F2b): Millennium's `http.get`
--- cuts a binary body at its first NUL. Same breakers as get(). Returns { status, body, content_type },
--- or `nil, "paused"`, or `nil, err`.
---@param url string
---@param opts? { source: string, user_agent?: string, max_bytes?: number }
function M.get_binary(url, opts)
  local source = source_of(opts)
  if M.is_paused(source) then return nil, "paused" end
  calls[source] = (calls[source] or 0) + 1
  local binary = M.deps.binary or require("bin_http")
  local ok, res, err = pcall(binary.get, url, without_source(opts))
  if not ok or not res then
    record(source, nil)
    return nil, ok and tostring(err) or tostring(res)
  end
  record(source, res)
  return res
end

return M
