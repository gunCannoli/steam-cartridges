--- Where the plugin keeps its keys and passwords safe at rest (ADR-0099).
---
--- A saved key is not written to the `.env` as text: it is written as a token, `enc:dpapi:<base64>` (Windows: the blob Windows' own DPAPI made for the
--- signed-in user, so another account, or the same file on another PC, cannot open it) or `enc:secret-tool:<name>` (Linux: the secret lives in the
--- desktop's keyring through `secret-tool`, the `.env` only names it). Where neither exists the value stays plain text and the log says so.
---
--- No process is started on Windows (the FFI calls crypt32 directly), so nothing is written to a temp file and no window flashes. On Linux the secret
--- goes to `secret-tool` on its standard input, never on a command line.
---
--- An adapter: it knows the operating system's stores, never the plugin's settings or network (the architecture test).

local M = {}

--- Injectable for tests. nil = the real thing.
M.deps = {
  windows = nil,     -- boolean ; nil = platform.is_windows()
  dpapi = nil,       -- { protect = fun(plain) -> blob | nil, err, reveal = fun(blob) -> plain | nil, err } ; nil = crypt32 through the FFI
  popen = nil,       -- fun(cmd, mode) -> handle ; nil = io.popen
  have_secret_tool = nil, -- boolean ; nil = look for `secret-tool`
}

-- ------------------------------------------------------------------------------------------------ base64 (the blob is stored as text)

local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function M.b64encode(s)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local c1, c2 = math.floor(n / 262144) % 64, math.floor(n / 4096) % 64
    local c3, c4 = math.floor(n / 64) % 64, n % 64
    out[#out + 1] = ALPHABET:sub(c1 + 1, c1 + 1) .. ALPHABET:sub(c2 + 1, c2 + 1)
      .. (b and ALPHABET:sub(c3 + 1, c3 + 1) or "=") .. (c and ALPHABET:sub(c4 + 1, c4 + 1) or "=")
  end
  return table.concat(out)
end

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
    pcall(ffi.cdef, "int CryptProtectData(SC_DATA_BLOB*, const void*, SC_DATA_BLOB*, void*, void*, unsigned long, SC_DATA_BLOB*);")
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
    protect = function(plain)
      return run(function(i, o) return crypt.CryptProtectData(i, nil, nil, nil, nil, UI_FORBIDDEN, o) end, plain)
    end,
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

--- "dpapi" (Windows), "secret-tool" (Linux with the keyring tool) or "none".
function M.store()
  if is_windows() then return dpapi() and "dpapi" or "none" end
  return have_secret_tool() and "secret-tool" or "none"
end

function M.is_token(v)
  return type(v) == "string" and v:sub(1, 4) == "enc:"
end

--- The token to write to the `.env` for `plain`, or nil (and why) when no store could take it: the caller then keeps the plain value.
---@param name string the setting's name (a `[%w_]+` word)
---@param plain string
---@return string|nil token
---@return string|nil err
function M.protect(name, plain)
  if type(plain) ~= "string" or plain == "" then return nil, "nothing to protect" end
  local kind = M.store()
  if kind == "dpapi" then
    local blob, err = dpapi().protect(plain)
    if not blob then return nil, err end
    return "enc:dpapi:" .. M.b64encode(blob)
  elseif kind == "secret-tool" then
    if not safe_name(name) then return nil, "unsafe name" end
    local h = popen('secret-tool store --label="Steam Cartridges ' .. name .. '" service steam-cartridges key ' .. name, "w")
    if not h then return nil, "secret-tool did not start" end
    h:write(plain)
    local ok, _, code = h:close()
    if ok == nil or ok == false or (code ~= nil and code ~= 0) then return nil, "secret-tool refused the secret" end
    return "enc:secret-tool:" .. name
  end
  return nil, "no secure store on this system"
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
