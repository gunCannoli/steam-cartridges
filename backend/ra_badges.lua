--- steam-cartridges - RetroAchievements badges as achievement icons for packs (a pack's `ra_icon`, ADR-0082).
---
--- A badge is https://media.retroachievements.org/Badge/<name>.png (64x64, public, no key). The plugin ships only the
--- names a pack lists; the player's machine fetches the art, and only while the player has a RetroAchievements key in
--- the plugin's .env (the user's decision: no key, no request). Each badge is shrunk like any other pack icon and kept
--- as a `data:` URL under <data dir>/ra_badges/<name>.txt, so a restart or a rebuilt schema never fetches it again.
---
--- Fetching is sequential (one request at a time, through net.get_binary and its circuit breaker), at most PER_CALL
--- badges and BUDGET_S seconds per call; the rest wait for the next page view. A badge that fails is left alone for
--- RETRY_S; two failures in a row stop the call and pause every badge for RETRY_S. Called from the schema build only
--- (src_native_ports.fetch), never from the 2 s poll. Nothing here logs or stores the key.

local M = {}

M.URL = "https://media.retroachievements.org/Badge/%s.png"
M.MAX_NAME = 16        -- a badge name is digits (sometimes letters): never a path
M.MAX_BYTES = 256 * 1024
M.PER_CALL = 12
M.BUDGET_S = 10
M.RETRY_S = 10 * 60
M.STOP_AFTER_FAILURES = 2

--- Injectable for tests. nil = the real dependency.
M.deps = {
  key = nil,      -- fun() -> boolean ; nil = a RetroAchievements key is in the plugin's .env
  get = nil,      -- fun(url, opts) -> { status, body } | nil, err ; nil = net.get_binary
  icon_url = nil, -- fun(png, size) -> data URL | nil ; nil = trophy_pack_icons.icon_url
  read = nil,     -- fun(name) -> cached data URL | nil
  write = nil,    -- fun(name, data_url)
  now = nil,      -- fun() -> seconds
}

local failed = {}       -- name -> epoch seconds before which it is not tried again
local paused_until = 0  -- every badge, after repeated failures

local function now()
  if M.deps.now then return M.deps.now() end
  return os.time()
end

function M._reset() failed, paused_until = {}, 0 end

--- Whether a badge name is safe to put in a URL: letters and digits, short.
function M.valid(name)
  return type(name) == "string" and #name >= 1 and #name <= M.MAX_NAME and name:match("^%w+$") ~= nil
end

--- Whether the player has a RetroAchievements key (the gate; the key itself is never read here).
function M.enabled()
  if M.deps.key then return M.deps.key() and true or false end
  local ok, creds = pcall(function() return require("web_config").get_retroachievements_credentials() end)
  return ok and creds ~= nil
end

local function cache_file(name) return require("data_dir").file("ra_badges/" .. name .. ".txt") end

local function read_cache(name)
  if M.deps.read then return M.deps.read(name) end
  local text = require("utils").read_file(cache_file(name))
  if type(text) == "string" and text:sub(1, 22) == "data:image/png;base64," then return text end
  return nil
end

local function write_cache(name, url)
  if M.deps.write then return M.deps.write(name, url) end
  local dir = require("data_dir").file("ra_badges")
  local fs = require("fs")
  pcall(function() if not fs.is_directory(dir) then fs.create_directories(dir) end end)
  pcall(require("utils").write_file, cache_file(name), url)
end

--- Whether the badge can become an icon now: a key, and (cached, or not waiting out a failure).
function M.available(name)
  if not M.valid(name) or not M.enabled() then return false end
  if read_cache(name) then return true end
  return now() >= paused_until and now() >= (failed[name] or 0)
end

local function download(name)
  local get = M.deps.get or function(url, opts) return require("net").get_binary(url, opts) end
  local ok, res = pcall(get, M.URL:format(name), { source = "ra-badges", max_bytes = M.MAX_BYTES })
  if not ok or type(res) ~= "table" or tonumber(res.status) ~= 200 or type(res.body) ~= "string" then return nil end
  local icon_url = M.deps.icon_url or function(png, size) return require("trophy_pack_icons").icon_url(png, size) end
  local oku, url = pcall(icon_url, res.body, 64)
  if oku and type(url) == "string" then return url end
  return nil
end

--- The data URLs of `names` ({ [name] = data URL }): cached ones always, new ones fetched within the limits above.
--- Nothing at all without a key.
function M.fetch(names)
  local out = {}
  if not M.enabled() then return out end
  local started, tried, strikes = now(), 0, 0
  for _, name in ipairs(names) do
    if M.valid(name) and out[name] == nil then
      local url = read_cache(name)
      if url then
        out[name] = url
      elseif now() >= paused_until and now() >= (failed[name] or 0)
        and tried < M.PER_CALL and now() - started < M.BUDGET_S and strikes < M.STOP_AFTER_FAILURES then
        tried = tried + 1
        url = download(name)
        if url then
          strikes = 0
          out[name] = url
          write_cache(name, url)
        else
          strikes = strikes + 1
          failed[name] = now() + M.RETRY_S
          if strikes >= M.STOP_AFTER_FAILURES then paused_until = now() + M.RETRY_S end
        end
      end
    end
  end
  return out
end

return M
