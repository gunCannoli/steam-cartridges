--- steam-cartridges - OS-agnostic read-only process memory reader for Achievement Packs.
---
--- Strictly read-only, out-of-process observation: never injects DLLs, never hooks, never writes to memory.
--- Windows: kernel32 via LuaJIT FFI (CreateToolhelp32Snapshot, OpenProcess(PROCESS_VM_READ|PROCESS_QUERY_LIMITED_INFORMATION),
---          ReadProcessMemory, IsWow64Process, GetExitCodeProcess, CloseHandle).
--- Linux:   /proc/<pid>/comm, /proc/<pid>/maps, and /proc/<pid>/mem (with EPERM/ptrace_scope logged clearly once).
---
--- Guardrail 23: no os.getenv, no io.popen, no Windows path spellings outside platform checks.

local logger   = require("logger")
local platform = require("platform")

local M = {}

--- Injectable for hermetic unit tests. nil = real OS implementation.
M.deps = {
  is_windows  = nil, -- fun() -> boolean
  find_pid    = nil, -- fun(proc_name) -> number | nil
  module_base = nil, -- fun(pid, mod_name) -> number|cdata | nil
  open        = nil, -- fun(pid) -> handle | nil, err
  read        = nil, -- fun(handle, addr, size) -> string | nil, err
  alive       = nil, -- fun(handle) -> boolean
  ptr_size    = nil, -- fun(handle) -> 4 | 8
  close       = nil, -- fun(handle) -> nil
}

local function is_win()
  if M.deps.is_windows then return M.deps.is_windows() end
  return platform.is_windows()
end

--- Parse a hex ("0x1A2B", "1A2B" if hex_only) or decimal integer into a non-negative number (or nil).
function M.parse_int(v)
  if type(v) == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return nil end
    return math.floor(v)
  end
  if type(v) ~= "string" then return nil end
  local s = v:match("^%s*(.-)%s*$")
  local neg = false
  if s:sub(1, 1) == "-" then neg = true s = s:sub(2):match("^%s*(.-)%s*$") end
  local hex = s:match("^0[xX](%x+)$")
  local n = hex and tonumber(hex, 16) or tonumber(s, 10)
  if not n then return nil end
  return neg and -math.floor(n) or math.floor(n)
end

--- Parse a base spec: "AM2R.exe+0x004A12C0" -> ("AM2R.exe", 0x004A12C0), or "0x004A12C0" -> (nil, 0x004A12C0).
function M.parse_base(spec)
  if type(spec) == "number" then return nil, math.floor(spec) end
  if type(spec) ~= "string" then return nil, nil end
  local s = spec:match("^%s*(.-)%s*$")
  local mod, off = s:match("^([^+]+)%+(.+)$")
  if mod and off then
    local n = M.parse_int(off)
    if n then return mod:match("^%s*(.-)%s*$"), n end
    return nil, nil
  end
  local n = M.parse_int(s)
  if n then return nil, n end
  return nil, nil
end

-- ------------------------------------------------------------------------------------------------ Windows (LuaJIT FFI)

local win_k32 = nil
local win_ffi = nil
local win_init_done = false

local function init_win()
  if win_init_done then return win_k32 ~= nil end
  win_init_done = true
  local ok_ffi, ffi = pcall(require, "ffi")
  if not ok_ffi or not ffi then return false end
  pcall(ffi.cdef, [[
    typedef void*          SC_HANDLE;
    typedef unsigned long  SC_DWORD;
    typedef int            SC_BOOL;
    typedef uintptr_t      SC_ULONG_PTR;
    typedef size_t         SC_SIZE_T;

    typedef struct {
      SC_DWORD     dwSize;
      SC_DWORD     cntUsage;
      SC_DWORD     th32ProcessID;
      SC_ULONG_PTR th32DefaultHeapID;
      SC_DWORD     th32ModuleID;
      SC_DWORD     cntThreads;
      SC_DWORD     th32ParentProcessID;
      long         pcPriClassBase;
      SC_DWORD     dwFlags;
      char         szExeFile[260];
    } SC_PROCESSENTRY32A;

    typedef struct {
      SC_DWORD     dwSize;
      SC_DWORD     th32ModuleID;
      SC_DWORD     th32ProcessID;
      SC_DWORD     GlblcntUsage;
      SC_DWORD     ProccntUsage;
      unsigned char* modBaseAddr;
      SC_DWORD     modBaseSize;
      SC_HANDLE    hModule;
      char         szModule[256];
      char         szExePath[260];
    } SC_MODULEENTRY32A;

    SC_HANDLE CreateToolhelp32Snapshot(SC_DWORD dwFlags, SC_DWORD th32ProcessID);
    SC_BOOL   Process32First(SC_HANDLE hSnapshot, SC_PROCESSENTRY32A* lppe);
    SC_BOOL   Process32Next(SC_HANDLE hSnapshot, SC_PROCESSENTRY32A* lppe);
    SC_BOOL   Module32First(SC_HANDLE hSnapshot, SC_MODULEENTRY32A* lpme);
    SC_BOOL   Module32Next(SC_HANDLE hSnapshot, SC_MODULEENTRY32A* lpme);
    SC_HANDLE OpenProcess(SC_DWORD dwDesiredAccess, SC_BOOL bInheritHandle, SC_DWORD dwProcessId);
    SC_BOOL   ReadProcessMemory(SC_HANDLE hProcess, const void* lpBaseAddress, void* lpBuffer, SC_SIZE_T nSize, SC_SIZE_T* lpNumberOfBytesRead);
    SC_BOOL   IsWow64Process(SC_HANDLE hProcess, SC_BOOL* Wow64Process);
    SC_BOOL   GetExitCodeProcess(SC_HANDLE hProcess, SC_DWORD* lpExitCode);
    SC_BOOL   CloseHandle(SC_HANDLE hObject);
  ]])
  local ok_k, k32 = pcall(ffi.load, "kernel32")
  if not ok_k or not k32 then return false end
  win_ffi = ffi
  win_k32 = k32
  return true
end

local TH32CS_SNAPPROCESS  = 0x00000002
local TH32CS_SNAPMODULE   = 0x00000008
local TH32CS_SNAPMODULE32 = 0x00000010
local PROCESS_VM_READ     = 0x0010
local PROCESS_QUERY_LIM   = 0x1000
local STILL_ACTIVE        = 259

local function win_invalid(h)
  return h == nil or h == win_ffi.cast("void*", -1)
end

local function win_find_pid(proc_name)
  if not init_win() then return nil end
  local target = tostring(proc_name or ""):gsub("\\", "/"):match("([^/]+)$")
  if not target or target == "" then return nil end
  target = target:lower()
  local snap = win_k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if win_invalid(snap) then return nil end
  local pe = win_ffi.new("SC_PROCESSENTRY32A")
  pe.dwSize = win_ffi.sizeof("SC_PROCESSENTRY32A")
  local pid = nil
  if win_k32.Process32First(snap, pe) ~= 0 then
    repeat
      local name = win_ffi.string(pe.szExeFile):lower()
      if name == target then
        pid = tonumber(pe.th32ProcessID)
        break
      end
    until win_k32.Process32Next(snap, pe) == 0
  end
  win_k32.CloseHandle(snap)
  return pid
end

local function win_module_base(pid, mod_name)
  if not init_win() then return nil end
  local target = tostring(mod_name or ""):gsub("\\", "/"):match("([^/]+)$")
  if not target or target == "" then return nil end
  target = target:lower()
  local snap = win_k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE + TH32CS_SNAPMODULE32, pid)
  if win_invalid(snap) then return nil end
  local me = win_ffi.new("SC_MODULEENTRY32A")
  me.dwSize = win_ffi.sizeof("SC_MODULEENTRY32A")
  local base = nil
  if win_k32.Module32First(snap, me) ~= 0 then
    repeat
      local name = win_ffi.string(me.szModule):lower()
      if name == target then
        base = win_ffi.cast("uint64_t", win_ffi.cast("uintptr_t", me.modBaseAddr))
        break
      end
    until win_k32.Module32Next(snap, me) == 0
  end
  win_k32.CloseHandle(snap)
  return base
end

local function win_open(pid)
  if not init_win() then return nil, "ffi unavailable" end
  local h = win_k32.OpenProcess(PROCESS_VM_READ + PROCESS_QUERY_LIM, 0, pid)
  if win_invalid(h) then return nil, "OpenProcess failed" end
  local wow = win_ffi.new("SC_BOOL[1]")
  local psize = win_ffi.sizeof("void*")
  if psize == 8 and win_k32.IsWow64Process(h, wow) ~= 0 and wow[0] ~= 0 then
    psize = 4
  end
  return { kind = "win", pid = pid, handle = h, ptr_size = psize, mods = {} }
end

local function win_read(h, addr, size)
  if not h or not h.handle or size <= 0 or size > 65536 then return nil, "bad read" end
  local buf = win_ffi.new("uint8_t[?]", size)
  local nread = win_ffi.new("SC_SIZE_T[1]")
  local ptr = win_ffi.cast("const void*", win_ffi.cast("uintptr_t", addr))
  local ok = win_k32.ReadProcessMemory(h.handle, ptr, buf, size, nread)
  if ok == 0 or tonumber(nread[0]) < size then return nil, "ReadProcessMemory failed" end
  return win_ffi.string(buf, size)
end

local function win_alive(h)
  if not h or not h.handle then return false end
  local code = win_ffi.new("SC_DWORD[1]")
  if win_k32.GetExitCodeProcess(h.handle, code) == 0 then return false end
  return tonumber(code[0]) == STILL_ACTIVE
end

local function win_close(h)
  if h and h.handle then
    win_k32.CloseHandle(h.handle)
    h.handle = nil
  end
end

-- ------------------------------------------------------------------------------------------------ Linux (/proc)

local linux_perm_logged = false

local function linux_find_pid(proc_name)
  local target = tostring(proc_name or ""):gsub("\\", "/"):match("([^/]+)$")
  if not target or target == "" then return nil end
  target = target:lower()
  local ok_fs, fs = pcall(require, "fs")
  if not (ok_fs and fs and fs.list) then return nil end
  local ok, entries = pcall(fs.list, "/proc")
  if not ok or type(entries) ~= "table" then return nil end
  for _, e in ipairs(entries) do
    local name = tostring(type(e) == "table" and (e.name or e.path) or e):match("([^/]+)$") or ""
    if name:match("^%d+$") then
      local f = io.open("/proc/" .. name .. "/comm", "rb")
      if f then
        local comm = (f:read("*a") or ""):gsub("[\r\n]+$", ""):lower()
        f:close()
        if comm == target or comm == target:sub(1, 15) then
          return tonumber(name)
        end
      end
    end
  end
  return nil
end

local function linux_module_base(pid, mod_name)
  local target = tostring(mod_name or ""):gsub("\\", "/"):match("([^/]+)$")
  if not target or target == "" then return nil end
  target = target:lower()
  local f = io.open("/proc/" .. tostring(pid) .. "/maps", "rb")
  if not f then return nil end
  local ok_ffi, ffi = pcall(require, "ffi")
  local base = nil
  for line in f:lines() do
    local hex_start, path = line:match("^(%x+)%-%x+%s+%S+%s+%x+%s+%S+%s+%d+%s+(.+)$")
    if hex_start and path then
      local file = path:gsub("\\", "/"):match("([^/]+)$")
      if file and file:lower() == target then
        if ok_ffi and ffi then
          -- parse 64-bit hex without double precision loss
          local hi, lo = hex_start:sub(1, math.max(0, #hex_start - 8)), hex_start:sub(math.max(1, #hex_start - 7))
          local v = ffi.cast("uint64_t", tonumber(lo, 16) or 0)
          if #hi > 0 then v = v + ffi.cast("uint64_t", tonumber(hi, 16) or 0) * ffi.cast("uint64_t", 4294967296ULL) end
          base = v
        else
          base = tonumber(hex_start, 16)
        end
        break
      end
    end
  end
  f:close()
  return base
end

local function linux_open(pid)
  local f, err = io.open("/proc/" .. tostring(pid) .. "/mem", "rb")
  if not f then
    if not linux_perm_logged then
      linux_perm_logged = true
      logger:warn("[watch] memory read unavailable for pid " .. tostring(pid) .. " (ptrace_scope?): " .. tostring(err))
    end
    return nil, tostring(err)
  end
  local ok_ffi, ffi = pcall(require, "ffi")
  local psize = (ok_ffi and ffi) and ffi.sizeof("void*") or 8
  return { kind = "linux", pid = pid, file = f, ptr_size = psize, mods = {} }
end

local function linux_read(h, addr, size)
  if not h or not h.file or size <= 0 or size > 65536 then return nil, "bad read" end
  local off = tonumber(addr)
  if not off then return nil, "bad addr" end
  local ok, err = h.file:seek("set", off)
  if not ok then return nil, tostring(err) end
  local data = h.file:read(size)
  if not data or #data < size then return nil, "short read" end
  return data
end

local function linux_alive(h)
  if not h or not h.pid then return false end
  local f = io.open("/proc/" .. tostring(h.pid) .. "/stat", "rb")
  if not f then return false end
  f:close()
  return true
end

local function linux_close(h)
  if h and h.file then
    h.file:close()
    h.file = nil
  end
end

-- ------------------------------------------------------------------------------------------------ public API

function M.find_pid(proc_name)
  if M.deps.find_pid then return M.deps.find_pid(proc_name) end
  return is_win() and win_find_pid(proc_name) or linux_find_pid(proc_name)
end

function M.module_base(pid, mod_name)
  if M.deps.module_base then return M.deps.module_base(pid, mod_name) end
  return is_win() and win_module_base(pid, mod_name) or linux_module_base(pid, mod_name)
end

function M.open(pid)
  if M.deps.open then return M.deps.open(pid) end
  return is_win() and win_open(pid) or linux_open(pid)
end

function M.read(handle, addr, size)
  if M.deps.read then return M.deps.read(handle, addr, size) end
  if not handle then return nil, "no handle" end
  return handle.kind == "win" and win_read(handle, addr, size) or linux_read(handle, addr, size)
end

function M.alive(handle)
  if M.deps.alive then return M.deps.alive(handle) end
  if not handle then return false end
  return handle.kind == "win" and win_alive(handle) or linux_alive(handle)
end

function M.ptr_size(handle)
  if M.deps.ptr_size then return M.deps.ptr_size(handle) end
  return (handle and handle.ptr_size) or 8
end

function M.close(handle)
  if M.deps.close then return M.deps.close(handle) end
  if not handle then return end
  if handle.kind == "win" then win_close(handle) else linux_close(handle) end
end

--- Add an integer offset to a base address (works for both Lua numbers and uint64_t cdata).
local function add_addr(base, off)
  if type(base) == "number" then return base + off end
  if off >= 0 then return base + off end
  return base - (-off)
end

--- Decode a 4-byte or 8-byte little-endian unsigned pointer from raw bytes.
local function decode_ptr(bytes, psize)
  if not bytes or #bytes < psize then return nil end
  local b1, b2, b3, b4 = bytes:byte(1, 4)
  local lo = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
  if psize == 4 then return lo end
  local b5, b6, b7, b8 = bytes:byte(5, 8)
  local hi = b5 + b6 * 256 + b7 * 65536 + b8 * 16777216
  local ok_ffi, ffi = pcall(require, "ffi")
  if ok_ffi and ffi then
    return ffi.cast("uint64_t", lo) + ffi.cast("uint64_t", hi) * ffi.cast("uint64_t", 4294967296ULL)
  end
  return lo + hi * 4294967296
end

--- Resolve a variable's effective address (base/addr + optional pointer chain).
--- `spec`: { base? = "Mod.exe+0x1234", addr? = "0x1234", offsets? = { "0x10", "0x24" }, ptr_size? = 4|8 }
function M.resolve_address(handle, spec)
  if not handle or type(spec) ~= "table" then return nil, "bad spec" end
  local mod, off = M.parse_base(spec.base ~= nil and spec.base or spec.addr)
  if off == nil then return nil, "invalid base/addr" end

  local addr
  if mod then
    handle.mods = handle.mods or {}
    local key = mod:lower()
    local base = handle.mods[key]
    if base == nil then
      base = M.module_base(handle.pid, mod)
      if base == nil then return nil, "module not found: " .. mod end
      handle.mods[key] = base
    end
    addr = add_addr(base, off)
  else
    addr = off
  end

  local offsets = spec.offsets
  if type(offsets) == "table" and #offsets > 0 then
    local psize = spec.ptr_size or M.ptr_size(handle)
    for _, raw_off in ipairs(offsets) do
      local o = M.parse_int(raw_off)
      if o == nil then return nil, "invalid offset" end
      local raw_ptr, err = M.read(handle, addr, psize)
      if not raw_ptr then return nil, err or "pointer read failed" end
      local next_ptr = decode_ptr(raw_ptr, psize)
      if not next_ptr or next_ptr == 0 then return nil, "null pointer" end
      addr = add_addr(next_ptr, o)
    end
  end

  return addr
end

return M
