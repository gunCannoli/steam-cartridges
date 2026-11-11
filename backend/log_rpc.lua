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

--- The account Steam's own window says is signed in (its 32-bit id) -> { ok, changed }. It decides whose userdata folder is read
--- when loginusers.vdf names nobody; when it changes the user, the new folder picture goes to the log.
local reported = false
M.SetSignedInAccount = method("SetSignedInAccount", function(data)
  local sp = require("steam_paths")
  local changed = sp.set_signed_in(data.account)
  -- The first report of a session is always logged (a log then shows which source decided); a later one only when it moves the user.
  if changed or not reported then
    reported = true
    local plog = require("plog")
    local line, odd = sp.diagnosis()
    plog.event("startup", (changed and "the signed-in user reported by Steam changed which folder is read; "
      or "the signed-in user reported by Steam matches the folder read; ") .. line)
    for _, what in ipairs(odd) do plog.event("startup", "steam folders: " .. what) end
  end
  return { ok = true, changed = changed }
end)

return M
