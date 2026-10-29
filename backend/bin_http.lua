--- Binary HTTP GET into memory (features plan F2b), for images whose bytes the backend must fetch itself.
---
--- Millennium's Lua `http.get` returns the body as a C string, so a binary body is cut at its first NUL
--- byte (icon plan § 11); the frontend cannot fetch ScreenScraper either (no CORS, verified live
--- 2026-09-30). This module calls WinINet through LuaJIT's FFI (the same FFI `silent_exec.lua` uses for
--- kernel32): the body stays in memory, nothing is written to disk and no process is spawned, so the
--- URL (which carries the ScreenScraper account) never reaches a command line, a file or a log.
---
--- Linux (and any non-Windows box): the same contract through `curl`, which every desktop distro and the Steam Deck ship. The
--- URL and the User-Agent go to curl's stdin as a config (`-K -`), never to its argument list, so the account in the URL is not
--- visible in `ps` or `/proc`; the body goes to a private temp file (mkstemp, mode 0600) that is removed at once.
---
--- Callers use `net.get_binary` (the circuit breakers), never this module directly.

local M = {}

M.MAX_BYTES = 8 * 1024 * 1024
M.TIMEOUT_MS = 15000

M.deps = {
  windows = nil,  -- boolean ; nil = platform.is_windows()
  have_curl = nil, -- boolean ; nil = `command -v curl`
  popen = nil,    -- fun(cmd, mode) -> handle ; nil = io.popen
  tmpname = nil,  -- fun() -> path ; nil = os.tmpname
  read = nil,     -- fun(path) -> bytes | nil ; nil = io.open + read
  remove = nil,   -- fun(path) ; nil = os.remove
}

local ffi_ok, ffi = pcall(require, "ffi")
local wininet = nil

local function load()
  if wininet ~= nil then return wininet end
  wininet = false
  if not ffi_ok or not ffi then return false end
  if not _G.__WININET_CDEF_LOADED then
    ffi.cdef[[
      void* InternetOpenA(const char* agent, unsigned long access, const char* proxy, const char* bypass, unsigned long flags);
      void* InternetOpenUrlA(void* session, const char* url, const char* headers, unsigned long headers_len, unsigned long flags, uintptr_t context);
      int InternetReadFile(void* handle, void* buffer, unsigned long to_read, unsigned long* read);
      int InternetCloseHandle(void* handle);
      int InternetSetOptionA(void* handle, unsigned long option, void* buffer, unsigned long length);
      int HttpQueryInfoA(void* request, unsigned long level, void* buffer, unsigned long* length, unsigned long* index);
    ]]
    _G.__WININET_CDEF_LOADED = true
  end
  local ok, lib = pcall(ffi.load, "wininet")
  if ok then wininet = lib end
  return wininet
end

local OPEN_PRECONFIG = 0           -- INTERNET_OPEN_TYPE_PRECONFIG: the system proxy settings
local OPTION_CONNECT_TIMEOUT = 2
local OPTION_RECEIVE_TIMEOUT = 6
local QUERY_CONTENT_TYPE = 1
local QUERY_STATUS_CODE = 19
-- RELOAD | NO_CACHE_WRITE | NO_COOKIES | NO_UI: no WinINet cache file, no cookie jar, no dialog.
local URL_FLAGS = 0x80000000 + 0x04000000 + 0x00080000 + 0x00000200

local function query_text(lib, handle, level)
  local buf = ffi.new("char[256]")
  local len = ffi.new("unsigned long[1]", 256)
  if lib.HttpQueryInfoA(handle, level, buf, len, nil) == 0 then return nil end
  return ffi.string(buf, len[0])
end

local function is_windows()
  if M.deps.windows ~= nil then return M.deps.windows end
  local ok, w = pcall(function() return require("platform").is_windows() end)
  return ok and w == true
end

local function have_curl()
  if M.deps.have_curl ~= nil then return M.deps.have_curl end
  return require("host_tools").has("curl")
end

--- curl's exit codes that mean something to the user, worded so net.classify names the kind (dns / refused / timeout / tls).
local CURL_EXIT = {
  [5] = "could not resolve the proxy", [6] = "could not resolve host (dns)", [7] = "connection refused",
  [28] = "timed out", [35] = "ssl connect error (tls)", [51] = "ssl peer certificate not ok (tls)",
  [56] = "connection reset by peer", [58] = "ssl certificate problem (tls)", [60] = "ssl certificate not trusted (tls)",
  [77] = "ssl ca certificate file unreadable (tls)", [127] = "curl could not be started",
}

--- The text a failed request reports: names curl's exit code, so a shared log tells a firewall from a missing CA store.
local function curl_failure(code)
  if type(code) ~= "number" then return "request failed (curl gave no exit code)" end
  return "request failed (curl exit " .. code .. (CURL_EXIT[code] and (": " .. CURL_EXIT[code]) or "") .. ")"
end

local function read_file(path)
  if M.deps.read then return M.deps.read(path) end
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  return data
end

--- A value inside a curl config's double quotes ("\" and the quote escaped); nil when it holds a line break.
local function cfg_quote(s)
  s = tostring(s)
  if s:find("[\r\n%z]") then return nil end
  return '"' .. s:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end

--- GET through curl (non-Windows). Same result shape as the WinINet path.
local function get_curl(url, opts)
  if not have_curl() then
    local sandbox = require("host_tools").flatpak() and " This Steam runs in Flatpak: curl may be missing inside its sandbox." or ""
    return nil, "not supported on this OS (no curl on PATH; WinINet is Windows-only)." .. sandbox
  end
  local limit = opts.max_bytes or M.MAX_BYTES
  local q_url = cfg_quote(url)
  local q_agent = cfg_quote(opts.user_agent or "steam-cartridges/1.0")
  if not q_url or not q_agent then return nil, "request failed" end
  local tmpname = M.deps.tmpname or os.tmpname
  local remove = M.deps.remove or os.remove
  local body_path, meta_path = tmpname(), tmpname()
  -- The paths go into a shell command: only a plain temp path is accepted.
  local function plain(p) return type(p) == "string" and p:match("^[%w%._/%-]+$") ~= nil end
  if not plain(body_path) or not plain(meta_path) then
    if plain(body_path) then remove(body_path) end
    if plain(meta_path) then remove(meta_path) end
    return nil, "request failed"
  end
  local secs = math.ceil(M.TIMEOUT_MS / 1000)
  local cmd = string.format(
    "curl -s -L --max-redirs 5 --connect-timeout %d --max-time %d --max-filesize %d -K - -o '%s' -w '%%{http_code}\\t%%{content_type}' > '%s' 2>/dev/null",
    secs, secs * 2, limit, body_path, meta_path)
  local h = (M.deps.popen or io.popen)(cmd, "w")
  if not h then remove(body_path) remove(meta_path) return nil, "open failed" end
  h:write("url = " .. q_url .. "\nuser-agent = " .. q_agent .. "\n")
  local ok_close, _, code = h:close()
  local body, meta = read_file(body_path), read_file(meta_path)
  remove(body_path)
  remove(meta_path)
  if code == 63 then return nil, "too large" end -- curl: maximum file size exceeded
  if ok_close == nil or ok_close == false or (code ~= nil and code ~= 0) then return nil, curl_failure(code) end
  local status, ctype = tostring(meta or ""):match("^(%d+)\t?(.*)$")
  status = tonumber(status or "") or 0
  if status == 0 or not body then return nil, "request failed (curl answered without a body or status)" end
  if #body > limit then return nil, "too large" end
  return { status = status, body = body, content_type = (ctype ~= "" and ctype) or nil }
end

--- GET `url`. Returns { status = n, body = bytes, content_type = s|nil }, or nil and an error string.
---@param url string
---@param opts? { user_agent?: string, max_bytes?: number }
function M.get(url, opts)
  opts = opts or {}
  if not is_windows() then return get_curl(url, opts) end
  local lib = load()
  -- WinINet is Windows-only: a Windows box where it will not load answers plainly instead of throwing.
  if not lib then return nil, "not supported on this OS (WinINet did not load)" end
  local session = lib.InternetOpenA(opts.user_agent or "steam-cartridges/1.0", OPEN_PRECONFIG, nil, nil, 0)
  if session == nil then return nil, "open failed" end
  local timeout = ffi.new("unsigned long[1]", M.TIMEOUT_MS)
  lib.InternetSetOptionA(session, OPTION_CONNECT_TIMEOUT, timeout, 4)
  lib.InternetSetOptionA(session, OPTION_RECEIVE_TIMEOUT, timeout, 4)
  local request = lib.InternetOpenUrlA(session, url, nil, 0, URL_FLAGS, 0)
  if request == nil then
    lib.InternetCloseHandle(session)
    return nil, "request failed"
  end
  local status = tonumber(query_text(lib, request, QUERY_STATUS_CODE) or "") or 0
  local content_type = query_text(lib, request, QUERY_CONTENT_TYPE)
  local limit = opts.max_bytes or M.MAX_BYTES
  local parts, total = {}, 0
  local buf = ffi.new("uint8_t[65536]")
  local n = ffi.new("unsigned long[1]")
  local too_big = false
  while lib.InternetReadFile(request, buf, 65536, n) ~= 0 and n[0] > 0 do
    total = total + n[0]
    if total > limit then too_big = true break end
    parts[#parts + 1] = ffi.string(buf, n[0])
  end
  lib.InternetCloseHandle(request)
  lib.InternetCloseHandle(session)
  if too_big then return nil, "too large" end
  return { status = status, body = table.concat(parts), content_type = content_type }
end

return M
