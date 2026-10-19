--- The shortcut library icon file (icon plan): our own copy of the chosen image, kept in the
--- plugin's data folder as <data dir>/icons/<appid>.<png|jpg|ico>, for the artwork surface to
--- hand to SteamClient.Apps.SetShortcutIcon (the only Steam write, ADR-0039). Steam's
--- <user>/config/grid/<appid>_icon.* files are left to the user and Steam ROM Manager.
---
--- Allowed hosts only (Steam CDN, SteamGridDB CDN), and the body is sniffed: a truncated or
--- non-image response is never written.

local fs       = require("fs")
local data_dir = require("data_dir")
local throttle = require("steam_store_throttle")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  download = nil, -- nil = Steam CDN through net (throttled), SteamGridDB through web_sgdb.download_image
  dir = nil,      -- nil = <data dir>/icons
}

local SHORTCUT_MIN = 0x80000000

--- "steam" | "sgdb" | nil (not allowed)
function M.host_kind(url)
  url = tostring(url or "")
  if url:match("^https://[%w%.%-]*steamstatic%.com/") then return "steam" end
  if url:match("^https://[%w%.%-]*steamgriddb%.com/") then return "sgdb" end
  return nil
end

--- The image type from its first bytes, or nil for anything else (a truncated body, an error page).
function M.sniff(body)
  if type(body) ~= "string" or #body < 100 then return nil end
  if body:sub(1, 8) == "\137PNG\r\n\26\n" then return "png" end
  if body:sub(1, 3) == "\255\216\255" then return "jpg" end
  if body:sub(1, 4) == "\0\0\1\0" then return "ico" end
  return nil
end

local function download(url, kind)
  if M.deps.download then return M.deps.download(url, kind) end
  if kind == "sgdb" then
    local res = require("web_sgdb").download_image(url)
    return res and res.body or nil
  end
  if throttle.is_offline() then return nil end
  throttle.acquire()
  local res = require("net").get(url, { source = "steam-store", headers = { ["User-Agent"] = throttle.USER_AGENT }, timeout = throttle.TIMEOUT })
  if not res or res.status ~= 200 then return nil end
  return res.body
end

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64_INDEX = {}
for i = 1, #B64 do B64_INDEX[B64:sub(i, i)] = i - 1 end

--- Raw bytes of a base64 string (padding and whitespace ignored), or nil when it is not base64.
function M.decode_base64(s)
  if type(s) ~= "string" then return nil end
  s = s:gsub("^data:[^,]*,", ""):gsub("[%s=]", "")
  if s == "" or s:find("[^%w%+/]") then return nil end
  local out, acc, bits = {}, 0, 0
  for i = 1, #s do
    acc = acc * 64 + B64_INDEX[s:sub(i, i)]
    bits = bits + 6
    if bits >= 8 then
      bits = bits - 8
      local div = 2 ^ bits
      out[#out + 1] = string.char(math.floor(acc / div))
      acc = acc % div
    end
  end
  return table.concat(out)
end

local function icons_dir()
  if M.deps.dir then return M.deps.dir end
  local dir = data_dir.path() .. "/icons"
  pcall(function()
    if not fs.is_directory(dir) then fs.create_directories(dir) end
  end)
  return dir
end

--- Download `url` and store it as this shortcut's icon file. Returns the absolute path in the
--- form Steam's own "Choose icon" dialog passes (backslashes on Windows), or nil, error.
function M.save(appid, url, base64)
  local n = tonumber(appid)
  if not n or n < SHORTCUT_MIN then return nil, "not a shortcut" end
  local kind = M.host_kind(url)
  if not kind then return nil, "url not allowed" end
  -- Millennium's Lua http.get cuts a binary body at its first NUL byte, so the frontend fetches the
  -- image and hands it over as base64; the download stays as the fallback for a caller without one.
  local body = base64 and M.decode_base64(base64) or download(url, kind)
  local ext = M.sniff(body)
  if not ext then return nil, "download failed" end
  local file = icons_dir() .. "/" .. tostring(math.floor(n)) .. "." .. ext
  local f = io.open(file, "wb")
  if not f then return nil, "could not write icon" end
  f:write(body)
  f:close()
  if file:match("^%a:") then file = file:gsub("/", "\\") end
  return file
end

return M
