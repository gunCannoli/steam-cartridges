--- Frontend events in the plugin log (ADR-0094): the frontend's own logger does not reach the log file users share, so the few events
--- that explain a report (an onboarding step, a rule saved, a source added) are sent here. Counts and names of features only; the
--- facade refuses anything that looks like free text from a user (length, characters).
local core = require("rpc")

local method = core.method

local M = {}

--- { tag = "onboarding", message = "step 3 reached (sources on: 2, rules: 1)" } -> { ok }
M.ClientLog = method("ClientLog", function(data)
  local tag = type(data.tag) == "string" and data.tag:match("^[%w_%-]+$") and #data.tag <= 24 and data.tag or "ui"
  local msg = tostring(data.message or ""):gsub("[%c]", " "):sub(1, 200)
  -- A finished sweep also says how the network did, so a run's result and its cause sit on one line.
  if msg:find("^Find matches:") then
    local ok, sum = pcall(function() return require("net").summary() end)
    if ok and sum and sum ~= "" then msg = msg .. " | net: " .. sum end
  end
  require("plog").event(tag, msg)
  return { ok = true }
end)

return M
