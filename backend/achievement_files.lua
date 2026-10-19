--- steam-cartridges - reading and clearing the unlocks in emulator achievement files (ADR-0054).
---
--- Pure text/byte work, no disk access: each `*_lock_all` takes a file's content and returns
--- the new content and how many unlocks it cleared; achievements_reset.lua does the backup and
--- the write. Formats:
---   RPCS3            TROPUSR.DAT (rpcs3/Loader/TROPUSR.h): a 48-byte header, `tables_count` table
---                    headers of 32 bytes, then the tables. Table type 6 holds one entry per trophy,
---                    sizeof(TROPUSREntry6) = 0x70 bytes (its entry_size field, 0x60, leaves out the
---                    16-byte entry header): trophy_id at +16, trophy_state at +20, timestamp1 at +32,
---                    timestamp2 at +40, all big-endian. RPCS3's own LockTrophy zeroes the state and
---                    both timestamps.
---   shadPS4          its per-user trophy XML: `<trophy id="N" ... unlockstate="true" timestamp="...">`
---                    (src/core/libraries/np/np_trophy.cpp).

local M = {}

-- ---------- RPCS3 TROPUSR.DAT ----------

local function u32(data, pos) -- pos is 1-based
  local a, b, c, d = data:byte(pos, pos + 3)
  if not d then return nil end
  return ((a * 256 + b) * 256 + c) * 256 + d
end

local HEADER_SIZE, TABLE_HEADER_SIZE, ENTRY6_SIZE = 48, 32, 0x70
local MAGIC = 0x818F54AD

--- The type-6 table of a TROPUSR.DAT: its first byte (1-based) and entry count, or nil and why.
local function table6(data)
  if type(data) ~= "string" or #data < HEADER_SIZE then return nil, "file too short" end
  if u32(data, 1) ~= MAGIC then return nil, "not a TROPUSR.DAT (bad magic)" end
  local count = u32(data, 9) or 0
  if count < 1 or count > 64 then return nil, "unexpected table count" end
  for i = 0, count - 1 do
    local h = HEADER_SIZE + i * TABLE_HEADER_SIZE + 1
    local ttype, entries = u32(data, h), u32(data, h + 12)
    local off_hi, off_lo = u32(data, h + 16), u32(data, h + 20)
    if not off_lo then return nil, "truncated table headers" end
    if ttype == 6 then
      if off_hi ~= 0 then return nil, "table offset out of range" end
      local first = off_lo + 1
      if first + entries * ENTRY6_SIZE - 1 > #data then return nil, "truncated trophy table" end
      return first, entries
    end
  end
  return nil, "no trophy state table"
end

--- Unlocked trophies: id string ("0", and zero-padded "000") -> { unlocked_time }.
--- Timestamps are PS3 ticks (microseconds since 0001-01-01); converted to Unix seconds.
function M.rpcs3_unlocked(data)
  local first, entries = table6(data)
  local out = {}
  if not first then return out end
  for i = 0, entries - 1 do
    local e = first + i * ENTRY6_SIZE
    local id, state = u32(data, e + 16), u32(data, e + 20)
    if id and state and state ~= 0 then
      local hi, lo = u32(data, e + 32) or 0, u32(data, e + 36) or 0
      local us = hi * 4294967296 + lo
      local unix = math.floor(us / 1000000) - 62135596800
      if unix <= 0 or unix > 4102444800 then unix = os.time() end
      out[tostring(id)] = { unlocked_time = unix }
      out[string.format("%03d", id)] = { unlocked_time = unix }
    end
  end
  return out
end

--- Locks every trophy (state and both timestamps 0). Returns new data and the count cleared,
--- or nil, 0 and why when the file is not a TROPUSR.DAT this understands (nothing is changed).
function M.rpcs3_lock_all(data)
  local first, entries = table6(data)
  if not first then return nil, 0, entries end
  local parts, pos, cleared = {}, 1, 0
  local zero4, zero8 = string.rep("\0", 4), string.rep("\0", 8)
  for i = 0, entries - 1 do
    local e = first + i * ENTRY6_SIZE
    if (u32(data, e + 20) or 0) ~= 0 then cleared = cleared + 1 end
    parts[#parts + 1] = data:sub(pos, e + 19)          -- up to trophy_state
    parts[#parts + 1] = zero4                          -- trophy_state
    parts[#parts + 1] = data:sub(e + 24, e + 31)       -- unk4, unk5
    parts[#parts + 1] = zero8 .. zero8                 -- timestamp1, timestamp2
    pos = e + 48
  end
  parts[#parts + 1] = data:sub(pos)
  return table.concat(parts), cleared
end

-- ---------- shadPS4 trophy XML ----------

--- Unlocked trophies in a shadPS4 trophy XML: id string -> { unlocked_time }.
function M.shadps4_unlocked(xml)
  local out = {}
  for tag in (xml or ""):gmatch("<trophy%s[^>]*>") do
    local id = tag:match('%sid="(%d+)"')
    local state = tag:match('%sunlockstate="(%a+)"')
    if id and state and state:lower() == "true" then
      local ts = tonumber(tag:match('%stimestamp="(%d+)"') or "")
      -- shadPS4 writes milliseconds since the Unix epoch on some builds, seconds on others.
      if ts and ts > 100000000000 then ts = math.floor(ts / 1000) end
      local t = { unlocked_time = (ts and ts > 0) and ts or os.time() }
      out[tostring(tonumber(id))] = t
      out[string.format("%03d", tonumber(id))] = t
    end
  end
  return out
end

--- Locks every trophy: `unlockstate="false"` and no `timestamp`. Returns new XML and the count cleared.
function M.shadps4_lock_all(xml)
  local cleared = 0
  local out = (xml or ""):gsub("<trophy%s[^>]*>", function(tag)
    local state = tag:match('%sunlockstate="(%a+)"')
    if not state then return tag end
    if state:lower() == "true" then cleared = cleared + 1 end
    tag = tag:gsub('(%sunlockstate=")%a+(")', "%1false%2")
    tag = tag:gsub('%stimestamp="[^"]*"', "")
    return tag
  end)
  return out, cleared
end

return M
