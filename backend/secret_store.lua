--- Opens the protected tokens an earlier version wrote to the `.env` (ADR-0099), so they can be turned back into plain text (ADR-0103). Read only:
--- nothing is protected any more, because the plugin's keys stay on this machine and a locked desktop keyring made Steam ask for a password at every start.
---
--- A token is `enc:dpapi:<base64>` (Windows: a blob Windows' DPAPI made for the signed-in user) or `enc:secret-tool:<name>` (Linux: the secret lives in the
--- desktop's keyring and is read through `secret-tool`). This runs once per saved key, only while a token is still in the `.env`.
---
--- An adapter: it knows the operating system's stores, never the plugin's settings or network (the architecture test).

local M = {}

--- Injectable for tests. nil = the real thing.
M.deps = {
  windows = nil,     -- boolean ; nil = platform.is_windows()
  dpapi = nil,       -- { reveal = fun(blob) -> plain | nil, err } ; nil = crypt32 through the FFI
  popen = nil,       -- fun(cmd, mode) -> handle ; nil = io.popen
  have_secret_tool = nil, -- boolean ; nil = look for `secret-tool`
}

-- ------------------------------------------------------------------------------------------------ base64 (the blob was stored as text)

local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function M.b64decode(s)
  local index = {}
  for i = 1, #ALPHABET do index[ALPHABET:byte(i)] = i - 1 end
  s = s:gsub("[^%w%+/=]", "")
  local out = {}
  for i = 1, #s, 4 do
    local c1, c2, c3, c4 = s:byte(i, i + 3)
    local v1, v2 = index[c1], index[c2]
    if v1 == nil or v2 == nil then return nil end
    local v3, v4 = c3 and index[c3], c4 and index[c4]
    local n = v1 * 262144 + v2 * 4096 + (v3 or 0) * 64 + (v4 or 0)
    out[#out + 1] = string.char(math.floor(n / 65536) % 256)
    if v3 then out[#out + 1] = string.char(math.floor(n / 256) % 256) end
    if v4 then out[#out + 1] = string.char(n % 256) end
  end
  return table.concat(out)
end

-- ------------------------------------------------------------------------------------------------ Windows: DPAPI through the FFI

local real_dpapi = nil

local function load_dpapi()
  if real_dpapi ~= nil then return real_dpapi or nil end
  real_dpapi = false
  local ok_ffi, ffi = pcall(require, "ffi")
  if not ok_ffi then return nil end
  if not _G.__SC_DPAPI_CDEF then
    pcall(ffi.cdef, "typedef struct { unsigned long cbData; unsigned char* pbData; } SC_DATA_BLOB;")
    pcall(ffi.cdef, "int CryptUnprotectData(SC_DATA_BLOB*, void*, SC_DATA_BLOB*, void*, void*, unsigned long, SC_DATA_BLOB*);")
    pcall(ffi.cdef, "void* LocalFree(void*);")
    _G.__SC_DPAPI_CDEF = true
  end
  local ok_c, crypt = pcall(ffi.load, "crypt32")
  local ok_k, kernel = pcall(ffi.load, "kernel32")
  if not ok_c or not ok_k then return nil end
  local UI_FORBIDDEN = 1

  local function run(fn, input)
    local buf = ffi.new("unsigned char[?]", #input)
    ffi.copy(buf, input, #input)
    local inb = ffi.new("SC_DATA_BLOB")
    inb.cbData, inb.pbData = #input, buf
    local outb = ffi.new("SC_DATA_BLOB")
    if fn(inb, outb) == 0 then return nil, "the Windows call failed" end
    local s = ffi.string(outb.pbData, outb.cbData)
    kernel.LocalFree(outb.pbData)
    return s
  end

  real_dpapi = {
    reveal = function(blob)
      return run(function(i, o) return crypt.CryptUnprotectData(i, nil, nil, nil, nil, UI_FORBIDDEN, o) end, blob)
    end,
  }
  return real_dpapi
end

local function dpapi()
  return M.deps.dpapi or load_dpapi()
end

-- ------------------------------------------------------------------------------------------------ Linux: secret-tool

local function is_windows()
  if M.deps.windows ~= nil then return M.deps.windows end
  local ok, w = pcall(function() return require("platform").is_windows() end)
  return ok and w == true
end

local function popen(cmd, mode)
  return (M.deps.popen or io.popen)(cmd, mode)
end

local secret_tool_found = nil

local function have_secret_tool()
  if M.deps.have_secret_tool ~= nil then return M.deps.have_secret_tool end
  if secret_tool_found == nil then
    local ok, status = pcall(os.execute, "command -v secret-tool >/dev/null 2>&1")
    secret_tool_found = ok and (status == 0 or status == true)
  end
  return secret_tool_found
end

--- A name safe to put on a command line.
local function safe_name(name)
  return type(name) == "string" and name:match("^[%w_]+$") ~= nil
end

-- ------------------------------------------------------------------------------------------------ the API

function M.is_token(v)
  return type(v) == "string" and v:sub(1, 4) == "enc:"
end

--- The plain value behind a token, or nil (and why): another Windows user, another PC, a keyring without the entry.
---@param token string
---@return string|nil plain
---@return string|nil err
function M.reveal(token)
  local kind, rest = tostring(token):match("^enc:([%w%-]+):(.*)$")
  if kind == "dpapi" then
    if not is_windows() or not dpapi() then return nil, "this value was protected with Windows' DPAPI" end
    local blob = M.b64decode(rest)
    if not blob or blob == "" then return nil, "unreadable value" end
    return dpapi().reveal(blob)
  elseif kind == "secret-tool" then
    if not safe_name(rest) or not have_secret_tool() then return nil, "no secret-tool for this value" end
    local h = popen("secret-tool lookup service steam-cartridges key " .. rest, "r")
    if not h then return nil, "secret-tool did not start" end
    local out = h:read("*a")
    h:close()
    if not out or out == "" then return nil, "the keyring has no such entry" end
    return out
  end
  return nil, "unknown value format"
end

return M
