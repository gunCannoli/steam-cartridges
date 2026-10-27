--- Library Setup state (ADR-0086, Library Setup plan Â§ 5): has the user run setup, so the plugin may fetch?
---
--- <data dir>/setup.json: { done = true, at = unix s, why = "setup" | "existing library" | ... }. No file = not run: a
--- new install fetches nothing until the user runs Library Setup. An install that already holds records is marked done
--- once by repairs.lua (repair 2), so an update never interrupts anyone.
---
--- A store: disk only, never the network (architecture test). net.lua does not read it; main.lua wires `done` into
--- net's gate, and record_rpc reads it to keep a page view offline.

local json     = require("json")
local utils    = require("utils")
local data_dir = require("data_dir")

local M = {}

local FILE = "setup.json"
M._path = nil -- test override

local state = nil

local function path() return M._path or data_dir.file(FILE) end

function M._reset() state = nil end

--- The onboarding the user has to have seen (ADR-0093). A state written by an older build has a lower `version`: its owner
--- is asked once whether to run the new onboarding (frontend/settings/panels/library-setup.tsx).
M.ONBOARDING_VERSION = 2

--- { done = boolean, onboarded = boolean, at = number | nil, why = string | nil }
--- `done`: the user gave consent (the first Detect, or a library that already held records). `onboarded`: the user
--- finished or skipped the Library Setup window (onboarding plan § 3b). A file written before the field existed counts as
--- onboarded, except the "existing library" mark: that library still has to go through onboarding.
function M.get()
  if state then return state end
  state = { done = false, onboarded = false, version = 0 }
  local text = utils.read_file(path())
  if text and #text > 0 then
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" and data.done == true then
      local why = type(data.why) == "string" and data.why or nil
      local onboarded = data.onboarded
      if onboarded == nil then onboarded = why ~= "existing library" end
      state = { done = true, onboarded = onboarded == true, at = tonumber(data.at), why = why, version = tonumber(data.version) or 0 }
    end
  end
  return state
end

function M.done()
  return M.get().done == true
end

function M.onboarded()
  return M.get().onboarded == true
end

--- May the plugin fetch on its own? The user consented, and an "existing library" mark alone is not consent: that library
--- waits for onboarding (its stored data keeps showing, nothing new is fetched).
function M.gate_open()
  local st = M.get()
  return st.done == true and (st.onboarded == true or st.why ~= "existing library")
end

--- Mark setup as run. `why` says who did it ("setup": the user ran Detect or finished the window; "existing library":
--- repair 2). `onboarded` is kept when already true.
function M.mark_done(why, now, onboarded)
  local was = M.get()
  if onboarded == nil then
    if was.done then onboarded = was.onboarded
    else onboarded = why ~= "setup" and why ~= "existing library" end -- any other caller (tests) is a finished setup
  end
  -- A first consent starts the current onboarding; an older state keeps its (lower) version until the user answers the prompt.
  local version = was.done and was.version or M.ONBOARDING_VERSION
  state = { done = true, onboarded = onboarded == true, at = now or os.time(), why = why, version = version }
  return utils.write_file(path(), json.encode(state))
end

--- The user answered the "new onboarding" prompt: run it (`onboarded` false, the window follows) or skip it (`onboarded` true).
--- Either way the prompt is not asked again.
function M.answer_prompt(run, now)
  local was = M.get()
  state = { done = true, onboarded = run ~= true, at = now or os.time(), why = "setup", version = M.ONBOARDING_VERSION }
  if was.at and run ~= true then state.at = was.at end
  return utils.write_file(path(), json.encode(state))
end

--- The user finished the Library Setup window, or skipped it.
function M.mark_onboarded(now)
  local was = M.get()
  state = { done = true, onboarded = true, at = now or os.time(), why = was.why == "existing library" and "setup" or was.why or "setup", version = M.ONBOARDING_VERSION }
  return utils.write_file(path(), json.encode(state))
end

--- Back to "not run" (tests, and a user who wants to start over).
function M.clear()
  state = { done = false, onboarded = false, version = 0 }
  return utils.write_file(path(), json.encode({ done = false }))
end

return M
