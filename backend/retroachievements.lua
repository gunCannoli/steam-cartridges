--- steam-cartridges - RetroAchievements provider (Phase 5).
---
--- Integrates RetroAchievements for retro games launched through RetroArch, DuckStation, PCSX2, Dolphin, PPSSPP, etc.
--- Key features:
---   1. Auto-discovers credentials from local emulator configs (RetroArch, DuckStation, PCSX2, Dolphin, PPSSPP) keylessly.
---   2. Hashes ROM/disc files (rom_hash.lua) to discover canonical RetroAchievements GameID.
---   3. Fallback console detection and title matching for compressed disc formats (.chd) and arcade romsets.
---   4. Queries dorequest.php for official achievement schemas (titles, descriptions, points, badge URLs)
---      and user unlock history.
---   5. Caches schemas and unlocks in achievements.json so they render in Steam's native UI sinks.

local json        = require("json")
local utils       = require("utils")
local net         = require("net")
local logger      = require("logger")
local data_dir    = require("data_dir")
local steam_paths = require("steam_paths")
local shortcuts   = require("shortcuts")
local store       = require("achievements_store")
local bit         = require("bit")

local M = {}


--- Builds a candidate list, skipping nil/false entries (a nil inside a table literal would end ipairs early).
local function present(...)
  local out = {}
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    if v then out[#out + 1] = v end
  end
  return out
end

local EMULATORS = { "retroarch", "duckstation", "pcsx2", "dolphin", "primehack", "ppsspp", "rpcs3", "shadps4" }
local _emu_dirs, _emu_dirs_at = nil, 0

--- Emulator install folders found from the user's shortcuts (the folder of the first exe naming each emulator).
--- No machine-specific defaults: an emulator no shortcut runs is found only in its %APPDATA% / Documents defaults.
--- Cached for 60 s: credentials are read once per game page.
function M.emulator_dirs()
  if _emu_dirs and os.time() - _emu_dirs_at < 60 then return _emu_dirs end
  local dirs = {}
  local p_ok, p_paths = pcall(steam_paths.resolve)
  if p_ok and p_paths and p_paths.shortcuts then
    local s_ok, s_list = pcall(shortcuts.parse, p_paths.shortcuts)
    if s_ok and type(s_list) == "table" then
      for _, sc in ipairs(s_list) do
        if type(sc.exe) == "string" then
          -- Steam's exe field can hold a whole command line ("...\retroarch.exe" -L core rom): keep the program only.
          local prog = sc.exe:match('^%s*"([^"]+)"') or sc.exe:match("^%s*(.-%.[eE][xX][eE])") or sc.exe
          local es = prog:gsub("\\", "/")
          local ed = es:match("^(.*)/[^/]+$")
          if ed and #ed > 0 then
            local low = es:lower()
            for _, name in ipairs(EMULATORS) do
              if not dirs[name] and low:find(name, 1, true) then dirs[name] = ed end
            end
          end
        end
      end
    end
  end
  _emu_dirs, _emu_dirs_at = dirs, os.time()
  return dirs
end

local function count_keys(tbl)
  local c = 0
  for _ in pairs(tbl or {}) do c = c + 1 end
  return c
end

local function file_exists(p)
  if not p or #p == 0 then return false end
  local f = io.open(p, "rb")
  if f then
    f:close()
    return true
  end
  return false
end

--- Parses standard INI text into a 2D map: data[section_name][key_name] = value
function M.parse_ini(text)
  local data = {}
  local current_section = ""
  for line in (text or ""):gmatch("[^\r\n]+") do
    line = line:gsub("^%s+", ""):gsub("%s+$", "")
    if line:sub(1, 1) == "[" and line:sub(-1) == "]" then
      current_section = line:sub(2, -2):lower()
      data[current_section] = data[current_section] or {}
    elseif #current_section > 0 then
      local k, v = line:match("^([^=]+)=(.*)$")
      if k and v then
        k = k:gsub("^%s+", ""):gsub("%s+$", ""):lower()
        v = v:gsub("^%s+", ""):gsub("%s+$", "")
        if v:sub(1, 1) == '"' and v:sub(-1) == '"' then
          v = v:sub(2, -2)
        end
        data[current_section][k] = v
      end
    end
  end
  return data
end

--- Decrypts RetroArch 1.19+ credentials from retroarch-keychain.cfg and retroarch-keychain.key
--- using Windows CNG (bcrypt.dll) and advapi32.dll (RFC 5869 HKDF-SHA256 + ChaCha20-Poly1305).
local _keychain_ffi_ready = false
local _advapi = nil
local _bcrypt = nil
local _ffi = nil

local function init_keychain_ffi()
  if _keychain_ffi_ready then return true end
  if _G.__RA_KEYCHAIN_FFI_INITIALIZED then
    _advapi = _G.__RA_KEYCHAIN_ADVAPI
    _bcrypt = _G.__RA_KEYCHAIN_BCRYPT
    _ffi = _G.__RA_KEYCHAIN_FFI
    _keychain_ffi_ready = (_advapi ~= nil and _bcrypt ~= nil and _ffi ~= nil)
    return _keychain_ffi_ready
  end

  local ok, ffi = pcall(require, "ffi")
  if not ok or not ffi then return false end
  _ffi = ffi

  if not _G.__RA_KEYCHAIN_CDEF_LOADED then
    ffi.cdef[[
        typedef void* BCRYPT_ALG_HANDLE;
        typedef void* BCRYPT_KEY_HANDLE;
        typedef void* BCRYPT_HASH_HANDLE;
        typedef void* HKEY;
        typedef unsigned long DWORD;
        typedef long LSTATUS;

        LSTATUS RegOpenKeyExA(HKEY hKey, const char* lpSubKey, DWORD ulOptions, DWORD samDesired, HKEY* phkResult);
        LSTATUS RegQueryValueExA(HKEY hKey, const char* lpValueName, DWORD* lpReserved, DWORD* lpType, unsigned char* lpData, DWORD* lpcbData);
        LSTATUS RegCloseKey(HKEY hKey);

        long BCryptOpenAlgorithmProvider(BCRYPT_ALG_HANDLE *phAlgorithm, const wchar_t *pszAlgId, const wchar_t *pszImplementation, unsigned long dwFlags);
        long BCryptCloseAlgorithmProvider(BCRYPT_ALG_HANDLE hAlgorithm, unsigned long dwFlags);
        long BCryptGenerateSymmetricKey(BCRYPT_ALG_HANDLE hAlgorithm, BCRYPT_KEY_HANDLE *phKey, unsigned char *pbKeyObject, unsigned long cbKeyObject, unsigned char *pbSecret, unsigned long cbSecret, unsigned long dwFlags);
        long BCryptDestroyKey(BCRYPT_KEY_HANDLE hKey);

        long BCryptCreateHash(BCRYPT_ALG_HANDLE hAlgorithm, BCRYPT_HASH_HANDLE *phHash, unsigned char *pbHashObject, unsigned long cbHashObject, unsigned char *pbSecret, unsigned long cbSecret, unsigned long dwFlags);
        long BCryptHashData(BCRYPT_HASH_HANDLE hHash, unsigned char *pbInput, unsigned long cbInput, unsigned long dwFlags);
        long BCryptFinishHash(BCRYPT_HASH_HANDLE hHash, unsigned char *pbOutput, unsigned long cbOutput, unsigned long dwFlags);
        long BCryptDestroyHash(BCRYPT_HASH_HANDLE hHash);

        typedef struct _BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
          unsigned long cbSize;
          unsigned long dwInfoVersion;
          unsigned char *pbNonce;
          unsigned long cbNonce;
          unsigned char *pbAuthData;
          unsigned long cbAuthData;
          unsigned char *pbTag;
          unsigned long cbTag;
          unsigned char *pbMacContext;
          unsigned long cbMacContext;
          unsigned char *pbAAD;
          unsigned long long cbData;
          unsigned long dwFlags;
        } BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO;

        long BCryptDecrypt(
          BCRYPT_KEY_HANDLE hKey,
          unsigned char *pbInput,
          unsigned long cbInput,
          void *pPaddingInfo,
          unsigned char *pbIV,
          unsigned long cbIV,
          unsigned char *pbOutput,
          unsigned long cbOutput,
          unsigned long *pcbResult,
          unsigned long dwFlags
        );
      ]]
    _G.__RA_KEYCHAIN_CDEF_LOADED = true
  end

  local ok_advapi, advapi = pcall(ffi.load, "advapi32.dll")
  local ok_bcrypt, bcrypt = pcall(ffi.load, "bcrypt.dll")
  if ok_advapi and ok_bcrypt then
    _advapi = advapi
    _bcrypt = bcrypt
    _G.__RA_KEYCHAIN_ADVAPI = advapi
    _G.__RA_KEYCHAIN_BCRYPT = bcrypt
    _G.__RA_KEYCHAIN_FFI = ffi
    _G.__RA_KEYCHAIN_FFI_INITIALIZED = true
    _keychain_ffi_ready = true
    return true
  end
  return false
end

-- In-memory cache for decrypted keychain credentials across shortcut lookups
local _cached_keychain_user = nil
local _cached_keychain_token = nil
local _cached_keychain_base_dir = nil
local _cached_ra_confs = {}

local function read_retroarch_keychain(base_dir)
  if _cached_keychain_user and _cached_keychain_token and _cached_keychain_base_dir == base_dir then
    return _cached_keychain_user, _cached_keychain_token
  end

  if not init_keychain_ffi() then return nil end
  local ffi = _ffi
  local advapi = _advapi
  local bcrypt = _bcrypt

  local ok, res = pcall(function()
    local f_key = io.open(base_dir .. "/retroarch-keychain.key", "r")
    if not f_key then return nil end
    local key_hex = f_key:read("*l")
    f_key:close()
    if not key_hex or #key_hex < 64 then return nil end

    local f_cfg = io.open(base_dir .. "/retroarch-keychain.cfg", "r")
    if not f_cfg then return nil end
    local cfg_text = f_cfg:read("*a")
    f_cfg:close()
    if not cfg_text then return nil end

    local function to_wide(str)
      local w = ffi.new("wchar_t[?]", #str + 1)
      for i = 1, #str do w[i-1] = string.byte(str, i) end
      w[#str] = 0
      return w
    end

    local function get_guid()
      local HKEY_LOCAL_MACHINE = ffi.cast("HKEY", ffi.cast("uintptr_t", 0x80000002))
      local KEY_READ = 0x20019
      local KEY_WOW64_64KEY = 0x0100
      local phk = ffi.new("HKEY[1]")
      local res = advapi.RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", 0, KEY_READ + KEY_WOW64_64KEY, phk)
      if res ~= 0 then return nil end
      local buf = ffi.new("char[128]")
      local len = ffi.new("DWORD[1]", 128)
      local t = ffi.new("DWORD[1]")
      res = advapi.RegQueryValueExA(phk[0], "MachineGuid", nil, t, ffi.cast("unsigned char*", buf), len)
      advapi.RegCloseKey(phk[0])
      if res ~= 0 then return nil end
      return ffi.string(buf, len[0] - 1)
    end

    local function hmac(key, data)
      local hAlg = ffi.new("BCRYPT_ALG_HANDLE[1]")
      if bcrypt.BCryptOpenAlgorithmProvider(hAlg, to_wide("SHA256"), nil, 0x00000008) ~= 0 then return nil end
      local hHash = ffi.new("BCRYPT_HASH_HANDLE[1]")
      if bcrypt.BCryptCreateHash(hAlg[0], hHash, nil, 0, ffi.cast("unsigned char*", key), #key, 0) ~= 0 then
        bcrypt.BCryptCloseAlgorithmProvider(hAlg[0], 0)
        return nil
      end
      bcrypt.BCryptHashData(hHash[0], ffi.cast("unsigned char*", data), #data, 0)
      local out = ffi.new("unsigned char[32]")
      bcrypt.BCryptFinishHash(hHash[0], out, 32, 0)
      bcrypt.BCryptDestroyHash(hHash[0])
      bcrypt.BCryptCloseAlgorithmProvider(hAlg[0], 0)
      return ffi.string(out, 32)
    end

    local function decrypt_field(derived_key, blob, aad)
      if #blob < 28 then return nil end
      local nonce = blob:sub(1, 12)
      local ct = blob:sub(13, #blob - 16)
      local tag = blob:sub(#blob - 15)

      local hAlg = ffi.new("BCRYPT_ALG_HANDLE[1]")
      if bcrypt.BCryptOpenAlgorithmProvider(hAlg, to_wide("CHACHA20_POLY1305"), nil, 0) ~= 0 then return nil end
      local hKey = ffi.new("BCRYPT_KEY_HANDLE[1]")
      if bcrypt.BCryptGenerateSymmetricKey(hAlg[0], hKey, nil, 0, ffi.cast("unsigned char*", derived_key), #derived_key, 0) ~= 0 then
        bcrypt.BCryptCloseAlgorithmProvider(hAlg[0], 0)
        return nil
      end
      local auth_info = ffi.new("BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO")
      auth_info.cbSize = ffi.sizeof("BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO")
      auth_info.dwInfoVersion = 1
      auth_info.pbNonce = ffi.cast("unsigned char*", nonce)
      auth_info.cbNonce = #nonce
      auth_info.pbAuthData = ffi.cast("unsigned char*", aad)
      auth_info.cbAuthData = #aad
      auth_info.pbTag = ffi.cast("unsigned char*", tag)
      auth_info.cbTag = #tag

      local out = ffi.new("unsigned char[?]", #ct)
      local pcbResult = ffi.new("unsigned long[1]")
      local st = bcrypt.BCryptDecrypt(hKey[0], ffi.cast("unsigned char*", ct), #ct, auth_info, nil, 0, out, #ct, pcbResult, 0)
      bcrypt.BCryptDestroyKey(hKey[0])
      bcrypt.BCryptCloseAlgorithmProvider(hAlg[0], 0)
      if st ~= 0 then return nil end
      return ffi.string(out, pcbResult[0])
    end

    local b64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local b64_lookup = {}
    for i = 1, 64 do b64_lookup[b64_chars:sub(i, i)] = i - 1 end
    local function b64_decode(data)
      local clean = data:gsub("[^A-Za-z0-9+/=]", "")
      local out = {}
      local len = #clean
      local i = 1
      while i <= len do
        local c1 = b64_lookup[clean:sub(i, i)]
        local c2 = b64_lookup[clean:sub(i+1, i+1)]
        local ch3 = clean:sub(i+2, i+2)
        local ch4 = clean:sub(i+3, i+3)
        local c3 = ch3 ~= "=" and b64_lookup[ch3] or 0
        local c4 = ch4 ~= "=" and b64_lookup[ch4] or 0
        if c1 and c2 then
          local b1 = bit.bor(bit.lshift(c1, 2), bit.rshift(c2, 4))
          table.insert(out, string.char(b1))
          if ch3 ~= "=" and c3 then
            local b2 = bit.bor(bit.lshift(bit.band(c2, 0x0F), 4), bit.rshift(c3, 2))
            table.insert(out, string.char(b2))
            if ch4 ~= "=" and c4 then
              local b3 = bit.bor(bit.lshift(bit.band(c3, 0x03), 6), c4)
              table.insert(out, string.char(b3))
            end
          end
        end
        i = i + 4
      end
      return table.concat(out)
    end

    local guid = get_guid()
    if not guid then return nil end

    local salt = ""
    for i = 1, #key_hex, 2 do
      local byte = tonumber(key_hex:sub(i, i+1), 16)
      if not byte then return nil end
      salt = salt .. string.char(byte)
    end
    if #salt ~= 32 then return nil end

    local prk = hmac(salt, guid)
    if not prk then return nil end
    local derived_key = hmac(prk, "retroarch-keychain-v1" .. string.char(1)):sub(1, 32)

    local username, token
    for line in cfg_text:gmatch("[^\r\n]+") do
      local k, b64 = line:match('^([%w_]+)%s*=%s*"?%$kc1%$(.-)"?$')
      if k and b64 then
        b64 = b64:gsub('"', '')
        local raw = b64_decode(b64)
        if k == "cheevos_username" then
          username = decrypt_field(derived_key, raw, "cheevos_username")
        elseif k == "cheevos_token" then
          token = decrypt_field(derived_key, raw, "cheevos_token")
        end
      end
    end
    return { username = username, token = token }
  end)

  if ok and res and res.username and res.token then
    _cached_keychain_user = res.username
    _cached_keychain_token = res.token
    _cached_keychain_base_dir = base_dir
    return res.username, res.token
  end
  return nil
end

--- Locate retroarch.cfg and parse credentials + paths
function M.get_retroarch_config(override_dir)
  local target_key = override_dir or "default"
  if _cached_ra_confs[target_key] then
    return _cached_ra_confs[target_key]
  end
  local candidates = {}
  if override_dir and #override_dir > 0 then
    table.insert(candidates, override_dir .. "/retroarch.cfg")
  end
  local ra_dir = M.emulator_dirs().retroarch
  if ra_dir and ra_dir ~= override_dir then
    table.insert(candidates, ra_dir .. "/retroarch.cfg")
  end
  table.insert(candidates, (os.getenv("APPDATA") or "") .. "/RetroArch/retroarch.cfg")

  local cfg_path = nil
  for _, p in ipairs(candidates) do
    local f = io.open(p, "r")
    if f then
      f:close()
      cfg_path = p
      break
    end
  end

  if not cfg_path then
    return nil, "retroarch.cfg not found"
  end

  local base_dir = cfg_path:match("^(.*)[/\\][^/\\]+$") or "."
  local text = utils.read_file(cfg_path)
  if not text then
    return nil, "cannot read retroarch.cfg"
  end

  local conf = {
    base_dir = base_dir,
    cfg_path = cfg_path,
    username = nil,
    token = nil,
    enabled = false,
    log_dir = base_dir .. "/logs",
    screenshots_dir = base_dir .. "/screenshots",
  }

  for line in text:gmatch("[^\r\n]+") do
    local k, v = line:match('^([%w_]+)%s*=%s*"([^"]*)"')
    if k and v then
      if k == "cheevos_username" and #v > 0 then
        conf.username = v
      elseif k == "cheevos_token" and #v > 0 then
        conf.token = v
      elseif k == "cheevos_enable" then
        conf.enabled = (v == "true")
      elseif k == "log_dir" then
        -- Expand ":\" to base_dir
        local p = v:gsub("^:[/\\]", base_dir .. "/")
        conf.log_dir = p
      elseif k == "screenshot_directory" then
        local p = v:gsub("^:[/\\]", base_dir .. "/")
        conf.screenshots_dir = p
      end
    end
  end

  -- RetroArch 1.19+ encrypted keychain fallback if plaintext credentials not in retroarch.cfg
  if not conf.username or not conf.token then
    local k_user, k_token = read_retroarch_keychain(base_dir)
    if k_user and #k_user > 0 and k_token and #k_token > 0 then
      conf.username = k_user
      conf.token = k_token
    end
  end

  if conf.username and conf.token then
    _cached_ra_confs[conf.base_dir] = conf
    _cached_ra_confs[target_key] = conf
  end
  return conf
end


--- Discovers RetroAchievements credentials from installed emulators
--- (RetroArch, DuckStation, PCSX2, Dolphin, PPSSPP).
function M.get_credentials(exe_hint)
  local appdata = os.getenv("APPDATA") or ""
  local localappdata = os.getenv("LOCALAPPDATA") or ""
  local userprofile = os.getenv("USERPROFILE") or ""
  local exe_str = tostring(exe_hint or ""):lower():gsub("\\", "/")
  local exe_dir = exe_str:match("^(.*)/[^/]+$") or ""
  local emu = M.emulator_dirs()

  local function read_ra()
    local conf = M.get_retroarch_config(#exe_dir > 0 and exe_dir or nil)
    if conf and conf.username and #conf.username > 0 and conf.token and #conf.token > 0 then
      return {
        username = conf.username,
        token = conf.token,
        emulator = "retroarch",
        cfg_path = conf.cfg_path,
      }
    end
    return nil
  end

  local function read_duckstation()
    local candidates = {
      #exe_dir > 0 and (exe_dir .. "/settings.ini"),
      emu.duckstation and (emu.duckstation .. "/settings.ini"),
      #userprofile > 0 and (userprofile .. "/Documents/DuckStation/settings.ini"),
      #appdata > 0 and (appdata .. "/DuckStation/settings.ini"),
      #localappdata > 0 and (localappdata .. "/DuckStation/settings.ini"),
    }
    for _, p in ipairs(candidates) do
      if p then
        local text = utils.read_file(p)
        if text then
          local ini = M.parse_ini(text)
          local cheevos = ini["cheevos"] or ini["achievements"]
          if cheevos then
            local u = cheevos["username"]
            local t = cheevos["token"] or cheevos["usertoken"]
            if u and #u > 0 and t and #t > 0 then
              return {
                username = u,
                token = t,
                emulator = "duckstation",
                cfg_path = p,
              }
            end
          end
        end
      end
    end
    return nil
  end

  local function read_pcsx2()
    local candidates = {
      #exe_dir > 0 and (exe_dir .. "/inis/PCSX2.ini"),
      emu.pcsx2 and (emu.pcsx2 .. "/inis/PCSX2.ini"),
      #userprofile > 0 and (userprofile .. "/Documents/PCSX2/inis/PCSX2.ini"),
      #appdata > 0 and (appdata .. "/PCSX2/inis/PCSX2.ini"),
      #localappdata > 0 and (localappdata .. "/PCSX2/inis/PCSX2.ini"),
    }
    for _, p in ipairs(candidates) do
      if p then
        local text = utils.read_file(p)
        if text then
          local ini = M.parse_ini(text)
          local cheevos = ini["achievements"]
          if cheevos then
            local u = cheevos["username"]
            local t = cheevos["token"]
            if u and #u > 0 and t and #t > 0 then
              return {
                username = u,
                token = t,
                emulator = "pcsx2",
                cfg_path = p,
              }
            end
          end
        end
      end
    end
    return nil
  end

  local function read_dolphin()
    local candidates = {
      #exe_dir > 0 and (exe_dir .. "/User/Config/RetroAchievements.ini"),
      #exe_dir > 0 and (exe_dir .. "/User/Config/Dolphin.ini"),
      emu.primehack and (emu.primehack .. "/User/Config/RetroAchievements.ini"),
      emu.primehack and (emu.primehack .. "/User/Config/Dolphin.ini"),
      emu.dolphin and (emu.dolphin .. "/User/Config/RetroAchievements.ini"),
      emu.dolphin and (emu.dolphin .. "/User/Config/Dolphin.ini"),
      #appdata > 0 and (appdata .. "/Dolphin Emulator/Config/RetroAchievements.ini"),
      #appdata > 0 and (appdata .. "/Dolphin Emulator/Config/Dolphin.ini"),
      #userprofile > 0 and (userprofile .. "/Documents/Dolphin Emulator/Config/RetroAchievements.ini"),
      #userprofile > 0 and (userprofile .. "/Documents/Dolphin Emulator/Config/Dolphin.ini"),
    }
    for _, p in ipairs(candidates) do
      if p then
        local text = utils.read_file(p)
        if text then
          local ini = M.parse_ini(text)
          local cheevos = ini["achievements"]
          if cheevos then
            local u = cheevos["username"]
            local t = cheevos["token"]
            if u and #u > 0 and t and #t > 0 then
              return {
                username = u,
                token = t,
                emulator = "dolphin",
                cfg_path = p,
              }
            end
          end
        end
      end
    end
    return nil
  end

  local function read_ppsspp()
    local candidates = {
      #exe_dir > 0 and (exe_dir .. "/memstick/PSP/SYSTEM/ppsspp.ini"),
      emu.ppsspp and (emu.ppsspp .. "/memstick/PSP/SYSTEM/ppsspp.ini"),
      #appdata > 0 and (appdata .. "/PPSSPP/PSP/SYSTEM/ppsspp.ini"),
    }
    for _, p in ipairs(candidates) do
      if p then
        local text = utils.read_file(p)
        if text then
          local ini = M.parse_ini(text)
          local cheevos = ini["achievements"]
          if cheevos then
            local u = cheevos["achievementsusername"] or cheevos["username"]
            local t = cheevos["achievementsusertoken"] or cheevos["token"]
            if u and #u > 0 and t and #t > 0 then
              return {
                username = u,
                token = t,
                emulator = "ppsspp",
                cfg_path = p,
              }
            end
          end
        end
      end
    end
    return nil
  end

  -- If exe_hint matches an emulator, test that emulator first
  local prioritized = nil
  if exe_str:find("duckstation") then
    prioritized = read_duckstation
  elseif exe_str:find("pcsx") then
    prioritized = read_pcsx2
  elseif exe_str:find("dolphin") or exe_str:find("primehack") then
    prioritized = read_dolphin
  elseif exe_str:find("ppsspp") then
    prioritized = read_ppsspp
  elseif exe_str:find("retroarch") then
    prioritized = read_ra
  end

  local web_cfg = require("web_config")
  local env_creds = web_cfg.get_retroachievements_credentials and web_cfg.get_retroachievements_credentials()

  local found = nil
  if prioritized then
    found = prioritized()
  end

  if not found then
    local all = { read_ra, read_duckstation, read_pcsx2, read_dolphin, read_ppsspp }
    for _, fn in ipairs(all) do
      if fn ~= prioritized then
        found = fn()
        if found then break end
      end
    end
  end

  if found then
    if env_creds then
      found.api_key = env_creds.api_key or env_creds.token
      if (not found.username or #found.username == 0) and env_creds.username and #env_creds.username > 0 then
        found.username = env_creds.username
      end
    end
    return found
  end

  -- Check .env credentials if no emulator config had tokens
  if env_creds and (env_creds.token or env_creds.api_key) then
    local k = env_creds.api_key or env_creds.token
    if #k > 0 then
      return {
        username = env_creds.username,
        token = env_creds.token,
        api_key = k,
        emulator = "env",
        cfg_path = ".env",
      }
    end
  end

  return { username = nil, token = nil, api_key = nil, emulator = nil }
end

--- Extracts the ROM path from a shortcut's command line or launch options
function M.extract_rom_path(cmd, launch_options)
  local full = tostring(cmd or "") .. " " .. tostring(launch_options or "")
  
  -- Scan all quoted arguments in reverse
  local quoted = {}
  for q in full:gmatch('"([^"]+)"') do
    table.insert(quoted, q)
  end

  for i = #quoted, 1, -1 do
    local s = quoted[i]:lower()
    if not s:find("%.exe$") and not s:find("%.dll$") and not s:match("^%-") then
      local f = io.open(quoted[i], "rb")
      if f then
        f:close()
        return quoted[i]
      end
    end
  end

  -- Fallback to last unquoted token
  local last_token = full:match("(%S+)$")
  if last_token then
    local cleaned = last_token:gsub('^"', ''):gsub('"$', '')
    if not cleaned:lower():find("%.exe$") and not cleaned:lower():find("%.dll$") then
      local f = io.open(cleaned, "rb")
      if f then
        f:close()
        return cleaned
      end
    end
  end

  return nil
end

local ra_cache = require("ra_cache")
local rom_md5_cache = {}

--- The ROM's RetroAchievements MD5 (rom_hash.lua, in Lua: no Node.js, ADR-0066). Kept on disk while the file is
--- unchanged (ra_cache.lua, ADR-0060), so a ROM is hashed once, not once per Steam start.
function M.compute_rom_md5(rom_path)
  if not rom_path then return nil, "missing rom path" end
  if rom_md5_cache[rom_path] then return rom_md5_cache[rom_path] end
  local stored = ra_cache.md5_for(rom_path)
  if stored then
    rom_md5_cache[rom_path] = stored
    return stored
  end
  
  local ok, data, herr = pcall(function() return require("rom_hash").rom_md5(rom_path) end)
  if not ok then return nil, "hasher failed: " .. tostring(data) end
  if not data then return nil, herr or "hasher failed" end

  if data.error then
    return nil, data.error
  end

  if type(data.md5) == "string" and #data.md5 > 0 then
    rom_md5_cache[rom_path] = data.md5
    ra_cache.put_md5(rom_path, data.md5)
    return data.md5
  end
  return nil
end

--- Queries RetroAchievements for the GameID corresponding to a ROM MD5. A definite answer (a game, or none) is kept
--- on disk (ra_cache.lua, ADR-0060; a miss for 7 days); a network failure is not.
function M.get_game_id_by_md5(md5)
  if not md5 or #md5 == 0 then return nil, "missing md5" end
  local known, known_id = ra_cache.game_for(md5)
  if known then
    if known_id then return known_id end
    return nil, "game not found on RetroAchievements"
  end
  local url = "https://retroachievements.org/dorequest.php?r=gameid&m=" .. tostring(md5)
  
  local ok, res = pcall(net.get, url, {
    source = "retroachievements",
    user_agent = "RetroArch/1.19.0",
    headers = {
      ["User-Agent"] = "RetroArch/1.19.0",
      ["Accept"] = "application/json",
    },
    timeout = 10,
  })

  if not ok or not res or res.status ~= 200 or not res.body then
    return nil, "http request failed"
  end

  local decode_ok, data = pcall(json.decode, res.body)
  if not decode_ok or type(data) ~= "table" then
    return nil, "invalid gameid response"
  end
  if not data.Success or not data.GameID or data.GameID == 0 then
    if data.Success then ra_cache.put_game(md5, nil) end -- a definite "no game"; an API error is asked again
    return nil, "game not found on RetroAchievements"
  end

  local gid_num = tonumber(data.GameID)
  if gid_num and (gid_num == 11621 or gid_num >= 1000000000) then
    ra_cache.put_game(md5, nil)
    return nil, "cheated or graveyard entry on RetroAchievements"
  end

  ra_cache.put_game(md5, gid_num)
  return data.GameID
end

local games_list_cache = {}

--- Detects RetroAchievements console ID from shortcut exe or launch options
function M.detect_console_id(cmd, launch_options)
  local full = (tostring(cmd or "") .. " " .. tostring(launch_options or "")):lower()
  if full:find("pcsx2") or full:find("[/\\]ps2[/\\]") then
    return 21 -- PlayStation 2
  elseif full:find("swanstation") or full:find("duckstation") or full:find("pcsx") or full:find("[/\\]psx[/\\]") or full:find("%.chd") then
    return 12 -- PlayStation
  elseif full:find("snes9x") or full:find("bsnes") or full:find("[/\\]snes[/\\]") or full:find("%.sfc") or full:find("%.smc") then
    return 3  -- SNES
  elseif full:find("mgba") or full:find("vba") or full:find("[/\\]gba[/\\]") or full:find("%.gba") then
    return 5  -- GBA
  elseif full:find("fbneo") or full:find("mame") or full:find("[/\\]fbneo[/\\]") or full:find("[/\\]arcade[/\\]") then
    return 27 -- Arcade
  elseif full:find("genesis") or full:find("picodrive") or full:find("[/\\]genesis[/\\]") or full:find("[/\\]megadrive[/\\]") or full:find("%.smd") or full:find("%.gen") then
    return 1  -- Sega Genesis
  elseif full:find("mupen64") or full:find("parallel_n64") or full:find("[/\\]n64[/\\]") or full:find("%.z64") or full:find("%.v64") or full:find("%.n64") then
    return 2  -- Nintendo 64
  elseif full:find("mesen") or full:find("fceumm") or full:find("nestopia") or full:find("[/\\]nes[/\\]") or full:find("%.nes") then
    return 7  -- NES
  elseif full:find("dolphin") or full:find("primehack") or full:find("[/\\]gc[/\\]") or full:find("[/\\]gamecube[/\\]") then
    return 16 -- GameCube
  elseif full:find("ppsspp") or full:find("[/\\]psp[/\\]") then
    return 41 -- PSP
  elseif full:find("flycast") or full:find("dreamcast") or full:find("[/\\]dreamcast[/\\]") or full:find("%.gdi") or full:find("%.cdi") then
    return 18 -- Dreamcast
  elseif full:find("beetle_saturn") or full:find("yabause") or full:find("kronos") or full:find("[/\\]saturn[/\\]") then
    return 39 -- Saturn
  elseif full:find("gambatte") or full:find("gearboy") or full:find("[/\\]gbc[/\\]") or full:find("[/\\]gb[/\\]") or full:find("%.gbc") or full:find("%.gb") then
    return 4  -- Game Boy / Game Boy Color
  elseif full:find("melonds") or full:find("desmume") or full:find("[/\\]nds[/\\]") or full:find("%.nds") then
    return 19 -- Nintendo DS
  elseif full:find("mednafen_pce") or full:find("[/\\]pce[/\\]") or full:find("%.pce") then
    return 8  -- PC Engine / TurboGrafx-16
  elseif full:find("sms") or full:find("gearsystem") or full:find("[/\\]sms[/\\]") then
    return 9  -- Master System
  end
  return nil
end

local function clean_shortcut_candidates(s)
  local cleaned = tostring(s or ""):gsub("%s*%b()", ""):gsub("%s*%b[]", ""):gsub("^%s+", ""):gsub("%s+$", "")
  local candidates = { cleaned }
  if cleaned:find(" / ", 1, true) then
    for part in cleaned:gmatch("[^/]+") do
      local p = part:gsub("^%s+", ""):gsub("%s+$", "")
      if #p > 0 then
        table.insert(candidates, p)
      end
    end
  end
  if cleaned:find(" - ", 1, true) then
    local before = cleaned:match("^(.-)%s*%-")
    if before then
      local b = before:gsub("^%s+", ""):gsub("%s+$", "")
      if #b > 0 then
        table.insert(candidates, b)
      end
    end
  end
  return candidates
end

local function normalize_title(s)
  if not s then return "" end
  local str = " " .. tostring(s):gsub("\xc2\xa0", " "):gsub("\xe2\x80[\x90-\x95]", "-"):lower():gsub("[^%w]", " ") .. " "
  str = str:gsub("%s+part%s*(%d+)%s+", " %1 ")
  str = str:gsub("%s+part%s*i%s+", " 1 ")
  str = str:gsub("%s+part%s*ii%s+", " 2 ")
  str = str:gsub("%s+part%s*iii%s+", " 3 ")
  str = str:gsub("%s+part%s*iv%s+", " 4 ")
  str = str:gsub("%s+part%s*v%s+", " 5 ")
  str = str:gsub("%s+ii%s+", " 2 ")
  str = str:gsub("%s+iii%s+", " 3 ")
  str = str:gsub("%s+iv%s+", " 4 ")
  str = str:gsub("%s+v%s+", " 5 ")
  str = str:gsub("%s+aliens%s+", " alien ")
  return (str:gsub("%s+", ""))
end

local function extract_number(norm)
  return norm:match("(%d+)")
end

local function extract_entry(k, v)
  if type(v) == "table" then
    return tonumber(v.ID or v.id or k), tostring(v.Title or v.title or "")
  elseif type(v) == "string" then
    return tonumber(k), v
  end
  return nil, ""
end

local function is_collection_title(s)
  local l = tostring(s or ""):lower()
  return l:find("trilogy", 1, true) ~= nil
      or l:find("collection", 1, true) ~= nil
      or l:find("anthology", 1, true) ~= nil
      or l:find("compilation", 1, true) ~= nil
end

local function match_single(cand_title, list)
  local norm_target = normalize_title(cand_title)
  if #norm_target < 3 then return nil end
  local target_num = extract_number(norm_target)
  local lower_cand = cand_title:lower()
  local is_hack_target = lower_cand:find("hack", 1, true) ~= nil or lower_cand:find("edition", 1, true) ~= nil
  local is_col_target = is_collection_title(cand_title)

  local best_match = nil
  local best_score = -1

  for k, v in pairs(list) do
    local gid, gtitle = extract_entry(k, v)
    if gid then
      local lower_g = gtitle:lower()
      if not (lower_g:find("^unsupported game version") or lower_g:find("^~z~") or lower_g:find("cheated rom") or gid == 11621 or gid >= 1000000000) then
        local norm_g = normalize_title(gtitle)
        local g_num = extract_number(norm_g)
        local is_hack_g = gtitle:find("^~Hack~") ~= nil
        local is_col_g = is_collection_title(gtitle)

        if norm_target == norm_g then
          return { id = gid, title = gtitle, score = 100, is_exact = true }
        end

        local number_ok = true
        if target_num ~= nil and g_num ~= nil and target_num ~= g_num then
          number_ok = false
        elseif target_num ~= nil and g_num == nil then
          number_ok = false
        elseif target_num == nil and g_num ~= nil then
          number_ok = false
        end

        if (is_col_target and not is_col_g) or (not is_col_target and is_col_g) then
          number_ok = false
        end

        if number_ok then
          if is_hack_target or not is_hack_g then
            if #norm_g >= 5 and (norm_target:find(norm_g, 1, true) or norm_g:find(norm_target, 1, true)) then
              local len_diff = math.abs(#norm_target - #norm_g)
              local score = 80 - len_diff
              if score > best_score then
                best_score = score
                best_match = { id = gid, title = gtitle, score = score, is_exact = false }
              end
            end
          end
        end
      end
    end
  end

  return best_match
end

local KNOWN_ALIASES = {
  ["fire emblem the binding blade"] = { "Fire Emblem: Fuuin no Tsurugi", "Fire Emblem: Sword of Seals" },
  ["fire emblem fuuin no tsurugi"] = { "Fire Emblem: The Binding Blade", "Fire Emblem: Sword of Seals" },
  ["fire emblem sword of seals"] = { "Fire Emblem: Fuuin no Tsurugi", "Fire Emblem: The Binding Blade" },
  ["fire emblem new mystery of the emblem"] = { "Fire Emblem: Shin Monshou no Nazo" },
  ["fire emblem shin monshou no nazo"] = { "Fire Emblem: New Mystery of the Emblem" },
  ["fire emblem thracia 776"] = { "Fire Emblem: Thracia 776" },
  ["fire emblem genealogy of the holy war"] = { "Fire Emblem: Seisen no Keifu" },
  ["fire emblem seisen no keifu"] = { "Fire Emblem: Genealogy of the Holy War" },
  ["dragon quest v"] = { "Dragon Quest V: Tenkuu no Hanayome", "Dragon Warrior V" },
  ["dragon quest vi"] = { "Dragon Quest VI: Maboroshi no Daichi", "Dragon Warrior VI" },
  ["seiken densetsu 3"] = { "Trials of Mana" },
  ["trials of mana"] = { "Seiken Densetsu 3" },
  ["live a live"] = { "Live A Live" },
  ["mother 3"] = { "Mother 3" },
  ["bahamut lagoon"] = { "Bahamut Lagoon" },
  ["tales of phantasia"] = { "Tales of Phantasia" },
  ["super bomberman 5"] = { "Super Bomberman 5: Gold Cartridge" },
}

local function get_aliases_for(title)
  if not title then return {} end
  local cleaned = tostring(title):lower():gsub("[^%w%s]", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  local results = {}
  for k, list in pairs(KNOWN_ALIASES) do
    if cleaned == k or cleaned:find(k, 1, true) or k:find(cleaned, 1, true) then
      for _, a in ipairs(list) do
        table.insert(results, a)
      end
    end
  end
  return results
end

--- Queries RetroAchievements games list for a console and matches by title
---@param target_title string
---@param cmd string|nil
---@param launch_options string|nil
---@param appid number|nil
function M.find_game_id_by_title(target_title, cmd, launch_options, appid)
  if not target_title or #target_title == 0 then return nil end
  local console_id = M.detect_console_id(cmd, launch_options)
  if not console_id then return nil end

  local list = games_list_cache[console_id]
  if not list then
    local url = "https://retroachievements.org/dorequest.php?r=gameslist&c=" .. tostring(console_id)
    local ok, res = pcall(net.get, url, {
      source = "retroachievements",
      user_agent = "RetroArch/1.19.0",
      headers = {
        ["User-Agent"] = "RetroArch/1.19.0",
        ["Accept"] = "application/json",
      },
      timeout = 10,
    })
    if ok and res and res.status == 200 and res.body then
      local decode_ok, data = pcall(json.decode, res.body)
      if decode_ok and type(data) == "table" and type(data.Response) == "table" then
        list = data.Response
        games_list_cache[console_id] = list
      end
    end
  end

  if not list or type(list) ~= "table" then return nil end

  local candidates = clean_shortcut_candidates(target_title)
  local seen = {}
  for _, cand in ipairs(candidates) do seen[cand:lower()] = true end

  local function add_cand(c)
    if c and #c > 0 and not seen[c:lower()] then
      seen[c:lower()] = true
      table.insert(candidates, c)
    end
  end

  -- Check metadata_db for alternative names or canonical titles (from IGDB/metadata)
  if appid then
    local ok_m, mdb = pcall(require, "web_metadata_db")
    if ok_m and mdb and mdb.get then
      local meta = mdb.get(appid)
      if meta then
        if meta.matched_title then add_cand(meta.matched_title) end
        if meta.title then add_cand(meta.title) end
        if type(meta.alternative_names) == "table" then
          for _, alt in ipairs(meta.alternative_names) do
            if type(alt) == "string" then add_cand(alt) end
          end
        end
      end
    end
  end

  -- Expand known aliases
  local to_expand = {}
  for _, c in ipairs(candidates) do table.insert(to_expand, c) end
  for _, c in ipairs(to_expand) do
    for _, alias in ipairs(get_aliases_for(c)) do
      add_cand(alias)
    end
  end

  for _, cand in ipairs(candidates) do
    local res = match_single(cand, list)
    if res and res.is_exact then
      return res.id
    end
  end

  local best_res = nil
  for _, cand in ipairs(candidates) do
    local res = match_single(cand, list)
    if res then
      if not best_res or res.score > best_res.score then
        best_res = res
      end
    end
  end

  if best_res then
    return best_res.id
  end

  return nil
end

--- Fetches full game schema and user unlocks from RetroAchievements
function M.fetch_game_data(game_id, username, token, hardcore, api_key)
  local gid = tonumber(game_id) or 0
  if gid <= 0 then return nil, "invalid game id" end
  local u = tostring(username or "")
  local t = tostring(token or "")
  local k = tostring(api_key or "")
  if #k == 0 then
    local web_cfg = require("web_config")
    local env_creds = web_cfg.get_retroachievements_credentials and web_cfg.get_retroachievements_credentials()
    if env_creds and env_creds.api_key and #env_creds.api_key > 0 then
      k = env_creds.api_key
    elseif env_creds and env_creds.token and #env_creds.token > 0 then
      k = env_creds.token
    end
    if #u == 0 and env_creds and env_creds.username and #env_creds.username > 0 then
      u = env_creds.username
    end
  end

  local is_hardcore = (hardcore ~= false)
  local h_val = is_hardcore and 1 or 0

  local achievements = {}
  local unlocks = {}
  local game_title = ""

  local function parse_iso_time(s)
    if not s or type(s) ~= "string" then return nil end
    local yr, mo, da, hr, mn, sc = s:match("^(%d+)-(%d+)-(%d+)%s+(%d+):(%d+):(%d+)")
    if yr and mo and da and hr and mn and sc then
      return os.time({
        year = tonumber(yr),
        month = tonumber(mo),
        day = tonumber(da),
        hour = tonumber(hr),
        min = tonumber(mn),
        sec = tonumber(sc),
      })
    end
    return nil
  end

  -- Strategy A: Official Web API (if api_key available)
  if #k > 0 then
    local url = nil
    if #u > 0 then
      url = string.format(
        "https://retroachievements.org/API/API_GetGameInfoAndUserProgress.php?y=%s&u=%s&g=%d",
        utils.url_encode(k), utils.url_encode(u), gid
      )
    else
      url = string.format(
        "https://retroachievements.org/API/API_GetGameExtended.php?y=%s&i=%d",
        utils.url_encode(k), gid
      )
    end

    local ok, res = pcall(net.get, url, {
      source = "retroachievements",
      user_agent = "RetroArch/1.19.0",
      headers = {
        ["User-Agent"] = "RetroArch/1.19.0",
        ["Accept"] = "application/json",
      },
      timeout = 10,
    })

    if ok and res and res.status == 200 and res.body then
      local decode_ok, data = pcall(json.decode, res.body)
      if decode_ok and type(data) == "table" and data.Title then
        game_title = tostring(data.Title or "")
        local raw_achs = data.Achievements or {}
        local num_players = tonumber(data.NumDistinctPlayers) or tonumber(data.NumDistinctPlayersCasual) or 0

        for ach_k, a in pairs(raw_achs) do
          if type(a) == "table" and (a.ID or a.id) then
            local aid = tostring(a.ID or a.id)
            local badge = tostring(a.BadgeName or "00000")
            local pts = tonumber(a.Points) or 0
            local awarded = tonumber(a.NumAwarded or a.NumAwardedHardcore) or 0
            local pct = 0
            if num_players > 0 and awarded > 0 then
              pct = math.min(100, math.max(0, math.floor(((awarded * 10000) / num_players) + 0.5) / 100))
            end

            table.insert(achievements, {
              id = aid,
              name = tostring(a.Title or a.name or ""),
              description = tostring(a.Description or a.description or ""),
              icon = string.format("https://media.retroachievements.org/Badge/%s.png", badge),
              icon_locked = string.format("https://media.retroachievements.org/Badge/%s_lock.png", badge),
              points = pts,
              global_pct = pct,
            })

            local earned = is_hardcore and (a.DateEarnedHardcore or a.DateEarned) or (a.DateEarned or a.DateEarnedHardcore)
            if earned and type(earned) == "string" and #earned > 0 then
              unlocks[aid] = {
                unlocked_time = parse_iso_time(earned) or os.time(),
              }
            end
          end
        end

        table.sort(achievements, function(x, y) return tonumber(x.id) < tonumber(y.id) end)

        local schema = {
          ra_game_id = gid,
          native_appid = 0,
          title = game_title,
          total = #achievements,
          fetched_at = os.time(),
          hardcore = is_hardcore,
          achievements = achievements,
        }
        return schema, unlocks
      end
    end
    logger:warn(string.format("RetroAchievements Web API failed for game %d; trying legacy patch endpoint", gid))
  end

  -- Strategy B: Legacy dorequest.php endpoint (fallback)
  local patch_url = "https://retroachievements.org/dorequest.php?r=patch&g=" .. tostring(gid)
  if #u > 0 and #t > 0 then
    patch_url = patch_url .. "&u=" .. utils.url_encode(u) .. "&t=" .. utils.url_encode(t)
  end
  local p_ok, p_res = pcall(net.get, patch_url, {
    source = "retroachievements",
    user_agent = "RetroArch/1.19.0",
    headers = {
      ["User-Agent"] = "RetroArch/1.19.0",
      ["Accept"] = "application/json",
    },
    timeout = 10,
  })

  if not p_ok or not p_res or p_res.status ~= 200 or not p_res.body then
    if p_res and p_res.status == 401 then
      logger:warn(string.format("RetroAchievements API returned 401 Unauthorized for user %q (token invalid/stale)", u))
    end
    return nil, "cannot fetch game patch"
  end

  local ok_patch, patch_data = pcall(json.decode, p_res.body)
  if not ok_patch or type(patch_data) ~= "table" or not patch_data.Success or not patch_data.PatchData then
    if type(patch_data) == "table" and patch_data.Error then
      logger:warn(string.format("RetroAchievements API error for game %d: %s", gid, tostring(patch_data.Error)))
    end
    return nil, "invalid patch response"
  end

  local patch = patch_data.PatchData
  local raw_achs = patch.Achievements or {}

  for _, a in ipairs(raw_achs) do
    table.insert(achievements, {
      id = tostring(a.ID),
      name = tostring(a.Title or ""),
      description = tostring(a.Description or ""),
      icon = a.BadgeURL or string.format("https://media.retroachievements.org/Badge/%s.png", a.BadgeName or "00000"),
      icon_locked = a.BadgeLockedURL or string.format("https://media.retroachievements.org/Badge/%s_lock.png", a.BadgeName or "00000"),
      points = tonumber(a.Points) or 0,
      global_pct = 0,
    })
  end

  if #u > 0 and #t > 0 then
    local unl_url = string.format(
      "https://retroachievements.org/dorequest.php?r=unlocks&g=%d&h=%d&u=%s&t=%s",
      gid, h_val, utils.url_encode(u), utils.url_encode(t)
    )
    local u_ok, u_res = pcall(net.get, unl_url, {
      source = "retroachievements",
      headers = { ["User-Agent"] = "RetroArch/1.19.0" },
      timeout = 10,
    })

    if u_ok and u_res and u_res.status == 200 and u_res.body then
      local ok_unl, u_data = pcall(json.decode, u_res.body)
      if ok_unl and type(u_data) == "table" and type(u_data.UserUnlocks) == "table" then
        for _, ach_id in ipairs(u_data.UserUnlocks) do
          unlocks[tostring(ach_id)] = {
            unlocked_time = os.time(),
          }
        end
      end
    elseif u_res and u_res.status == 401 then
      logger:warn(string.format("RetroAchievements unlocks returned 401 Unauthorized for user %q", u))
    end
  end

  local schema = {
    ra_game_id = gid,
    native_appid = 0,
    title = patch.Title or "",
    total = #achievements,
    fetched_at = os.time(),
    hardcore = is_hardcore,
    achievements = achievements,
  }

  return schema, unlocks
end

--- A known game's unlocks, asked again (ADR-0060 amendment): one RetroAchievements profile is played on several devices,
--- so an unlock earned elsewhere must reach this PC when the page opens. Reached only when the stored part is due
--- (fresh_policy: a few minutes for RetroAchievements). One request by the stored GameID: no ROM hash, no title search.
--- The answer is merged into the stored unlocks (an unlock seen here but not yet on the server is kept); a failed
--- request returns what is stored, so the page keeps working offline.
function M.refresh_unlocks(s_appid, st, is_hardcore)
  local entry = require("registry").shortcut(s_appid)
  local creds = M.get_credentials(entry and entry.exe or "")
  local game_id = st.schema.ra_game_id
  local ok, schema, unlocks = pcall(M.fetch_game_data, game_id, creds.username, creds.token, is_hardcore, creds.api_key)
  if not ok or type(schema) ~= "table" or (schema.total or 0) == 0 or type(unlocks) ~= "table" then
    return st
  end
  local merged, added = {}, 0
  for id, info in pairs(st.unlocks or {}) do merged[id] = info end
  for id, info in pairs(unlocks) do
    if not merged[id] then
      merged[id] = info
      added = added + 1
    end
  end
  store.save_schema_and_sync(s_appid, "ra_" .. tostring(game_id), schema, merged, "retroachievements")
  if added > 0 then
    logger:info(string.format("RetroAchievements: %d unlock(s) for shortcut %d came from the profile (another device or the website)", added, s_appid))
  end
  local final_state = store.get_state(s_appid)
  final_state.schema = schema
  final_state.unlocks = merged
  return final_state
end

--- Main entry point: gets cached or fetches RetroAchievements data for a shortcut
function M.get_or_fetch(shortcut_appid, hardcore)
  local s_appid = tonumber(shortcut_appid) or 0
  if s_appid == 0 then return nil, "invalid shortcut_appid" end
  if s_appid < 0 then s_appid = s_appid + 0x100000000 end
  local is_hardcore = (hardcore ~= false)

  local function is_legacy_schema(sch)
    if not sch or not sch.achievements or #sch.achievements == 0 then return false end
    for _, a in ipairs(sch.achievements) do
      local pts = tonumber(a.points) or 0
      local pct = tonumber(a.global_pct) or 0
      if pct ~= pts and (pct > 0 or pts == 0) then
        return false
      end
    end
    return true
  end

  -- 1. Check existing state in achievements.json
  local st = store.get_state(s_appid)
  if st and st.schema and st.schema.ra_game_id and st.schema.ra_game_id > 0 and st.schema.ra_game_id < 1000000000 then
    local s_title = tostring(st.schema.title or ""):lower()
    if not s_title:find("^unsupported game version") and (st.schema.total or 0) > 0 then
      if not is_legacy_schema(st.schema) and (st.schema.hardcore == nil or st.schema.hardcore == is_hardcore) then
        return M.refresh_unlocks(s_appid, st, is_hardcore)
      end
    end
  end

  -- 2. Resolve shortcut from shortcuts.vdf
  local paths, p_err = steam_paths.resolve()
  if not paths or not paths.shortcuts then
    return nil, "cannot resolve steam shortcuts path"
  end

  local list = shortcuts.parse(paths.shortcuts) or {}
  local sc = nil
  for _, entry in ipairs(list) do
    if entry.appid == s_appid then
      sc = entry
      break
    end
  end

  if not sc then
    return nil, "shortcut not found in shortcuts.vdf"
  end

  -- 3. Read Emulator credentials (using shortcut exe as hint)
  local creds = M.get_credentials(sc.exe)

  -- 4. Extract ROM path
  local rom_path = M.extract_rom_path(sc.exe, sc.launch_options)
  if not rom_path then
    return nil, "cannot extract rom path from shortcut"
  end

  -- 5. Compute ROM MD5
  local md5, md5_err = M.compute_rom_md5(rom_path)

  -- 6. Query GameID from RetroAchievements
  local game_id = nil
  local has_md5 = type(md5) == "string" and #md5 > 0
  -- A miss already on disk was logged when it was found: stay quiet for it on later starts.
  local known_miss = false
  if has_md5 then
    local known, known_id = ra_cache.game_for(md5)
    known_miss = known and not known_id
    game_id = M.get_game_id_by_md5(md5)
  end

  local schema, unlocks = nil, nil
  if game_id then
    schema, unlocks = M.fetch_game_data(game_id, creds.username, creds.token, is_hardcore, creds.api_key)
    if not schema or (schema.total or 0) == 0 or (schema.title and (schema.title:match("^~[Zz]~") or schema.title:lower():match("cheated rom"))) then
      if schema then
        -- A placeholder set (no achievements, a "~Z~" or cheated entry) is a definite answer: remember the hash as a
        -- miss (ra_cache.MISS_TTL), so later starts skip the set's request. A failed request (no schema) is not stored.
        ra_cache.put_game(md5, nil)
        logger:info(string.format("RetroAchievements: MD5 %s maps to GameID %s (%q) with no achievements; treated as unsupported", tostring(md5), tostring(game_id), schema.title or ""))
      end
      game_id = nil
      schema, unlocks = nil, nil
    end
  end

  if not game_id then
    -- When a ROM file was extracted and hashed, but the hash is not supported by RetroAchievements,
    -- DO NOT fall back to title matching! An unsupported ROM version (e.g. Caravan Event, bad dump, hack)
    -- will never trigger or unlock achievements in RetroArch or other emulators.
    if has_md5 then
      if not known_miss then logger:info(string.format("RetroAchievements: ROM MD5 %s is not supported by RetroAchievements for shortcut %s (%s); skipping automatic achievement attachment", tostring(md5), tostring(s_appid), tostring(sc.name or sc.appname or ""))) end
      return nil, "unsupported rom hash"
    end

    -- Fallback: Title matching by detected console (only when no ROM path could be extracted/hashed)
    local title = sc.name or sc.appname or ""
    game_id = M.find_game_id_by_title(title, sc.exe, sc.launch_options, s_appid)
    if not game_id then
      return nil, "cannot find game on RetroAchievements"
    end
    schema, unlocks = M.fetch_game_data(game_id, creds.username, creds.token, is_hardcore, creds.api_key)
  end

  if not schema or (schema.total or 0) == 0 then
    return nil, "cannot fetch game data"
  end

  -- 8. Save schema & unlocks in achievements_store (atomic sync, ADR-0056)
  local schema_key = "ra_" .. tostring(game_id)
  store.save_schema_and_sync(s_appid, schema_key, schema, unlocks, "retroachievements")

  local final_state = store.get_state(s_appid)
  final_state.schema = schema
  final_state.unlocks = unlocks

  logger:info(string.format(
    "RetroAchievements: loaded '%s' (GameID %d, %s) via %s for shortcut %d: %d achievements, %d unlocked",
    schema.title, game_id, is_hardcore and "hardcore" or "softcore", creds.emulator or "public", s_appid, schema.total, count_keys(unlocks)
  ))

  return final_state
end

--- Returns detection and authentication status for all supported retro emulators
function M.get_emulator_status()
  local list = {}
  local appdata = (os.getenv("APPDATA") or ""):gsub("\\", "/")
  local localappdata = (os.getenv("LOCALAPPDATA") or ""):gsub("\\", "/")
  local userprofile = (os.getenv("USERPROFILE") or ""):gsub("\\", "/")

  local emu_dirs = M.emulator_dirs()

  -- 1. RetroArch
  local ra_dir = emu_dirs["retroarch"]
  local ra_conf = M.get_retroarch_config(ra_dir)
  local ra_detected = (ra_conf ~= nil) or (ra_dir and file_exists(ra_dir .. "/retroarch.exe")) or file_exists(appdata .. "/RetroArch/retroarch.exe")
  local ra_auth = (ra_conf and ra_conf.username and #ra_conf.username > 0 and ra_conf.token and #ra_conf.token > 0) or false
  table.insert(list, {
    name = "RetroArch",
    detected = ra_detected,
    path = ra_conf and ra_conf.cfg_path or (ra_dir),
    username = ra_conf and ra_conf.username or nil,
    authenticated = ra_auth,
  })

  -- 2. DuckStation
  local duck_paths = present(
    emu_dirs["duckstation"] and (emu_dirs["duckstation"] .. "/settings.ini"),
    userprofile .. "/Documents/DuckStation/settings.ini",
    appdata .. "/DuckStation/settings.ini",
    localappdata .. "/DuckStation/settings.ini"
  )
  local duck_found, duck_user, duck_auth, duck_p = false, nil, false, nil
  for _, p in ipairs(duck_paths) do
    if p and file_exists(p) then
      duck_found = true
      duck_p = p
      local text = utils.read_file(p)
      if text then
        local ini = M.parse_ini(text)
        local cheevos = ini["cheevos"] or ini["achievements"]
        if cheevos and cheevos["username"] then
          duck_user = cheevos["username"]
          duck_auth = (cheevos["token"] or cheevos["usertoken"]) ~= nil
        end
      end
      break
    end
  end
  table.insert(list, {
    name = "DuckStation",
    detected = duck_found or (emu_dirs["duckstation"] and file_exists(emu_dirs["duckstation"] .. "/duckstation-qt-x64-ReleaseLTCG.exe")) or (emu_dirs["duckstation"] and file_exists(emu_dirs["duckstation"] .. "/duckstation-nogui-x64-ReleaseLTCG.exe")) or false,
    path = duck_p or (emu_dirs["duckstation"]),
    username = duck_user,
    authenticated = duck_auth,
  })

  -- 3. PCSX2
  local pcsx2_paths = present(
    emu_dirs["pcsx2"] and (emu_dirs["pcsx2"] .. "/inis/PCSX2.ini"),
    userprofile .. "/Documents/PCSX2/inis/PCSX2.ini",
    appdata .. "/PCSX2/inis/PCSX2.ini",
    localappdata .. "/PCSX2/inis/PCSX2.ini"
  )
  local pcsx2_found, pcsx2_user, pcsx2_auth, pcsx2_p = false, nil, false, nil
  for _, p in ipairs(pcsx2_paths) do
    if p and file_exists(p) then
      pcsx2_found = true
      pcsx2_p = p
      local text = utils.read_file(p)
      if text then
        local ini = M.parse_ini(text)
        local cheevos = ini["achievements"]
        if cheevos and cheevos["username"] then
          pcsx2_user = cheevos["username"]
          pcsx2_auth = cheevos["token"] ~= nil
        end
      end
      break
    end
  end
  table.insert(list, {
    name = "PCSX2",
    detected = pcsx2_found or (emu_dirs["pcsx2"] and file_exists(emu_dirs["pcsx2"] .. "/pcsx2-qtx64.exe")) or false,
    path = pcsx2_p or (emu_dirs["pcsx2"]),
    username = pcsx2_user,
    authenticated = pcsx2_auth,
  })

  -- 4. Dolphin / Primehack
  local dol_paths = present(
    emu_dirs["dolphin"] and (emu_dirs["dolphin"] .. "/User/Config/RetroAchievements.ini"),
    emu_dirs["dolphin"] and (emu_dirs["dolphin"] .. "/User/Config/Dolphin.ini"),
    emu_dirs["primehack"] and (emu_dirs["primehack"] .. "/User/Config/RetroAchievements.ini"),
    emu_dirs["primehack"] and (emu_dirs["primehack"] .. "/User/Config/Dolphin.ini"),
    appdata .. "/Dolphin Emulator/Config/RetroAchievements.ini",
    userprofile .. "/Documents/Dolphin Emulator/Config/RetroAchievements.ini"
  )
  local dol_found, dol_user, dol_auth, dol_p = false, nil, false, nil
  for _, p in ipairs(dol_paths) do
    if p and file_exists(p) then
      dol_found = true
      dol_p = p
      local text = utils.read_file(p)
      if text then
        local ini = M.parse_ini(text)
        local cheevos = ini["achievements"]
        if cheevos and cheevos["username"] then
          dol_user = cheevos["username"]
          dol_auth = cheevos["token"] ~= nil
        end
      end
      break
    end
  end
  table.insert(list, {
    name = "Dolphin / Primehack",
    detected = dol_found or (emu_dirs["dolphin"] and file_exists(emu_dirs["dolphin"] .. "/Dolphin.exe")) or (emu_dirs["primehack"] and file_exists(emu_dirs["primehack"] .. "/Dolphin.exe")) or false,
    path = dol_p or (emu_dirs["dolphin"] or emu_dirs["primehack"]),
    username = dol_user,
    authenticated = dol_auth,
  })

  -- 5. PPSSPP
  local ppsspp_paths = present(
    emu_dirs["ppsspp"] and (emu_dirs["ppsspp"] .. "/memstick/PSP/SYSTEM/ppsspp.ini"),
    appdata .. "/PPSSPP/PSP/SYSTEM/ppsspp.ini"
  )
  local ppsspp_found, ppsspp_user, ppsspp_auth, ppsspp_p = false, nil, false, nil
  for _, p in ipairs(ppsspp_paths) do
    if p and file_exists(p) then
      ppsspp_found = true
      ppsspp_p = p
      local text = utils.read_file(p)
      if text then
        local ini = M.parse_ini(text)
        local cheevos = ini["achievements"]
        if cheevos and (cheevos["achievementsusername"] or cheevos["username"]) then
          ppsspp_user = cheevos["achievementsusername"] or cheevos["username"]
          ppsspp_auth = (cheevos["achievementsusertoken"] or cheevos["token"]) ~= nil
        end
      end
      break
    end
  end
  table.insert(list, {
    name = "PPSSPP",
    detected = ppsspp_found or (emu_dirs["ppsspp"] and file_exists(emu_dirs["ppsspp"] .. "/PPSSPPWindows64.exe")) or false,
    path = ppsspp_p or (emu_dirs["ppsspp"]),
    username = ppsspp_user,
    authenticated = ppsspp_auth,
  })

  -- 6. RPCS3 (PS3)
  local rpcs3_paths = present(
    emu_dirs["rpcs3"] and (emu_dirs["rpcs3"] .. "/dev_hdd0/home/00000001/trophy"),
    appdata .. "/rpcs3/dev_hdd0/home/00000001/trophy",
    emu_dirs["rpcs3"] and (emu_dirs["rpcs3"] .. "/rpcs3.exe"),
    appdata .. "/rpcs3/rpcs3.exe"
  )
  local rpcs3_found, rpcs3_p = false, nil
  for _, p in ipairs(rpcs3_paths) do
    if p and file_exists(p) then
      rpcs3_found = true
      rpcs3_p = p
      break
    end
  end
  table.insert(list, {
    name = "RPCS3 (PS3)",
    detected = rpcs3_found,
    path = rpcs3_p or (emu_dirs["rpcs3"]),
    username = rpcs3_found and "Local Trophy DB" or nil,
    authenticated = rpcs3_found,
  })

  -- 7. shadPS4 (PS4)
  local shad_paths = present(
    emu_dirs["shadps4"] and (emu_dirs["shadps4"] .. "/user/trophy"),
    emu_dirs["shadps4"] and (emu_dirs["shadps4"] .. "/home/1000/trophy"),
    appdata .. "/shadps4/user/trophy",
    appdata .. "/shadps4/home/1000/trophy",
    localappdata .. "/shadps4/user/trophy",
    emu_dirs["shadps4"] and (emu_dirs["shadps4"] .. "/shadps4.exe"),
    appdata .. "/shadps4/shadps4.exe",
    localappdata .. "/shadps4/shadps4.exe"
  )
  local shad_found, shad_p = false, nil
  for _, p in ipairs(shad_paths) do
    if p and file_exists(p) then
      shad_found = true
      shad_p = p
      break
    end
  end
  table.insert(list, {
    name = "shadPS4 (PS4)",
    detected = shad_found,
    path = shad_p or (emu_dirs["shadps4"]),
    username = shad_found and "Local Trophy DB" or nil,
    authenticated = shad_found,
  })

  -- Check .env fallback
  local web_cfg = require("web_config")
  local env_creds = web_cfg.get_retroachievements_credentials and web_cfg.get_retroachievements_credentials()
  local env_fallback = (env_creds and env_creds.token ~= nil and #env_creds.token > 0) or false
  local env_username = env_creds and env_creds.username or nil

  return {
    emulators = list,
    env_fallback = env_fallback,
    env_username = env_username,
  }
end

return M
