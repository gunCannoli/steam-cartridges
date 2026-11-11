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
local signed_in = nil ---@type string|nil  the account Steam's own window says is signed in (32-bit id, digits)

--- The signed-in account as Steam's frontend reports it. It beats loginusers.vdf (which can name nobody, or an
--- old account) and the newest-folder guess. Returns true when it changed which user the paths point at.
---@param account any  digits, or nil to forget
---@return boolean changed
function steam_paths.set_signed_in(account)
  local text = (type(account) == "number" or type(account) == "string") and string.format("%d", tonumber(account) or 0) or nil
  if text == "0" then text = nil end
  if text == signed_in then return false end
  local before = cached and cached.user_id
  signed_in = text
  cached = nil
  local paths = steam_paths.resolve()
  return (paths and paths.user_id) ~= before
end

--- Userdata contains numeric account dirs plus a few non-account entries
--- ("ugc", "config", ...). Only digits can be an account id.
---@param name string
---@return boolean
local function is_account_dir(name)
  -- "0" is Steam's placeholder folder (no account, no shortcuts.vdf); it is often the newest
  -- one and must never be taken as the user (log: "user 0", shortcuts file NOT FOUND, 0 games).
  return name:match("^%d+$") ~= nil and tonumber(name) ~= 0
end

--- Steam records the most recently used account in loginusers.vdf as a 64-bit
--- SteamID. Userdata directories are named with the 32-bit account id, which is
--- the low 32 bits of that value.
---@param root string
---@return string|nil account_id
---@return table shape  what the file looked like (counts and yes/no only, for the log)
local function most_recent_user(root)
  local path = fs.join(root, "config", "loginusers.vdf")
  local content = utils.read_file(path)
  local shape = { file = content ~= nil, bytes = content and #content or 0, users = 0, flagged = 0 }
  if not content then return nil, shape end

  -- Walk block by block, remembering the last seen id until we hit the MostRecent flag that belongs to it.
  -- Every user block and every flag is counted, so a log can say whether the file is empty, has no user, or
  -- has users and none is marked (an edited, copied or emulated install).
  local current, found = nil, nil
  for line in content:gmatch("[^\r\n]+") do
    local id = line:match('^%s*"(%d%d+)"%s*$')
    if id then
      current = id
      shape.users = shape.users + 1
    else
      local most_recent = line:match('"[Mm]ost[Rr]ecent"%s*"(%d)"')
      if most_recent == "1" then
        shape.flagged = shape.flagged + 1
        if current and not found then
          -- 64-bit SteamID -> 32-bit account id (low dword).
          found = string.format("%d", tonumber(current) % 4294967296)
        end
      end
    end
  end
  return found, shape
end

--- Falls back to whichever account directory was written to most recently. An account folder that holds a
--- shortcuts.vdf beats a newer one without.
---@param userdata string
---@return string|nil account_id
---@return table census  how the userdata folders look (counts and yes/no only, for the log)
local function newest_user(userdata)
  local entries = fs.list(userdata)
  local census = { accounts = 0, placeholder = false, with_shortcuts = 0 }
  if not entries then return nil, census end

  local best, best_time, best_has = nil, -1, false
  for _, entry in ipairs(entries) do
    if entry.is_directory and entry.name == "0" then census.placeholder = true end
    if entry.is_directory and is_account_dir(entry.name) then
      local mtime = fs.last_write_time(entry.path) or 0
      local has = fs.exists(fs.join(entry.path, "config", "shortcuts.vdf")) and true or false
      census.accounts = census.accounts + 1
      if has then census.with_shortcuts = census.with_shortcuts + 1 end
      if (has and not best_has) or (has == best_has and mtime > best_time) then
        best, best_time, best_has = entry.name, mtime, has
      end
    end
  end
  return best, census
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

  local login_user, shape = most_recent_user(root)
  local named = login_user ~= nil
  local named_dir, named_shortcuts
  if login_user then
    named_dir = fs.is_directory(fs.join(userdata, login_user))
    named_shortcuts = named_dir and fs.exists(fs.join(userdata, login_user, "config", "shortcuts.vdf")) and true or false
    if not named_dir then
      -- loginusers.vdf can name an account whose local data was removed.
      logger:warn("most recent user " .. login_user .. " has no userdata directory, falling back")
    end
  end
  -- Steam's own window says who is signed in: that wins over the file and the guess.
  local signed_dir = signed_in ~= nil and fs.is_directory(fs.join(userdata, signed_in))
  local newest, census = newest_user(userdata)

  local user_id, via
  if signed_dir then
    user_id, via = signed_in, "signed-in"
  elseif named_dir then
    user_id, via = login_user, "loginusers"
  elseif newest then
    user_id, via = newest, "newest-folder"
  else
    via = "none"
  end

  steam_paths.last_diagnosis = {
    via = via, login = shape, census = census,
    signed_reported = signed_in ~= nil, signed_dir = signed_dir,
    named = named, named_dir = named_dir, named_shortcuts = named_shortcuts,
    disagree = signed_dir and named and named_dir and login_user ~= signed_in,
    config_dir = fs.is_directory(fs.join(root, "config")),
  }

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

--- What the last resolve() saw, as log text. Counts and yes/no only (no id, no path, no name): a log from a custom, portable
--- or emulated Steam install says which of Steam's own files were missing or odd, with no need to ask the reporter for them.
---@return string line   one `[startup]` line
---@return string[] odd  each inconsistency worth a WARN line (empty when the folders look normal)
function steam_paths.diagnosis()
  local d = steam_paths.last_diagnosis
  if not d then return "steam folders: not resolved", { "Steam's folders were never resolved" } end
  local l, c = d.login, d.census
  local function yn(v) if v == nil then return "n/a" end return v and "yes" or "no" end
  local line = string.format(
    "steam folders: user chosen via=%s; loginusers.vdf: present=%s, bytes=%d, users=%d, marked most-recent=%d, names a user=%s, its folder=%s, its shortcuts.vdf=%s; signed-in user reported by Steam=%s, its folder=%s; userdata: accounts=%d, with shortcuts.vdf=%d, placeholder 0=%s; config folder=%s",
    d.via, yn(l.file), l.bytes, l.users, l.flagged, yn(d.named), yn(d.named_dir), yn(d.named_shortcuts), yn(d.signed_reported), d.signed_reported and yn(d.signed_dir) or "n/a",
    c.accounts, c.with_shortcuts, yn(c.placeholder), yn(d.config_dir))
  local odd = {}
  if not l.file then odd[#odd + 1] = "loginusers.vdf is missing: this looks like a portable, copied or emulated Steam folder" end
  if l.file and l.users == 0 then odd[#odd + 1] = "loginusers.vdf has no user block (empty, or a format this plugin does not read)" end
  if l.file and l.users > 0 and l.flagged == 0 then odd[#odd + 1] = "loginusers.vdf has users but none is marked most-recent" end
  if l.flagged > 1 then odd[#odd + 1] = "loginusers.vdf marks " .. l.flagged .. " users as most-recent" end
  if d.named and not d.named_dir then odd[#odd + 1] = "loginusers.vdf names a user that has no userdata folder" end
  if d.named and d.named_dir and not d.named_shortcuts and c.with_shortcuts > 0 then
    odd[#odd + 1] = "the user loginusers.vdf names has no shortcuts.vdf while another account folder has one"
  end
  if d.signed_reported and not d.signed_dir then odd[#odd + 1] = "Steam reports a signed-in user that has no userdata folder" end
  if d.disagree then odd[#odd + 1] = "loginusers.vdf names a different user than the one signed in (the signed-in user is used)" end
  if c.accounts == 0 then odd[#odd + 1] = "userdata has no account folder" end
  if c.accounts > 0 and c.with_shortcuts == 0 then odd[#odd + 1] = "no account folder has a shortcuts.vdf: no non-Steam game can be read" end
  if c.with_shortcuts > 1 then odd[#odd + 1] = c.with_shortcuts .. " account folders have a shortcuts.vdf: only one is read" end
  return line, odd
end

return steam_paths
