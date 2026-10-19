--- Binary HTTP GET into memory (features plan F2b), for images whose bytes the backend must fetch itself.
---
--- Millennium's Lua `http.get` returns the body as a C string, so a binary body is cut at its first NUL
--- byte (icon plan § 11); the frontend cannot fetch ScreenScraper either (no CORS, verified live
--- 2026-09-30). This module calls WinINet through LuaJIT's FFI (the same FFI `silent_exec.lua` uses for
--- kernel32): the body stays in memory, nothing is written to disk and no process is spawned, so the
--- URL (which carries the ScreenScraper account) never reaches a command line, a file or a log.
---
--- Callers use `net.get_binary` (the circuit breakers), never this module directly.

local M = {}

M.MAX_BYTES = 8 * 1024 * 1024
M.TIMEOUT_MS = 15000

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

--- GET `url`. Returns { status = n, body = bytes, content_type = s|nil }, or nil and an error string.
---@param url string
---@param opts? { user_agent?: string, max_bytes?: number }
function M.get(url, opts)
  local lib = load()
  if not lib then return nil, "unavailable" end
  opts = opts or {}
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
