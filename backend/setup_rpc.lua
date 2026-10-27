--- Library Setup facade (ADR-0086, plan § 5): whether the user has run setup, and marking it run.
---
--- The gate itself is not here: main.lua wires setup_store.done into net's gate, and record_rpc keeps EnsureFresh offline
--- until then. This module only answers and records.

local core  = require("rpc")
local setup = require("setup_store")

local method = core.method

local M = {}

--- {} -> { done, at, why }
M.GetSetupState = method("GetSetupState", function(_)
  local st = setup.get()
  return { done = st.done == true, onboarded = st.onboarded == true, at = st.at, why = st.why, version = st.version or 0, current = setup.ONBOARDING_VERSION }
end)

--- { done = true | false, onboarded = true | nil, skipped = true | nil, step = n | nil, pending = n | nil } -> state.
--- `done = true`: the user ran Detect (consent to fetch the games they validate). `onboarded = true`: the user finished the
--- Library Setup window, or skipped it (`skipped`); the line in the log says which, at which step, and how many games were
--- still pending in scope (no user data). `done = false` starts over.
M.SetSetupDone = method("SetSetupDone", function(data)
  local plog_ok, plog = pcall(require, "plog")
  if data.done == false then
    setup.clear()
    if plog_ok then plog.event("setup", "setup cleared") end
  elseif data.prompt == "run" or data.prompt == "skip" then
    -- The "new onboarding" prompt (ADR-0093); the data to clear was cleared by ResetPluginData before this.
    setup.answer_prompt(data.prompt == "run")
    if plog_ok then plog.event("onboarding", data.prompt == "run" and "new onboarding started by the user" or "new onboarding skipped by the user") end
  elseif data.onboarded == true then
    setup.mark_onboarded()
    if plog_ok then
      if data.skipped == true then
        plog.event("onboarding", string.format("skipped by user at step %s (pending in scope: %s)", tostring(tonumber(data.step) or "?"), tostring(tonumber(data.pending) or "?")))
      else
        plog.event("onboarding", string.format("completed (pending in scope: %s)", tostring(tonumber(data.pending) or "?")))
      end
    end
  else
    setup.mark_done("setup")
    if plog_ok then plog.event("setup", "setup done (the user)") end
  end
  local st = setup.get()
  return { done = st.done == true, onboarded = st.onboarded == true, at = st.at, why = st.why, version = st.version or 0, current = setup.ONBOARDING_VERSION }
end, { user_action = true })

return M
