--- The plugin's own name and version, read from the deployed plugin.json.
---
--- The startup log needs it: a report without a version can only be dated by
--- behaviour ("the error is at steam_store_store.lua:62, so it predates the
--- fix"). The manifest sits next to backend/, so the backend finds it through
--- its own package.path entry (<plugin>/backend/?.lua), never a hardcoded folder.

local json  = require("json")
local utils = require("utils")

local M = {}

--- Test override: a full path to a manifest file.
M._path = nil

local function manifest_path()
  if M._path then return M._path end
  for entry in tostring(package.path or ""):gmatch("[^;]+") do
    local dir = entry:match("^(.*)[/\\]%?%.lua$")
    if dir and dir ~= "" and dir ~= "." then
      local parent = dir:match("^(.*)[/\\][^/\\]+$")
      if parent and parent ~= "" then return parent .. "/plugin.json" end
    end
  end
  return "plugin.json"
end

local function sane(v)
  if type(v) == "string" and v:match("^[%w%._%+%-]+$") and #v <= 64 then return v end
  return nil
end

--- { name, version }: "unknown" for whatever the manifest does not say. Never throws.
---@return { name: string, version: string }
function M.get()
  local text = utils.read_file(manifest_path())
  if type(text) ~= "string" or #text == 0 then return { name = "unknown", version = "unknown" } end
  local ok, data = pcall(json.decode, text)
  if not ok or type(data) ~= "table" then return { name = "unknown", version = "unknown" } end
  return { name = sane(data.name) or "unknown", version = sane(data.version) or "unknown" }
end

return M
