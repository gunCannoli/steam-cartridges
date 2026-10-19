--- Silent process execution helper for Windows GUI environments.
--- Uses Win32 CreateProcessA with CREATE_NO_WINDOW (0x08000000) to ensure
--- NO black console / cmd window pops up on the screen during background tasks.

local ffi = require("ffi")

if not _G.__SILENT_EXEC_CDEF_LOADED then
  ffi.cdef[[
typedef struct _SECURITY_ATTRIBUTES {
  unsigned long  nLength;
  void* lpSecurityDescriptor;
  int   bInheritHandle;
} SECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;

typedef struct _STARTUPINFOA {
  unsigned long  cb;
  char* lpReserved;
  char* lpDesktop;
  char* lpTitle;
  unsigned long  dwX;
  unsigned long  dwY;
  unsigned long  dwXSize;
  unsigned long  dwYSize;
  unsigned long  dwXCountChars;
  unsigned long  dwYCountChars;
  unsigned long  dwFillAttribute;
  unsigned long  dwFlags;
  unsigned short wShowWindow;
  unsigned short cbReserved2;
  unsigned char* lpReserved2;
  void* hStdInput;
  void* hStdOutput;
  void* hStdError;
} STARTUPINFOA, *LPSTARTUPINFOA;

typedef struct _PROCESS_INFORMATION {
  void* hProcess;
  void* hThread;
  unsigned long  dwProcessId;
  unsigned long  dwThreadId;
} PROCESS_INFORMATION, *PPROCESS_INFORMATION, *LPPROCESS_INFORMATION;

int CreateProcessA(
  const char* lpApplicationName,
  char* lpCommandLine,
  LPSECURITY_ATTRIBUTES lpProcessAttributes,
  LPSECURITY_ATTRIBUTES lpThreadAttributes,
  int bInheritHandles,
  unsigned long dwCreationFlags,
  void* lpEnvironment,
  const char* lpCurrentDirectory,
  LPSTARTUPINFOA lpStartupInfo,
  LPPROCESS_INFORMATION lpProcessInformation
);

unsigned long WaitForSingleObject(void* hHandle, unsigned long dwMilliseconds);
int CloseHandle(void* hObject);
  ]]
  _G.__SILENT_EXEC_CDEF_LOADED = true
end

local M = {}

local kernel32 = nil
pcall(function()
  kernel32 = ffi.load("kernel32")
end)

local CREATE_NO_WINDOW = 0x08000000

--- Runs a command completely silently (no console window) and captures output into a temp file
---@param cmd string Command string (e.g. node "path/to/script.js" "arg")
---@return string|nil output Output text from stdout/stderr, or nil on failure
---@return string|nil error Error message if failed
function M.run(cmd)
  if not kernel32 then
    local pipe = io.popen(cmd)
    if not pipe then return nil, "failed to spawn" end
    local out = pipe:read("*a")
    pipe:close()
    return out
  end

  local temp_dir = os.getenv("TEMP") or os.getenv("TMP") or "."
  local outfile = temp_dir .. "\\ra_hash_" .. tostring(os.time()) .. "_" .. tostring(math.random(1000, 9999)) .. ".tmp"
  local full_cmd = string.format('cmd.exe /c %s > "%s" 2>&1', cmd, outfile)

  local si = ffi.new("STARTUPINFOA")
  si.cb = ffi.sizeof("STARTUPINFOA")
  local pi = ffi.new("PROCESS_INFORMATION")

  local cmd_buf = ffi.new("char[?]", #full_cmd + 1)
  ffi.copy(cmd_buf, full_cmd)

  local ok = 0
  local spawn_err = nil
  pcall(function()
    ok = kernel32.CreateProcessA(
      nil,
      cmd_buf,
      nil,
      nil,
      0,
      CREATE_NO_WINDOW,
      nil,
      nil,
      si,
      pi
    )
  end)

  if ok == 0 then
    -- Fallback to io.popen if CreateProcessA failed
    local pipe = io.popen(cmd)
    if not pipe then return nil, "failed to spawn" end
    local out = pipe:read("*a")
    pipe:close()
    return out
  end

  -- Wait up to 5 seconds
  kernel32.WaitForSingleObject(pi.hProcess, 5000)
  kernel32.CloseHandle(pi.hProcess)
  kernel32.CloseHandle(pi.hThread)

  local f = io.open(outfile, "r")
  if not f then
    return nil, "cannot read output file"
  end
  local output = f:read("*a")
  f:close()
  os.remove(outfile)

  return output
end

return M
