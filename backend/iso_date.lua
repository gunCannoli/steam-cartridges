--- ISO 8601 dates from the store APIs (ADR-0056): "2023-10-27T04:00:00.000Z" -> Unix seconds of that day (UTC).
--- Pure. Steam shows a release as a day, so the time of day is dropped.

local M = {}

local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor((y >= 0 and y or y - 399) / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * (m + (m > 2 and -3 or 9)) + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

--- The day as Unix seconds, or nil when the text does not start with YYYY-MM-DD (a year alone or 0001 is no date).
function M.day(s)
  local y, m, d = tostring(s or ""):match("^(%d%d%d%d)%-(%d%d)%-(%d%d)")
  y, m, d = tonumber(y), tonumber(m), tonumber(d)
  if not y or y < 1970 or m < 1 or m > 12 or d < 1 or d > 31 then return nil end
  return days_from_civil(y, m, d) * 86400
end

--- Date and time as Unix seconds ("2026-10-02T17:44:53.533Z" -> 1790963093), or nil.
function M.instant(s)
  local text = tostring(s or "")
  local day = M.day(text)
  if not day then return nil end
  local h, mi, se = text:match("^%d%d%d%d%-%d%d%-%d%dT(%d%d):(%d%d):(%d%d)")
  return day + (tonumber(h) or 0) * 3600 + (tonumber(mi) or 0) * 60 + (tonumber(se) or 0)
end

return M
