--- What the host offers the backend: which command-line tools exist, whether Steam runs in Flatpak or on a Steam Deck, and the
--- one file-permission call. An exec helper (guardrail 23, plugins.md): `os.execute` lives here and in secret_store / bin_http only.
---
--- Nothing here is needed to run; every answer is a sensor for the log (`[host]` line at start-up) or a best-effort hardening
--- step, so a missing tool is a line the user can send, never an error. Windows answers "no" to every tool: its code paths do not use them.

local M = {}

M.deps = {
  windows = nil,  -- boolean ; nil = platform.is_windows()
  run = nil,      -- fun(cmd) -> boolean ; nil = os.execute exits 0
  exists = nil,   -- fun(path) -> boolean ; nil = io.open
  getenv = nil,   -- fun(name) -> string | nil ; nil = platform.getenv
  read = nil,     -- fun(path) -> text | nil ; nil = io.open + read
  load_lib = nil, -- fun(name) -> boolean ; nil = pcall(ffi.load, name)
  win_info = nil, -- fun() -> { version = "10.0.26200", ram_gb = 16 } ; nil = ntdll / kernel32 through the FFI
  jit = nil,      -- { os, arch, version } ; nil = the running LuaJIT
}

local function is_windows()
  if M.deps.windows ~= nil then return M.deps.windows end
  local ok, w = pcall(function() return require("platform").is_windows() end)
  return ok and w == true
end

local function run(cmd)
  if M.deps.run then return M.deps.run(cmd) end
  local ok, status = pcall(os.execute, cmd)
  return ok and (status == 0 or status == true)
end

local function exists(path)
  if M.deps.exists then return M.deps.exists(path) end
  local f = io.open(path, "rb")
  if f then f:close() return true end
  return false
end

local function env(name)
  if M.deps.getenv then return M.deps.getenv(name) end
  local ok, v = pcall(function() return require("platform").getenv(name) end)
  return ok and v or nil
end

local function read(path)
  if M.deps.read then return M.deps.read(path) end
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

local tools = {}

--- Whether `name` is a command on this host's PATH (cached). Only a plain tool name is ever put in the shell.
---@param name string
---@return boolean
function M.has(name)
  if is_windows() or type(name) ~= "string" or not name:match("^[%w_%-]+$") then return false end
  if tools[name] == nil then tools[name] = run("command -v " .. name .. " >/dev/null 2>&1") and true or false end
  return tools[name]
end

local libs = {}

--- Whether a shared library loads through the FFI (the sensor for a future libcurl route). Non-Windows only.
---@param candidates string[]
---@return string|nil which the first name that loaded
function M.lib(candidates)
  if is_windows() then return nil end
  for _, name in ipairs(candidates) do
    if libs[name] == nil then
      if M.deps.load_lib then
        libs[name] = M.deps.load_lib(name) and true or false
      else
        local ok_ffi, ffi = pcall(require, "ffi")
        libs[name] = ok_ffi and select(1, pcall(ffi.load, name)) and true or false
      end
    end
    if libs[name] then return name end
  end
  return nil
end

--- True when Steam runs inside a Flatpak sandbox: the `/.flatpak-info` file Flatpak puts in every app, or `FLATPAK_ID`.
function M.flatpak()
  if is_windows() then return false end
  return exists("/.flatpak-info") or (env("FLATPAK_ID") or "") ~= ""
end

--- The distro's own name from /etc/os-release (PRETTY_NAME), at most 40 characters; nil when unreadable.
function M.distro()
  local text = not is_windows() and read("/etc/os-release") or nil
  local name = text and text:match('PRETTY_NAME="?([^"\r\n]+)') or nil
  return name and name:sub(1, 40) or nil
end

--- Windows' own version and installed memory through the FFI (ntdll RtlGetVersion, kernel32 GlobalMemoryStatusEx). Best effort: {}.
local function windows_info()
  if M.deps.win_info then return M.deps.win_info() or {} end
  local ok, out = pcall(function()
    local ffi = require("ffi")
    ffi.cdef([[
      typedef struct { unsigned long size, major, minor, build, platform; unsigned short csd[128]; } sc_osver;
      long RtlGetVersion(sc_osver* info);
      typedef struct { unsigned long length, load; unsigned long long total, avail, ptotal, pavail, vtotal, vavail, vext; } sc_memstat;
      int GlobalMemoryStatusEx(sc_memstat* buf);
    ]])
    local info = {}
    local v = ffi.new("sc_osver")
    v.size = ffi.sizeof("sc_osver")
    if ffi.load("ntdll").RtlGetVersion(v) == 0 then info.version = string.format("%d.%d.%d", v.major, v.minor, v.build) end
    local m = ffi.new("sc_memstat")
    m.length = ffi.sizeof("sc_memstat")
    if ffi.load("kernel32").GlobalMemoryStatusEx(m) ~= 0 then info.ram_gb = math.floor(tonumber(m.total) / 1073741824 + 0.5) end
    return info
  end)
  return ok and type(out) == "table" and out or {}
end

local function clean(v, max)
  return (tostring(v or "unknown"):gsub(" ", "_"):gsub("[^%w%._%+%-]", ""):sub(1, max or 40))
end

--- One log line about the machine for a report, so a bug can be tied to an OS build, a CPU count or a memory size: the OS and its
--- version, CPU architecture and count, installed memory (GB), the language code, the LuaJIT build. Nothing that names the user or the
--- PC: no host name, no user name, no path, no serial.
function M.system()
  local j = M.deps.jit or (rawget(_G, "jit") or {})
  local os_name, version, cpus, ram, lang
  if is_windows() then
    local info = windows_info()
    os_name, version, ram = "windows", info.version, info.ram_gb
    cpus = tonumber(env("NUMBER_OF_PROCESSORS") or "")
  else
    os_name = "linux"
    version = (read("/proc/sys/kernel/osrelease") or ""):match("^[^\r\n]+")
    local mem = (read("/proc/meminfo") or ""):match("MemTotal:%s*(%d+)")
    ram = mem and math.floor(tonumber(mem) / 1048576 + 0.5) or nil
    local n = 0
    for _ in (read("/proc/cpuinfo") or ""):gmatch("\nprocessor%s*:") do n = n + 1 end
    if (read("/proc/cpuinfo") or ""):match("^processor%s*:") then n = n + 1 end
    cpus = n > 0 and n or nil
    lang = (env("LANG") or ""):match("^([%a_]+)")
  end
  return string.format("system: os=%s %s; arch=%s; cpus=%s; ram_gb=%s; lang=%s; lua=%s",
    os_name, clean(version), clean(j.arch), cpus or "unknown", ram or "unknown", clean(lang), clean(j.version))
end

--- One log line: what this host is and which helper tools it has. No path, no user name.
function M.report()
  if is_windows() then return "os=windows" end
  local function yn(v) return v and "yes" or "no" end
  local parts = {
    "os=linux",
    "distro=" .. (M.distro() or "unknown"),
    "flatpak=" .. yn(M.flatpak()),
    "steamdeck=" .. yn((env("SteamDeck") or "") == "1"),
    "desktop=" .. ((env("XDG_CURRENT_DESKTOP") or "unknown"):sub(1, 24)),
    "session=" .. ((env("XDG_SESSION_TYPE") or "unknown"):sub(1, 12)),
    "curl=" .. yn(M.has("curl")),
    "wget=" .. yn(M.has("wget")),
    "secret-tool=" .. yn(M.has("secret-tool")),
    "flatpak-spawn=" .. yn(M.has("flatpak-spawn")),
    "libcurl=" .. (M.lib({ "libcurl.so.4", "libcurl.so", "curl" }) and "yes" or "no"),
  }
  return table.concat(parts, "; ")
end

--- Makes a file readable by its owner only (chmod 600) where the OS has file modes. A plain-text key file must not be world readable.
--- Best effort: returns true, or false and why. Windows has no modes here (the data folder is already per user).
---@param path string
---@return boolean ok
---@return string|nil err
function M.private_file(path)
  if is_windows() then return true end
  if type(path) ~= "string" or path == "" or path:find("['\r\n%z]") then return false, "unsafe path" end
  if run("chmod 600 '" .. path .. "' 2>/dev/null") then return true end
  return false, "chmod failed"
end

--- Forget cached answers (tests, or a tool installed while Steam runs).
function M._reset() tools, libs = {}, {} end

return M
