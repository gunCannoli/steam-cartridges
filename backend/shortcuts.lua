--- Parses Steam's binary shortcuts.vdf (non-Steam game entries).
---
--- Format: a tree of type-tagged fields. Each field is
---   <type byte> <NUL-terminated key> <value>
--- where type is 0x00 = nested map (value is fields until 0x08),
---              0x01 = NUL-terminated string,
---              0x02 = little-endian int32.
---
--- We do not need a full VDF implementation - scanning for the type markers and
--- picking out the handful of fields we care about is enough, and is resilient
--- to Steam adding new fields (which it does regularly).

local utils = require("utils")
local fs    = require("fs")

local shortcuts = {}

local TYPE_MAP    = 0x00
local TYPE_STRING = 0x01
local TYPE_INT32  = 0x02
local TYPE_END    = 0x08

--- Fields we keep. Keys in the file vary in case between Steam versions
--- (AppName/appname), so we compare lowercased.
local WANTED = {
  appid         = "appid",
  appname       = "name",
  exe           = "exe",
  startdir      = "start_dir",
  launchoptions = "launch_options",
  icon          = "icon",
  lastplaytime  = "last_play_time",
}

---Read a little-endian int32 at (1-based) offset.
---@param data string
---@param offset integer
---@return integer value
local function read_int32(data, offset)
  local b1, b2, b3, b4 = data:byte(offset, offset + 3)
  if not b4 then return 0 end
  return b1 + b2 * 0x100 + b3 * 0x10000 + b4 * 0x1000000
end

local cache = { mtime = -1, entries = nil } ---@type table

--- Parse every shortcut entry in the file.
---@param path string Path to shortcuts.vdf
---@return table[]|nil entries
---@return string? error
function shortcuts.parse(path)
  if not fs.is_file(path) then
    -- A user with no non-Steam games simply has no file. Not an error.
    return {}
  end

  local mtime = fs.last_write_time(path) or 0
  if cache.entries and cache.mtime == mtime then
    return cache.entries
  end

  local data, err = utils.read_file(path)
  if not data then
    return nil, "could not read shortcuts.vdf: " .. tostring(err)
  end

  local entries = {}
  local current = nil
  local i = 1
  local len = #data

  while i <= len do
    local t = data:byte(i)

    if t == TYPE_STRING or t == TYPE_INT32 then
      local key_end = data:find("\0", i + 1, true)
      if not key_end then break end

      local key = data:sub(i + 1, key_end - 1):lower()
      local field = WANTED[key]

      if t == TYPE_INT32 then
        local value = read_int32(data, key_end + 1)
        i = key_end + 5

        if key == "appid" then
          -- A new appid field starts a new entry. Stored as a signed int32 but
          -- used as unsigned; read_int32 already returns the unsigned value.
          current = { appid = value }
          entries[#entries + 1] = current
        elseif current and field then
          current[field] = value
        end
      else
        local value_end = data:find("\0", key_end + 1, true)
        if not value_end then break end

        if current and field then
          current[field] = data:sub(key_end + 1, value_end - 1)
        elseif current and tonumber(key) then
          current.tags = current.tags or {}
          table.insert(current.tags, data:sub(key_end + 1, value_end - 1))
        end
        i = value_end + 1
      end
    elseif t == TYPE_MAP or t == TYPE_END then
      i = i + 1
    else
      -- Tag bytes only appear where a field starts; anything else is payload
      -- we have already consumed, or padding. Skip it.
      i = i + 1
    end
  end

  -- Drop anything that never got a usable identity.
  local cleaned = {}
  for _, entry in ipairs(entries) do
    if entry.appid and entry.appid > 0 then
      entry.name = entry.name or ""
      entry.exe = entry.exe or ""
      cleaned[#cleaned + 1] = entry
    end
  end

  cache.mtime = mtime
  cache.entries = cleaned
  return cleaned
end

--- Index shortcuts by appid for O(1) lookup.
---@param entries table[]
---@return table<integer, table>
function shortcuts.by_appid(entries)
  local index = {}
  for _, entry in ipairs(entries) do
    index[entry.appid] = entry
  end
  return index
end

return shortcuts
