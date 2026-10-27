--- Which OS the backend runs on, and the per-user folders every emulator and engine keeps its files in.
---
--- Guardrail 23 (plugins.md): no other module reads %APPDATA% / %LOCALAPPDATA% / %USERPROFILE% itself. They ask here, so one
--- spelling works on Windows and Linux:
---
---   name           Windows                        Linux (XDG)
---   APPDATA        %APPDATA%                      $XDG_CONFIG_HOME or ~/.config
---   LOCALAPPDATA   %LOCALAPPDATA%                 $XDG_DATA_HOME   or ~/.local/share
---   USERPROFILE    %USERPROFILE%                  $HOME
---
--- Any other name is read from the environment as it is. Linux file names are case sensitive: a Linux emulator keeps its folder
--- in the case its own docs use (`retroarch`, `duckstation`, `dolphin-emu`), so callers list the Linux spellings separately.
--- Paths are built with "/" only (Windows accepts it).

local M = {}

M.deps = {
  getenv = nil,     -- fun(name) -> string | nil ; nil = os.getenv
  is_windows = nil, -- boolean ; nil = detect from the path separator
}

local function env(name)
  local v = (M.deps.getenv or os.getenv)(name)
  if type(v) == "string" and v ~= "" then return v end
  return nil
end

local function slashes(p) return (tostring(p):gsub("\\", "/"):gsub("/+$", "")) end

---@return boolean
function M.is_windows()
  if M.deps.is_windows ~= nil then return M.deps.is_windows end
  return package.config:sub(1, 1) == "\\"
end

--- "windows" or "linux" (anything not Windows is treated as a Unix with XDG folders).
function M.os_name()
  return M.is_windows() and "windows" or "linux"
end

--- The user's home folder, "" when the environment does not say.
function M.home()
  return slashes(M.is_windows() and (env("USERPROFILE") or "") or (env("HOME") or ""))
end

local ROOTS = {
  APPDATA = function()
    local x = env("XDG_CONFIG_HOME")
    if x then return slashes(x) end
    local h = M.home()
    return h ~= "" and (h .. "/.config") or nil
  end,
  LOCALAPPDATA = function()
    local x = env("XDG_DATA_HOME")
    if x then return slashes(x) end
    local h = M.home()
    return h ~= "" and (h .. "/.local/share") or nil
  end,
  USERPROFILE = function()
    local h = M.home()
    return h ~= "" and h or nil
  end,
}

--- Environment variable by its Windows name; on Linux the three user folders map to their XDG counterparts.
---@param name string
---@return string|nil
function M.getenv(name)
  local map = ROOTS[name]
  if map and not M.is_windows() then return map() end
  return env(name)
end

--- Join parts with "/" (no doubled or trailing slash, backslashes turned into "/"); empty parts are skipped.
function M.join(...)
  local out = {}
  for _, part in ipairs({ ... }) do
    local s = slashes(part)
    if s ~= "" then out[#out + 1] = (#out > 0) and s:gsub("^/+", "") or s end
  end
  return table.concat(out, "/")
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Finding a file whose spelling we do not know (Linux is case sensitive; emulators differ in folder names and roots)
-- ---------------------------------------------------------------------------------------------------------------------

M.deps.list = nil -- fun(dir) -> { names } | nil ; nil = Millennium's fs.list

local function names_in(dir)
  if M.deps.list then return M.deps.list(dir) end
  local ok, fs = pcall(require, "fs")
  if not ok then return nil end
  local okl, entries = pcall(fs.list, dir)
  if not okl or type(entries) ~= "table" then return nil end
  local out = {}
  for _, e in ipairs(entries) do
    if type(e) == "table" and type(e.name) == "string" then out[#out + 1] = e.name end
  end
  return out
end

--- `rel` ("RetroArch/logs/retroarch.log") under `root`, each part matched exactly first and otherwise ignoring case.
--- Returns the real path, or nil. Reads only the folders on the way.
---@param root string
---@param rel string
---@return string|nil
function M.resolve(root, rel)
  local cur = slashes(root)
  for part in tostring(rel):gsub("\\", "/"):gmatch("[^/]+") do
    local names = names_in(cur)
    if not names then return nil end
    local hit, fold = nil, part:lower()
    for _, n in ipairs(names) do
      if n == part then hit = n break end
      if not hit and n:lower() == fold then hit = n end
    end
    if not hit then return nil end
    cur = cur .. "/" .. hit
  end
  return cur
end

local roots_cache = nil

--- Every folder a program may keep its per-user files in, best first. Windows: the three user folders. Linux: XDG config,
--- XDG data, home, Documents, and the same inside each Flatpak app (`~/.var/app/<id>/config`, `.../data`).
---@return string[]
function M.user_roots()
  if roots_cache then return roots_cache end
  local out, seen = {}, {}
  local function add(p)
    if p and p ~= "" and not seen[p] then seen[p] = true out[#out + 1] = p end
  end
  add(M.getenv("APPDATA")); add(M.getenv("LOCALAPPDATA")); add(M.getenv("USERPROFILE"))
  local home = M.home()
  if home ~= "" then add(home .. "/Documents") end
  if not M.is_windows() and home ~= "" then
    add(home .. "/.config"); add(home .. "/.local/share")
    for _, id in ipairs(names_in(home .. "/.var/app") or {}) do
      add(home .. "/.var/app/" .. id .. "/config"); add(home .. "/.var/app/" .. id .. "/data")
    end
  end
  roots_cache = out
  return out
end

--- Forget the cached roots (tests, or a Flatpak installed while Steam runs).
function M.reset() roots_cache = nil end

--- The real paths of `rel` under every user root, for each spelling in `rels`, existing ones only, no duplicates.
--- On Windows the file system ignores case, so a plain existence test is enough there.
---@param rels string|string[]
---@param exists fun(path:string):boolean
---@return string[]
function M.locate(rels, exists)
  if type(rels) == "string" then rels = { rels } end
  local out, seen = {}, {}
  for _, root in ipairs(M.user_roots()) do
    for _, rel in ipairs(rels) do
      local p
      if M.is_windows() then
        p = root .. "/" .. rel
        if not exists(p) then p = nil end
      else
        p = M.resolve(root, rel)
      end
      if p and not seen[p] then seen[p] = true out[#out + 1] = p end
    end
  end
  return out
end

return M
