--- Locates Steam's root and the active user's userdata directory.
---
--- Never hardcode paths: Steam is often installed outside the default
--- Program Files location; ask Millennium for the root instead.

local fs         = require("fs")
local utils      = require("utils")
local millennium = require("millennium")
local logger     = require("logger")

local steam_paths = {}

---@class steam_paths.Paths
---@field root string            Steam install root
---@field userdata string        <root>/userdata
---@field user_id string         Active user's 32-bit account id (directory name)
---@field user_root string       <root>/userdata/<user_id>
---@field shortcuts string       <user_root>/config/shortcuts.vdf
---@field screenshots_vdf string <user_root>/760/screenshots.vdf
---@field screenshots_root string <user_root>/760/remote
---@field recordings string      <user_root>/gamerecordings

local cached = nil ---@type steam_paths.Paths|nil

--- Userdata contains numeric account dirs plus a few non-account entries
--- ("ugc", "config", ...). Only digits can be an account id.
---@param name string
---@return boolean
local function is_account_dir(name)
  return name:match("^%d+$") ~= nil
end

--- Steam records the most recently used account in loginusers.vdf as a 64-bit
--- SteamID. Userdata directories are named with the 32-bit account id, which is
--- the low 32 bits of that value.
---@param root string
---@return string|nil account_id
local function most_recent_user(root)
  local path = fs.join(root, "config", "loginusers.vdf")
  local content = utils.read_file(path)
  if not content then return nil end

  -- Walk block by block, remembering the last seen id until we hit the
  -- MostRecent flag that belongs to it.
  local current = nil
  for line in content:gmatch("[^\r\n]+") do
    local id = line:match('^%s*"(%d%d+)"%s*$')
    if id then
      current = id
    else
      local most_recent = line:match('"MostRecent"%s*"(%d)"')
      if most_recent == "1" and current then
        -- 64-bit SteamID -> 32-bit account id (low dword).
        local account = tonumber(current) % 4294967296
        return string.format("%d", account)
      end
    end
  end
  return nil
end

--- Falls back to whichever account directory was written to most recently.
---@param userdata string
---@return string|nil account_id
local function newest_user(userdata)
  local entries = fs.list(userdata)
  if not entries then return nil end

  local best, best_time = nil, -1
  for _, entry in ipairs(entries) do
    if entry.is_directory and is_account_dir(entry.name) then
      local mtime = fs.last_write_time(entry.path) or 0
      if mtime > best_time then
        best, best_time = entry.name, mtime
      end
    end
  end
  return best
end

--- Resolve all paths we care about. Cached after the first successful call.
---@param force? boolean Recompute even if cached
---@return steam_paths.Paths|nil paths
---@return string? error
function steam_paths.resolve(force)
  if cached and not force then return cached end

  local root = millennium.steam_path()
  if not root or root == "" then
    return nil, "could not determine Steam path"
  end

  local userdata = fs.join(root, "userdata")
  if not fs.is_directory(userdata) then
    return nil, "userdata directory not found at " .. userdata
  end

  local user_id = most_recent_user(root)
  if user_id and not fs.is_directory(fs.join(userdata, user_id)) then
    -- loginusers.vdf can name an account whose local data was removed.
    logger:warn("most recent user " .. user_id .. " has no userdata directory, falling back")
    user_id = nil
  end
  user_id = user_id or newest_user(userdata)

  if not user_id then
    return nil, "no Steam user directory found in " .. userdata
  end

  local user_root = fs.join(userdata, user_id)
  cached = {
    root             = root,
    userdata         = userdata,
    user_id          = user_id,
    user_root        = user_root,
    shortcuts        = fs.join(user_root, "config", "shortcuts.vdf"),
    screenshots_vdf  = fs.join(user_root, "760", "screenshots.vdf"),
    screenshots_root = fs.join(user_root, "760", "remote"),
    recordings       = fs.join(user_root, "gamerecordings"),
  }

  logger:info("Steam root: " .. root .. " (user " .. user_id .. ")")
  return cached
end

return steam_paths
