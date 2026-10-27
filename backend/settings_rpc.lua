--- Settings mirror facade (ADR-0090): the backend's second copy of the plugin's settings (settings_store.lua).
local core     = require("rpc")
local settings = require("settings_store")

local method = core.method

local M = {}

--- {} -> { values = { <key> = <value> } }
M.GetSettings = method("GetSettings", function(_)
  return { values = settings.get_all() }
end)

--- { values = { <key> = <value> }, remove = { <key>, ... } } -> { changed = n }
M.SaveSettings = method("SaveSettings", function(data)
  return { changed = settings.apply(data.values, data.remove) }
end)

return M
