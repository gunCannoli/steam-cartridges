--- The plugin's own data folder: <Steam>/millennium/config/steam-cartridges
---
--- ADR-0032. Holds .env (credentials), sgdb_key.txt, library_metadata.json and
--- the migration marker. The folder name is hardcoded on purpose: it must not
--- change if the plugin folder is renamed or deployed as `-dev`.
---
--- Paths are built with forward slashes only (Windows accepts them, and a stray
--- backslash in a Lua string literal is a syntax error that crashes Steam).

local fs         = require("fs")
local millennium = require("millennium")

local data_dir = {}

local cached = nil

local function normalize(p)
  return (tostring(p):gsub("\\", "/"))
end

--- Absolute path of the data folder, created on first use.
---@return string
function data_dir.path()
  if cached then return cached end
  local ok, sp = pcall(millennium.steam_path)
  local base = (ok and sp and #sp > 0) and normalize(sp) or "."
  base = base:gsub("/+$", "")
  local dir = base .. "/millennium/config/steam-cartridges"
  pcall(function()
    if not fs.is_directory(dir) then fs.create_directories(dir) end
  end)
  cached = dir
  return dir
end

--- Join a file name onto the data folder.
---@param name string
---@return string
function data_dir.file(name)
  return data_dir.path() .. "/" .. name
end

--- Test hook: forget the cached path.
function data_dir._reset()
  cached = nil
end

return data_dir
