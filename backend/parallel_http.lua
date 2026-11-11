--- Parallel HTTP client using OS curl (guardrail 23, ADR-0086).
--- Fires multiple HTTP transfers concurrently in a single OS process via `curl -Z` (parallel transfer),
--- avoiding external daemons, background ports, or firewall alerts.
--- Falls back to sequential `net` calls if curl is unavailable.

local host_tools = require("host_tools")

local M = {}

M.deps = {
  have_curl = nil, -- fun() -> boolean
  popen = nil,     -- fun(cmd, mode) -> file*
  tmpname = nil,   -- fun() -> string
  remove = nil,    -- fun(path) -> boolean
  now = function() return os.time() end,
}

local function have_curl()
  if M.deps.have_curl ~= nil then return M.deps.have_curl end
  return host_tools.has("curl")
end

function M.is_available()
  return have_curl() == true
end

local function slashes(p)
  return (tostring(p):gsub("\\", "/"))
end

local function cfg_quote(s)
  s = tostring(s or "")
  if s:find("[\r\n%z]") then return nil end
  return '"' .. s:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end

local function safe_tmp(idx)
  local tmpname_fn = M.deps.tmpname or os.tmpname
  local p = slashes(tmpname_fn())
  return p .. "_" .. tostring(idx or "0")
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  return content
end

local function is_windows()
  local ok, w = pcall(function() return require("platform").is_windows() end)
  return ok and w == true
end

local k32 = nil
local function get_k32()
  if k32 ~= nil then return k32 end
  local ffi_ok, ffi = pcall(require, "ffi")
  if not ffi_ok or not ffi then k32 = false return false end
  if not _G.__WIN_PROC_LOADED then -- os-ok: begin
    ffi.cdef[[
      typedef struct { unsigned long nLength; void *lpSecurityDescriptor; int bInheritHandle; } WIN_SA;
      typedef struct {
        unsigned long cb; char *lpReserved; char *lpDesktop; char *lpTitle;
        unsigned long dwX; unsigned long dwY; unsigned long dwXSize; unsigned long dwYSize;
        unsigned long dwXCountChars; unsigned long dwYCountChars; unsigned long dwFillAttribute;
        unsigned long dwFlags; unsigned short wShowWindow; unsigned short cbReserved2;
        unsigned char *lpReserved2; void *hStdInput; void *hStdOutput; void *hStdError;
      } WIN_SI;
      typedef struct { void *hProcess; void *hThread; unsigned long dwProcessId; unsigned long dwThreadId; } WIN_PI;
      void* CreateFileA(const char*, unsigned long, unsigned long, WIN_SA*, unsigned long, unsigned long, void*);
      int CreateProcessA(const char*, char*, WIN_SA*, WIN_SA*, int, unsigned long, void*, const char*, WIN_SI*, WIN_PI*);
      unsigned long WaitForSingleObject(void*, unsigned long);
      int CloseHandle(void*);
    ]]
    _G.__WIN_PROC_LOADED = true
  end -- os-ok: end
  local ok, lib = pcall(ffi.load, "kernel32")
  k32 = (ok and lib) or false
  return k32
end

local function run_curl_hidden_windows(cmd_str, out_path)
  local lib = get_k32()
  if not lib then return false end
  local ffi = require("ffi")

  local sa = ffi.new("WIN_SA")
  sa.nLength = ffi.sizeof("WIN_SA")
  sa.bInheritHandle = 1

  local hOut = lib.CreateFileA(out_path, 0x40000000, 1, sa, 2, 0x80, nil)
  if hOut == nil or hOut == ffi.cast("void*", -1) then return false end

  local si = ffi.new("WIN_SI")
  si.cb = ffi.sizeof("WIN_SI")
  si.dwFlags = 0x00000101
  si.wShowWindow = 0
  si.hStdOutput = hOut
  si.hStdError = hOut

  local pi = ffi.new("WIN_PI")
  local cmd_buf = ffi.new("char[?]", #cmd_str + 1)
  ffi.copy(cmd_buf, cmd_str)

  local ok = lib.CreateProcessA(nil, cmd_buf, nil, nil, 1, 0x08000000, nil, nil, si, pi)
  if ok ~= 0 then
    lib.WaitForSingleObject(pi.hProcess, 30000)
    lib.CloseHandle(pi.hProcess)
    lib.CloseHandle(pi.hThread)
  end
  lib.CloseHandle(hOut)
  return ok ~= 0
end

--- Execute a list of HTTP requests in parallel using `curl -Z`.
---@param requests table[] Array of { id = string, url = string, method = "GET"|"POST", headers = table, user_agent = string, data = string }
---@param opts? { concurrency?: number, timeout?: number }
---@return table<string, { status: number, body: string|nil, error: string|nil }>
function M.execute(requests, opts)
  if type(requests) ~= "table" or #requests == 0 then return {} end
  opts = opts or {}
  local concurrency = math.max(1, math.min(opts.concurrency or 8, #requests, 16))
  local timeout = math.max(2, opts.timeout or 10)

  local remove_fn = M.deps.remove or os.remove
  local popen_fn = M.deps.popen or io.popen

  -- If curl is unavailable, fall back sequentially using net.lua
  if not have_curl() then
    local net = require("net")
    local results = {}
    net.with_consent(function()
      for _, req in ipairs(requests) do
        local res, err
        local nopts = {
          headers = req.headers,
          user_agent = req.user_agent,
          timeout = timeout,
          source = req.source or "parallel_http",
        }
        if req.method == "POST" then
          res, err = net.post(req.url, req.data or "", nopts)
        else
          res, err = net.get(req.url, nopts)
        end
        results[req.id] = {
          status = res and tonumber(res.status) or 0,
          body = res and res.body or nil,
          error = err or (res and tonumber(res.status) >= 400 and ("HTTP " .. tostring(res.status)) or nil),
        }
      end
    end)
    return results
  end

  local cfg_path = safe_tmp("cfg")
  local temp_files = { cfg_path }
  local req_outputs = {}

  local cfg_file = io.open(cfg_path, "w")
  if not cfg_file then
    -- Cannot create config file; fall back to sequential
    M.deps.have_curl = false
    local out = M.execute(requests, opts)
    M.deps.have_curl = nil
    return out
  end

  for i, req in ipairs(requests) do
    local out_path = safe_tmp("out_" .. i)
    temp_files[#temp_files + 1] = out_path
    req_outputs[req.id] = out_path

    if i > 1 then
      cfg_file:write("next\n")
    end

    local q_url = cfg_quote(req.url) or '""'
    local q_out = cfg_quote(out_path) or '""'
    cfg_file:write("url = " .. q_url .. "\n")
    cfg_file:write("output = " .. q_out .. "\n")
    cfg_file:write(string.format('write-out = "%%{http_code}\\t%s\\n"\n', tostring(req.id):gsub("[\t\r\n]", "_")))
    cfg_file:write("silent\n")
    cfg_file:write("show-error\n")

    if req.user_agent then
      local q_ua = cfg_quote(req.user_agent)
      if q_ua then cfg_file:write("user-agent = " .. q_ua .. "\n") end
    end

    if type(req.headers) == "table" then
      for k, v in pairs(req.headers) do
        local q_hdr = cfg_quote(tostring(k) .. ": " .. tostring(v))
        if q_hdr then cfg_file:write("header = " .. q_hdr .. "\n") end
      end
    end

    if req.method == "POST" then
      cfg_file:write("request = \"POST\"\n")
      if req.data and req.data ~= "" then
        local data_path = safe_tmp("data_" .. i)
        temp_files[#temp_files + 1] = data_path
        local df = io.open(data_path, "wb")
        if df then
          df:write(req.data)
          df:close()
          cfg_file:write("data-binary = \"@" .. data_path .. "\"\n")
        end
      end
    end
  end

  cfg_file:close()

  -- Run curl -Z
  local curl_bin = "curl"
  if is_windows() then -- os-ok: begin
    local root = (require("platform").getenv("SystemRoot") or "C:/Windows"):gsub("\\", "/")
    local cpath = root .. "/System32/curl.exe"
    local cf = io.open(cpath, "rb")
    if cf then cf:close() curl_bin = '"' .. cpath .. '"' end
  end -- os-ok: end

  local cmd = string.format(
    "%s -s -L --max-redirs 5 --connect-timeout %d --max-time %d -Z --parallel-immediate --parallel-max %d -K %s",
    curl_bin,
    math.ceil(timeout / 2),
    timeout,
    concurrency,
    cfg_quote(cfg_path)
  )

  local stdout_path = safe_tmp("stdout")
  temp_files[#temp_files + 1] = stdout_path

  local ran_hidden = false
  if is_windows() and not M.deps.popen then
    ran_hidden = run_curl_hidden_windows(cmd, stdout_path)
    if not ran_hidden then
      M.deps.have_curl = false
      local out = M.execute(requests, opts)
      M.deps.have_curl = nil
      for _, f in ipairs(temp_files) do pcall(remove_fn, f) end
      return out
    end
  end

  local statuses = {}
  if ran_hidden then
    local sf = io.open(stdout_path, "r")
    if sf then
      for line in sf:lines() do
        local code, id = line:match("^(%d+)\t?(.*)$")
        if code and id and id ~= "" then
          statuses[id] = tonumber(code) or 0
        end
      end
      sf:close()
    end
  else
    local h = popen_fn(cmd, "r")
    if h then
      for line in h:lines() do
        local code, id = line:match("^(%d+)\t?(.*)$")
        if code and id and id ~= "" then
          statuses[id] = tonumber(code) or 0
        end
      end
      h:close()
    end
  end

  local results = {}
  for _, req in ipairs(requests) do
    local out_path = req_outputs[req.id]
    local body = out_path and read_file(out_path) or nil
    local status = statuses[req.id] or 0
    local err = nil
    if status == 0 then
      err = "connection failed"
    elseif status >= 400 then
      err = "HTTP " .. status
    end
    results[req.id] = {
      status = status,
      body = body,
      error = err,
    }
  end

  -- Clean up all temp files
  for _, f in ipairs(temp_files) do
    pcall(remove_fn, f)
  end

  return results
end

return M
