--- The plugin's own log file: <Steam>/millennium/config/steam-cartridges/steam-cartridges.log
---
--- Millennium's `logger` goes to a console the player never sees, so a report like "the IGDB details did not
--- fetch" had nothing to check. install() puts a tee in place of the `logger` module, so every backend module that
--- already logs (`logger:info(...)`) also writes here, and `event` adds the decisions and requests that were silent
--- (which source answered, what an outgoing request returned).
---
--- One file plus one rotated copy (`.1`), capped, with secrets scrubbed before anything is written: the player can
--- share it as it is (Settings > Support). Never throws: a log must not break the thing it observes.

local M = {}

M.MAX_BYTES  = 2 * 1024 * 1024 -- beta verbosity: reports need depth more than disk (was 512 KiB)
M.CHECK_EVERY = 100       -- writes between size checks

--- Injectable for tests. nil = the real dependency.
M.deps = {
  path = nil, -- nil = data_dir.file("steam-cartridges.log")
  now = nil,  -- nil = os.time
}

local installed = false
local writes = 0
local errors = 0
local original = nil

local function log_path()
  if M.deps.path then return M.deps.path end
  return require("data_dir").file("steam-cartridges.log")
end

--- The values this PC has saved that must never be written, wherever they show up in a line: every account name,
--- key, token and secret, and the Steam account id. Read from the plugin's own settings, refreshed every 30 s and when
--- credentials are saved (forget_known). A value shorter than 3 characters is not matched (it would hit ordinary words).
local known, known_at, collecting = {}, 0, false

function M.forget_known() known_at = 0 end

local function known_values()
  local t = (M.deps.now or os.time)()
  if collecting or (known_at ~= 0 and t - known_at < 30) then return known end
  collecting = true
  local list = {}
  local function add(v)
    if type(v) == "string" and #v >= 3 then list[#list + 1] = v end
  end
  pcall(function()
    local config = require("web_config")
    local tw = config.get_twitch_credentials()
    if tw then add(tw.client_id) add(tw.client_secret) end
    local ss = config.get_screenscraper_credentials()
    if ss then add(ss.user) add(ss.pass) add(ss.dev_user) add(ss.dev_pw) end
    local ra = config.get_retroachievements_credentials()
    if ra then add(ra.username) add(ra.token) add(ra.api_key) end
    add(config.get_api_key())
  end)
  pcall(function()
    local paths = require("steam_paths").resolve()
    if paths and paths.user_id then add(tostring(paths.user_id)) end
  end)
  -- Longest first, so a value that contains another is hidden whole.
  table.sort(list, function(a, b) return #a > #b end)
  known, known_at, collecting = list, t == 0 and 1 or t, false
  return known
end

--- Secrets and personal data out of a line. Order matters: the saved values first, then the query-string forms.
---@param s string
---@return string
function M.redact(s)
  s = tostring(s)
  for _, v in ipairs(known_values()) do
    local from = 1
    while true do
      local a, b = s:find(v, from, true)
      if not a then break end
      s = s:sub(1, a - 1) .. "<hidden>" .. s:sub(b + 1)
      from = a + #"<hidden>"
    end
  end
  s = s:gsub("[%w%._%%%+%-]+@[%w%.%-]+%.%a%a+", "<email>")
  s = s:gsub("([Uu][Ss][Ee][Rr][Dd][Aa][Tt][Aa][\\/])%d+", "%1<id>")
  -- A Steam account id written before the saved values are known (the first line of a session, logged while they load):
  -- "(user 12345678)", "user_id=12345678", "user id: 12345678".
  s = s:gsub("([Uu][Ss][Ee][Rr][%s_]*[Ii]?[Dd]?[%s:=]*)(%d%d%d%d%d+)", "%1<id>")
  -- Query/form parameters that carry a credential or a username: ScreenScraper (devid/devpassword/ssid/sspassword),
  -- RetroAchievements (z = user, y = key), Twitch (client_secret), SteamGridDB/others (api_key, token).
  for _, key in ipairs({ "devid", "devpassword", "ssid", "sspassword", "softname", "client_secret", "client_id",
      "api_key", "apikey", "token", "access_token", "password", "pass", "y", "z", "u", "t" }) do
    s = s:gsub("([%?&;]" .. key .. "=)[^&%s\"']*", "%1<hidden>")
  end
  s = s:gsub("([Bb]earer%s+)[%w%-%._~%+/=]+", "%1<hidden>")
  s = s:gsub("([Aa]uthorization%s*[:=]%s*)[^\r\n]+", "%1<hidden>")
  s = s:gsub("([Cc]lient%-[Ii][Dd]%s*[:=]%s*)[^\r\n,]+", "%1<hidden>")
  -- Windows user name in a path.
  s = s:gsub("([Uu][Ss][Ee][Rr][Ss][\\/])([^\\/%s\"']+)", "%1<user>")
  -- Linux home folder.
  s = s:gsub("(/home/)([^/%s\"']+)", "%1<user>")
  return s
end

local function stamp()
  local t = (M.deps.now or os.time)()
  return os.date("%Y-%m-%d %H:%M:%S", t)
end

--- The start-up and host lines of this session (already redacted), kept in memory. A log that rotated, or a copy cut to its last
--- part, loses its head, and the head says which OS, Steam, Flatpak and tools the rest was run on: the pinned lines are written
--- again at the top of a fresh file after a rotation and put in front of a shared tail that no longer holds them.
local pinned, pinned_seen = {}, {}
M.PIN_AREAS = { startup = true, host = true }
M.PIN_MAX = 40

local function pin(text)
  if pinned_seen[text] or #pinned >= M.PIN_MAX then return end
  pinned_seen[text] = true
  pinned[#pinned + 1] = text
end

local function pinned_block(title)
  if #pinned == 0 then return "" end
  return stamp() .. " [INFO] ---- " .. title .. " ----\n" .. table.concat(pinned, "\n") .. "\n"
end

local function rotate_if_big(path)
  local f = io.open(path, "rb")
  if not f then return end
  local size = f:seek("end")
  f:close()
  if size and size > M.MAX_BYTES then
    os.remove(path .. ".1")
    os.rename(path, path .. ".1")
    local nf = io.open(path, "ab")
    if nf then nf:write(pinned_block("session header, repeated after a rotation")); nf:close() end
  end
end

--- Append one line. level: "INFO" | "WARN" | "ERROR" | "EVENT".
---@param level string
---@param msg any
function M.write(level, msg)
  if not installed then return end
  if level == "ERROR" then errors = errors + 1 end -- nothing is written before main.lua installs the log (offline tests stay clean)
  pcall(function()
    local path = log_path()
    writes = writes + 1
    if writes == 1 or writes % M.CHECK_EVERY == 0 then rotate_if_big(path) end
    local f = io.open(path, "ab")
    if not f then return end
    local text = M.redact(msg):gsub("[\r\n]+", " | ")
    if #text > 2000 then text = text:sub(1, 2000) .. "...(" .. #text .. " chars)" end
    local line = stamp() .. " [" .. level .. "] " .. text
    f:write(line, "\n")
    f:close()
    local area = text:match("^%[([%w_%-]+)%]")
    if level == "EVENT" and area and M.PIN_AREAS[area] then pin(line) end
  end)
end

--- A decision or a request worth knowing about: `area` is the part of the plugin ("metadata", "net", "igdb", ...).
---@param area string
---@param msg any
function M.event(area, msg)
  M.write("EVENT", "[" .. tostring(area) .. "] " .. tostring(msg))
end

--- Replace the `logger` module with a tee: Millennium's logger still gets every call (its console is unchanged),
--- and so does the file. Call once, before any other backend module is required.
function M.install()
  if installed then return end
  installed = true
  original = package.loaded["logger"]
  if original == nil then
    local ok, mod = pcall(require, "logger")
    original = ok and mod or nil
  end
  local tee = {}
  for _, level in ipairs({ "info", "warn", "error", "debug" }) do
    tee[level] = function(_, msg)
      if level ~= "debug" then M.write(level:upper(), msg) end
      local fn = original and original[level]
      if fn then return fn(original, msg) end
    end
  end
  package.loaded["logger"] = tee
  M.write("INFO", "---- log started ----")
end

--- Test hook.
function M._reset()
  known, known_at = {}, 0
  errors = 0
  pinned, pinned_seen = {}, {}
  if installed and original ~= nil then package.loaded["logger"] = original end
  installed, writes, original = false, 0, nil
end

local function read_all(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local body = f:read("*a")
  f:close()
  return body
end

--- The newest part of the log (the rotated copy first, when the file alone is short).
---@param max_bytes number|nil
---@return string
function M.tail(max_bytes)
  max_bytes = max_bytes or 200 * 1024
  local path = log_path()
  local body = read_all(path) or ""
  if #body < max_bytes then
    local older = read_all(path .. ".1")
    if older then body = older .. body end
  end
  if #body > max_bytes then
    body = body:sub(-max_bytes)
    local nl = body:find("\n", 1, true)
    if nl then body = body:sub(nl + 1) end
  end
  -- The head of the session is gone from this part: put it back in front, said plainly.
  if #pinned > 0 and not body:find(pinned[1], 1, true) then
    body = pinned_block("session header (from this session's start, the log below was cut)") .. body
  end
  return body
end

function M.path() return log_path() end
--- ERROR lines written this session (the unload summary reports it).
function M.error_count() return errors end

--- Remove the log (both files). Used by Settings > Support > Clear.
function M.clear()
  pcall(os.remove, log_path())
  pcall(os.remove, log_path() .. ".1")
  M.write("INFO", "---- log cleared ----")
end

return M
