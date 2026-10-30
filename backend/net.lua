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
---
--- The consent gate (ADR-0086): main.lua sets `M.gate` (a function saying whether the plugin may fetch on its own, i.e.
--- the user ran Library Setup). While it says no, a call returns `nil, "setup"` without a request, unless it runs inside
--- `with_consent` (an RPC the user started: a manual link, a store search, "Check connection"). nil gate = open.
---
--- A transport failure (no HTTP response at all) is classified (DNS, refused, timeout, TLS, a missing `http`
--- module) and the first one per source also logs what to check: a Linux report of "Find matches did nothing"
--- for every game had no usable line until this (October 2026).

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

M.gate = nil -- fun(): boolean ; set by main.lua

local consent = 0    -- > 0 while an RPC the user started runs (with_consent)
local calls = {}     -- source -> count of requests actually made
local failures = {}  -- source -> consecutive failures
local failed = {}    -- source -> failed requests this session (transport failure or HTTP >= 500)
local last_transport = {} -- source -> short text of the last transport failure (GetDiagnostics)
local paused = {}    -- source -> epoch seconds until which it is paused
local hinted = {}    -- source -> true once the "what to check" line was logged

--- Millennium's Lua `http` module (libcurl). A missing or broken binding is an ordinary transport failure
--- (nil + error), never a throw: get/post used to call require outside their pcall, so a box without the
--- module failed every source with no log line at all.
local function http_module()
  if M.deps.http then return M.deps.http end
  local ok, mod = pcall(require, "http")
  if not ok then return nil, mod end
  return mod
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
  calls, failures, failed, last_transport, paused, hinted, consent = {}, {}, {}, {}, {}, {}, 0
end

--- Run `fn(...)` with the gate open: the user asked for this call. Errors pass through; the gate closes again.
function M.with_consent(fn, ...)
  consent = consent + 1
  local results = { pcall(fn, ...) }
  consent = consent - 1
  if not results[1] then error(results[2], 0) end
  return unpack(results, 2, table.maxn(results))
end

--- Whether a request may go out now (the gate is open, absent, or the user started the call).
function M.allowed()
  if consent > 0 or M.gate == nil then return true end
  local ok, open = pcall(M.gate)
  return not ok or open == true -- a gate that throws fails open: never a broken plugin because of the gate
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

--- { http_calls = { [source] = n }, failed = { [source] = n }, last_error = { [source] = text },
---   paused = { [source] = until } } (only currently paused sources).
function M.stats()
  local http_calls, still, fail_counts, last_err = {}, {}, {}, {}
  for source, n in pairs(calls) do http_calls[source] = n end
  for source, n in pairs(failed) do fail_counts[source] = n end
  for source, text in pairs(last_transport) do last_err[source] = text end
  for source in pairs(paused) do
    if M.is_paused(source) then still[source] = paused[source] end
  end
  return { http_calls = http_calls, failed = fail_counts, last_error = last_err, paused = still }
end

--- One line for the log at the end of a run: per source, requests sent, failed, paused, and the kind of the last transport failure.
--- Counts and kinds only. Empty when nothing was sent.
function M.summary()
  local s = M.stats()
  local names = {}
  for source in pairs(s.http_calls) do names[#names + 1] = source end
  table.sort(names)
  local parts = {}
  for _, source in ipairs(names) do
    local part = string.format("%s=%d sent/%d failed", source, s.http_calls[source] or 0, s.failed[source] or 0)
    if s.paused[source] then part = part .. "/paused" end
    local kind = (s.last_error[source] or ""):match("^%[([%w%-]+)%]")
    if kind then part = part .. " (last: " .. kind .. ")" end
    parts[#parts + 1] = part
  end
  return table.concat(parts, "; ")
end

--- No HTTP response at all (a throw, nil, or status 0): the network or the binding failed, as opposed to the
--- server answering with an error status. Only these get the "what to check" hint (a 500 reached the server).
local function is_transport_failure(res)
  local status = res and tonumber(res.status)
  return not res or not status or status == 0
end

--- What kind of transport failure this is, from Millennium's error text (libcurl's words, matched loosely).
---@return string kind  one of "dns" | "refused" | "timeout" | "tls" | "http-module" | "transport"
function M.classify(err)
  local s = tostring(err or ""):lower()
  if s:find("module 'http' not found", 1, true) or s:find("millennium http binding", 1, true) then return "http-module" end
  if s:find("resolve", 1, true) or s:find("dns", 1, true) or s:find("no such host", 1, true)
      or s:find("unknown host", 1, true) or s:find("name or service not known", 1, true)
      or s:find("getaddrinfo", 1, true) or s:find("nodename nor servname", 1, true) then return "dns" end
  if s:find("refused", 1, true) or s:find("reset by peer", 1, true) or s:find("connection reset", 1, true)
      or s:find("unreachable", 1, true) or s:find("no route", 1, true) then return "refused" end
  if s:find("timed out", 1, true) or s:find("timeout", 1, true) then return "timeout" end
  if s:find("ssl", 1, true) or s:find("tls", 1, true) or s:find("certificate", 1, true)
      or s:find("handshake", 1, true) or s:find("secure channel", 1, true) then return "tls" end
  return "transport"
end

local HINTS = {
  ["dns"] = "DNS cannot resolve the host: check DNS, a VPN, or a proxy, then try the service in a browser",
  ["refused"] = "the connection was refused or reset: a firewall blocking outbound HTTPS, or the service is down",
  ["timeout"] = "the connection timed out: a firewall dropping packets, a proxy, or a very slow network",
  ["tls"] = "the TLS handshake failed: a proxy intercepting HTTPS, or an outdated CA store on this box",
  ["http-module"] = "Millennium's Lua http module is missing or broken on this install: no fetch can run; reinstall or report to Millennium",
  ["transport"] = "no HTTP response: a firewall, DNS, a proxy, or the service being down",
}

--- The first transport failure of a source logs what to check (once per source per session); every failure also
--- remembers a short text for GetDiagnostics. Never throws.
local function hint(source, kind, err)
  last_transport[source] = ("[" .. kind .. "] " .. tostring(err or "no response")):sub(1, 160)
  if hinted[source] then return end
  hinted[source] = true
  local ok, plog = pcall(require, "plog")
  if ok then plog.event("net", source .. ": first request failed (" .. kind .. "): " .. (HINTS[kind] or HINTS.transport)) end
end

--- Account one finished request against its source's breaker.
local function record(source, res)
  local status = res and tonumber(res.status)
  if status == 429 then
    paused[source] = now() + M.PAUSE_429_SECONDS
    failures[source] = 0
    return
  end
  local bad = not res or not status or status == 0 or status >= 500
  if status and status >= 500 then last_transport[source] = ("[offline] HTTP " .. status):sub(1, 160) end -- the server answered with an error: it is down or broken
  if bad then
    failed[source] = (failed[source] or 0) + 1
    failures[source] = (failures[source] or 0) + 1
    if failures[source] >= M.FAILURES_BEFORE_PAUSE then
      paused[source] = now() + M.PAUSE_FAILURES_SECONDS
      failures[source] = 0
    end
  else
    failures[source] = 0
  end
end

--- One line per finished request in the plugin log (plog.lua; credentials in the URL are scrubbed there): what was
--- asked, what came back, how long it took, and the start of the body when it was not a success. A transport
--- failure carries its kind ([dns], [refused], ...); status 0 (libcurl never got an answer) reads as no response.
local function trace(source, verb, url, res, err, started)
  local ok, plog = pcall(require, "plog")
  if not ok then return end
  local status = res and tonumber(res.status)
  local outcome
  if status and status ~= 0 then
    outcome = tostring(status)
  elseif err == "paused" or err == "setup" then
    outcome = "no request (" .. tostring(err) .. ")"
  else
    local text = err or (type(res) == "table" and type(res.body) == "string" and res.body or nil)
    outcome = "no response [" .. M.classify(text) .. "] (" .. tostring(text) .. ")"
  end
  local line = string.format("%s %s %s -> %s in %dms", source, verb, tostring(url),
    outcome, math.floor((now() - started) * 1000))
  if res and type(res.body) == "string" then
    line = line .. ", " .. #res.body .. " bytes"
    if status and status ~= 0 and (status < 200 or status >= 300) then line = line .. ": " .. res.body:sub(1, 300) end
  end
  plog.event("net", line)
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

--- GET. Returns the response table, or `nil, "paused"` (no request made), or `nil, err`. Never throws: a
--- missing `http` module is an ordinary transport failure, logged with its kind.
---@param url string
---@param opts? { source: string, headers?: table, timeout?: number }
function M.get(url, opts)
  local source = source_of(opts)
  if not M.allowed() then trace(source, "GET", url, nil, "setup", now()) return nil, "setup" end
  if M.is_paused(source) then trace(source, "GET", url, nil, "paused", now()) return nil, "paused" end
  calls[source] = (calls[source] or 0) + 1
  local started = now()
  local http, herr = http_module()
  local get_fn = http and http.get
  if type(get_fn) ~= "function" then
    local err = herr or "Millennium http binding has no get()"
    record(source, nil)
    trace(source, "GET", url, nil, err, started)
    hint(source, M.classify(err), err)
    return nil, tostring(err)
  end
  local ok, res = pcall(get_fn, url, without_source(opts))
  if not ok then
    record(source, nil)
    trace(source, "GET", url, nil, res, started)
    hint(source, M.classify(res), res)
    return nil, tostring(res)
  end
  record(source, res)
  trace(source, "GET", url, res, nil, started)
  if is_transport_failure(res) then hint(source, M.classify(type(res) == "table" and res.body or nil), res and res.body or "no response") end
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
  if not M.allowed() then trace(source, "POST", url, nil, "setup", now()) return nil, "setup" end
  if M.is_paused(source) then trace(source, "POST", url, nil, "paused", now()) return nil, "paused" end
  local started = now()
  local http, herr = http_module()
  if http == nil then
    calls[source] = (calls[source] or 0) + 1
    record(source, nil)
    trace(source, "POST", url, nil, herr, started)
    hint(source, M.classify(herr), herr)
    return nil, tostring(herr)
  end
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
        trace(source, "POST", url, res, nil, started)
        return res
      end
      first_err = first_err or res
    end
  end
  record(source, first_err)
  trace(source, "POST", url, first_err, "no usable response", started)
  if is_transport_failure(first_err) then hint(source, M.classify("no usable response"), "no usable response") end
  return first_err
end

--- GET a binary body (an image) into memory through bin_http (features plan F2b): Millennium's `http.get`
--- cuts a binary body at its first NUL. Same breakers as get(). Returns { status, body, content_type },
--- or `nil, "paused"`, or `nil, err`.
---@param url string
---@param opts? { source: string, user_agent?: string, max_bytes?: number }
function M.get_binary(url, opts)
  local source = source_of(opts)
  if not M.allowed() then trace(source, "GET(bin)", url, nil, "setup", now()) return nil, "setup" end
  if M.is_paused(source) then trace(source, "GET(bin)", url, nil, "paused", now()) return nil, "paused" end
  calls[source] = (calls[source] or 0) + 1
  local started = now()
  local bin_ok, binary = pcall(function() return M.deps.binary or require("bin_http") end)
  if not bin_ok or type(binary) ~= "table" or type(binary.get) ~= "function" then
    local err = bin_ok and "binary download unavailable on this box" or binary
    record(source, nil)
    trace(source, "GET(bin)", url, nil, err, started)
    hint(source, M.classify(err), err)
    return nil, tostring(err)
  end
  local ok, res, err = pcall(binary.get, url, without_source(opts))
  if not ok or not res then
    local err_text = ok and err or res
    record(source, nil)
    trace(source, "GET(bin)", url, nil, err_text, started)
    -- Not supported on this OS (bin_http on Linux) or too large: the box, not the network, so no "what to check".
    local ours = tostring(err_text):find("not supported on this OS", 1, true) or tostring(err_text):find("too large", 1, true)
    if not ours then hint(source, M.classify(err_text), err_text) end
    return nil, tostring(err_text)
  end
  record(source, res)
  trace(source, "GET(bin)", url, res, nil, started)
  if is_transport_failure(res) then hint(source, M.classify(type(res) == "table" and res.body or nil), res and res.body or "no response") end
  return res
end

return M
