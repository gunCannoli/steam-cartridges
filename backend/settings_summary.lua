--- Log-safe summary of the plugin's settings mirror (ADR-0090): every option the settings panel holds, as
--- on/off flags and counts. Nothing that names the user ever reaches a line: no rule pattern, name or id, no
--- collection id, no key, no path, no free text. A credential, username or email smuggled into a free-text field
--- (a rule pattern, a kill-switch id) is dropped, never printed. Pure function of the settings table, so tests pin it.

local M = {}

--- The services panel, in panel order: flag key in settings.services, short label for the log.
local SERVICES = {
  { flag = "steamStoreEnabled",         label = "steam-store" },
  { flag = "screenscraperEnabled",      label = "screenscraper" },
  { flag = "igdbEnabled",               label = "igdb" },
  { flag = "steamgriddbEnabled",        label = "steamgriddb" },
  { flag = "retroachievementsEnabled",  label = "retroachievements" },
  { flag = "emulatorsEnabled",          label = "emulators" },
  { flag = "nativePortsEnabled",        label = "native-ports" },
  { flag = "rpcs3Enabled",              label = "rpcs3" },
}

local function onoff(v)
  if v == true then return "on" elseif v == false then return "off" else return "unset" end
end

local function count_keys(t)
  local n = 0
  if type(t) == "table" then for _ in pairs(t) do n = n + 1 end end
  return n
end

local function count_true(t)
  local n = 0
  if type(t) == "table" then for _, v in pairs(t) do if v == true then n = n + 1 end end end
  return n
end

local function count_list(t)
  local n = 0
  if type(t) == "table" then for _, v in ipairs(t) do if v ~= nil then n = n + 1 end end end
  return n
end

--- A value safe to print: a short enum-ish token, else nil (the caller prints a count or "unset" instead).
local function token(v)
  if type(v) == "string" and #v > 0 and #v <= 32 and v:match("^[%w_%-]+$") then return v end
  return nil
end

local function number_or(v)
  if type(v) == "number" then return tostring(v) end
  return "unset"
end

--- The kill-switch list (comma-separated feature ids): safe tokens only, the rest dropped.
local function kill_switches(v)
  if type(v) ~= "string" or v:match("^%s*$") then return "none" end
  local kept = {}
  for raw in v:gmatch("[^,]+") do
    local t = token(raw:match("^%s*(.-)%s*$"))
    if t then kept[#kept + 1] = t end
  end
  if #kept == 0 then return "none" end
  return table.concat(kept, ",")
end

--- Routing rules: counts plus the distinct safe enum values (service, condition, action) — never a pattern, name or id.
local function rules_summary(rules)
  local total, enabled = 0, 0
  local services, conditions, actions = {}, {}, {}
  if type(rules) == "table" then
    for _, r in ipairs(rules) do
      if type(r) == "table" then
        total = total + 1
        if r.enabled ~= false then enabled = enabled + 1 end
        local s, c, a = token(r.service), token(r.conditionType), token(r.action)
        if s then services[s] = true end
        if c then conditions[c] = true end
        if a then actions[a] = true end
      end
    end
  end
  local function names(set)
    local list = {}
    for k in pairs(set) do list[#list + 1] = k end
    table.sort(list)
    return table.concat(list, ",")
  end
  return string.format("%d total, %d enabled, services=[%s], conditions=[%s], actions=[%s]",
    total, enabled, names(services), names(conditions), names(actions))
end

--- Three lines: sources (each on/off/unset), options, routing. Never throws, never prints user text.
---@param values table|nil settings_store.get_all()
---@return string[]
function M.lines(values)
  values = type(values) == "table" and values or {}
  local svc = type(values.services) == "table" and values.services or {}
  local parts = {}
  for _, s in ipairs(SERVICES) do parts[#parts + 1] = s.label .. "=" .. onoff(svc[s.flag]) end

  local buckets = type(values.buckets) == "table" and values.buckets or {}
  return {
    "sources: " .. table.concat(parts, ", "),
    string.format("options: full-controller=%s, hardcore=%s, activity(added=%s,first=%s,achievements=%s), community(trailers=%s,manuals=%s,artworks=%s,links=%s), media-cache-days=%s, controller-overrides=%d, ignored-issues=%d, kill-switches=%s",
      onoff(values.defaultFullController), onoff(values.raHardcoreMode),
      onoff(values.activityShowAddedToLibrary), onoff(values.activityShowFirstPlayed), onoff(values.activityShowAchievements),
      onoff(values.communityShowTrailers), onoff(values.communityShowManuals), onoff(values.communityShowArtworks), onoff(values.communityShowExternalLinks),
      number_or(values.mediaCacheDays), count_keys(values.controllerOverrides), count_true(values.ignoredIssues),
      kill_switches(values.disabledFeatures)),
    string.format("routing: rules: %s; buckets(default=%s, collection-rules=%d, overrides=%d)",
      rules_summary(values.routingRules), token(buckets.default) or "unset",
      count_list(buckets.rules), count_keys(buckets.overrides)),
  }
end

return M
