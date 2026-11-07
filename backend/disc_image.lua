--- Disc images as tracks of 2048-byte sectors, whatever the container: .iso / .bin (cooked or raw 2352 / 2336), .cue, .gdi,
--- .cso (compressed ISO) and .chd. The hashing rules (disc_hash.lua) only ask a track for the sector at a logical block
--- address, as RetroAchievements' own reader does.
---
---   disc_image.open(path) -> disc | nil, reason
---     disc.tracks[n] = { number, is_data, first_lba, read(lba) -> 2048 bytes | nil }
---     disc.first_data -> the first data track        disc.close()
---
--- A track's `first_lba` is the address of its first sector (0 for track 1 of a CD, the gdi's LBA for a Dreamcast track).
--- Where the ISO-9660 volume descriptor sits in the file (sector 16, or 150 sectors later when the 2-second pregap is
--- stored) is found by looking for it, so a stored pregap does not shift the addresses.

local rom_hash = require("rom_hash")
local chd_mod -- loaded when a .chd is opened

local byte, sub = string.byte, string.sub
local M = {}

local SYNC = "\0" .. string.rep("\255", 10) .. "\0"
local PVD = "\1CD001"

local function ext_of(name) return (tostring(name):match("(%.[^%.\\/]+)$") or ""):lower() end
local function dir_of(path) return path:match("^(.*)[\\/][^\\/]*$") or "." end
local function join(dir, name) return rom_hash.m3u_entry_path(dir, (name:gsub("\\", "/"))) end

local function read_at(f, at, n)
  if not f:seek("set", at) then return nil end
  return f:read(n)
end

-- ----------------------------------------------------------------------------------------------------- a track object

--- `frame(i)` returns the 2048 bytes of user data of the i-th sector of the track's data (0-based), or nil.
--- `pvd_at` is the index where the volume descriptor was found (default 16 = no stored pregap).
local function make_track(number, is_data, first_lba, frame, pvd_at)
  local t = { number = number, is_data = is_data, first_lba = first_lba or 0 }
  local pvd_index = pvd_at or 16
  t.pvd_index = pvd_index
  function t.read(lba)
    local idx = pvd_index + (lba - (t.first_lba + 16))
    if idx < 0 then return nil end
    return frame(idx)
  end
  return t
end

-- ------------------------------------------------------------------------------------------ files of raw / cooked sectors

--- Looks for the volume descriptor in a sector file starting at `base`: returns sector size, user-data offset in a
--- sector, and the sector index where it was found.
local function detect_layout(f, base)
  for _, p in ipairs({ 16, 166 }) do
    local h = read_at(f, base + p * 2352, 32)
    if h and #h >= 30 and sub(h, 1, 12) == SYNC then
      if sub(h, 26, 30) == "CD001" then return 2352, 24, p end
      if sub(h, 18, 22) == "CD001" then return 2352, 16, p end
    end
    h = read_at(f, base + p * 2336, 16)
    if h and #h >= 14 and sub(h, 9, 14) == PVD then return 2336, 8, p end
    h = read_at(f, base + p * 2048, 8)
    if h and #h >= 6 and sub(h, 1, 6) == PVD then return 2048, 0, p end
  end
  return nil
end

--- A track made from a file (or a part of one starting at byte `base`). Returns nil, reason when it holds no ISO-9660 volume.
local function file_track(number, path, base, first_lba)
  local f = io.open(path, "rb")
  if not f then return nil, "file_not_found" end
  local ss, off, p = detect_layout(f, base or 0)
  if not ss then
    f:close()
    return nil, "no_iso9660_volume"
  end
  local function frame(i)
    local d = read_at(f, (base or 0) + i * ss + off, 2048)
    if d and #d == 2048 then return d end
    return nil
  end
  local t = make_track(number, true, first_lba, frame, p)
  t.close = function() f:close() end
  return t
end

-- ------------------------------------------------------------------------------------------------------------- cue / gdi

local function parse_cue(path)
  local f = io.open(path, "rb")
  if not f then return nil, "file_not_found" end
  local text = f:read("*a")
  f:close()
  text = text:gsub("^\239\187\191", "")
  local dir = dir_of(path)
  local tracks, file, cur = {}, nil, nil
  for line in text:gmatch("[^\r\n]+") do
    local l = line:match("^%s*(.-)%s*$")
    local u = l:upper()
    if u:sub(1, 5) == "FILE " then
      file = l:match('^[Ff][Ii][Ll][Ee]%s+"([^"]+)"') or l:match("^[Ff][Ii][Ll][Ee]%s+(%S+)")
    elseif u:sub(1, 6) == "TRACK " then
      local n, mode = l:match("^%a+%s+(%d+)%s+(%S+)")
      cur = { number = tonumber(n), mode = (mode or ""):upper(), file = file, pregap = 0 }
      tracks[#tracks + 1] = cur
    elseif cur and u:sub(1, 7) == "PREGAP " then
      local m, s, fr = l:match("(%d+):(%d+):(%d+)")
      if m then cur.pregap = (m * 60 + s) * 75 + fr end
    elseif cur and u:sub(1, 8) == "INDEX 01" then
      local m, s, fr = l:match("(%d+):(%d+):(%d+)")
      if m then cur.index01 = (m * 60 + s) * 75 + fr end
    end
  end
  if #tracks == 0 then return nil, "cue_has_no_track" end
  return tracks, dir
end

local function open_cue(path)
  local tracks, dir = parse_cue(path)
  if not tracks then return nil, dir end
  local disc, lba, seen, first_err = { tracks = {}, closers = {} }, 0, {}, nil
  for _, tr in ipairs(tracks) do
    local full = tr.file and join(dir, tr.file)
    local f = full and (seen[full] or io.open(full, "rb"))
    if not tr.file then
      first_err = first_err or "cue_has_no_file_entry"
    elseif not f then
      first_err = first_err or "cue_file_not_found" -- only an error if no data track can be read
    end
    if tr.file and f then
    if not seen[full] then
      seen[full] = { start = lba, size = f:seek("end") }
      f:close()
    end
    local fi = seen[full]
    local ss = tr.mode:match("/(%d+)$")
    ss = tonumber(ss) or 2352
    tr.first_lba = fi.start + (tr.index01 or 0) + tr.pregap
    if fi.size then lba = math.max(lba, fi.start + math.floor(fi.size / ss)) end
    local audio = tr.mode == "AUDIO"
    local t
    if audio then
      t = make_track(tr.number, false, tr.first_lba, function() return nil end)
    else
      t = file_track(tr.number, full, (tr.index01 or 0) * ss, tr.first_lba)
    end
    if t then
      disc.tracks[tr.number] = t
      if t.close then disc.closers[#disc.closers + 1] = t.close end
      if t.is_data and not disc.first_data then disc.first_data = t end
    end
    end
  end
  if not disc.first_data then return nil, first_err or "no_iso9660_volume" end
  return disc
end

local function open_gdi(path)
  local f = io.open(path, "rb")
  if not f then return nil, "file_not_found" end
  local text = f:read("*a")
  f:close()
  local dir, disc = dir_of(path), { tracks = {}, closers = {} }
  local first = true
  for line in text:gmatch("[^\r\n]+") do
    if first then
      first = false
    else
      local n, lba, ty, ss, name = line:match('^%s*(%d+)%s+(%d+)%s+(%d+)%s+(%d+)%s+"?([^"]-)"?%s+%d+%s*$')
      if n and tonumber(ty) == 4 then
        local t = file_track(tonumber(n), join(dir, name), 0, tonumber(lba))
        if t then
          disc.tracks[tonumber(n)] = t
          disc.closers[#disc.closers + 1] = t.close
          if not disc.first_data then disc.first_data = t end
        end
      end
    end
  end
  if not disc.first_data then return nil, "no_iso9660_volume" end
  return disc
end

-- ------------------------------------------------------------------------------------------------------------------ cso

local function open_cso(path)
  local f = io.open(path, "rb")
  if not f then return nil, "file_not_found" end
  local h = read_at(f, 0, 24)
  if not h or #h < 24 then f:close() return nil, "cso_bad_header" end
  local magic = sub(h, 1, 4)
  if magic == "ZISO" then f:close() return nil, "zso_unsupported" end
  if magic ~= "CISO" then f:close() return nil, "cso_bad_header" end
  local function le(s, p, n)
    local v = 0
    for i = n - 1, 0, -1 do v = v * 256 + byte(s, p + i) end
    return v
  end
  local total, block, shift = le(h, 9, 8), le(h, 17, 4), byte(h, 22)
  if block == 0 then f:close() return nil, "cso_bad_header" end
  local nblocks = math.ceil(total / block)
  local raw = read_at(f, 24, (nblocks + 1) * 4)
  if not raw or #raw < (nblocks + 1) * 4 then f:close() return nil, "cso_bad_header" end
  local cache_i, cache_d
  local function get_block(i)
    if cache_i == i then return cache_d end
    local a, b = le(raw, i * 4 + 1, 4), le(raw, i * 4 + 5, 4)
    local plain = a >= 2147483648
    local from, to = (a % 2147483648) * 2 ^ shift, (b % 2147483648) * 2 ^ shift
    local data = read_at(f, from, to - from)
    if not data then return nil end
    if not plain then
      local out = rom_hash.inflate(data, nil)
      if not out then return nil end
      data = out
    end
    cache_i, cache_d = i, data
    return data
  end
  local function frame(i)
    local at = i * 2048
    if at >= total then return nil end
    local blk = math.floor(at / block)
    local data = get_block(blk)
    if not data then return nil end
    local d = sub(data, at - blk * block + 1, at - blk * block + 2048)
    if #d == 2048 then return d end
    return nil
  end
  local t = make_track(1, true, 0, frame, 16)
  if frame(16) == nil or sub(frame(16), 1, 6) ~= PVD then f:close() return nil, "no_iso9660_volume" end
  return { tracks = { t }, first_data = t, closers = { function() f:close() end } }
end

-- ------------------------------------------------------------------------------------------------------------------ chd

local USER_OFFSET = { MODE1 = 0, MODE1_RAW = 16, MODE2 = 8, MODE2_FORM1 = 0, MODE2_FORM_MIX = 8, MODE2_RAW = 24 }

local function chd_frame_source(chd, start, frames, uoff)
  local fph = math.floor(chd.hunkbytes / 2448)
  return function(i)
    if i >= frames then return nil end
    local fr = start + i
    local hn = math.floor(fr / fph)
    local h = chd_mod.hunk(chd, hn)
    if not h then return nil, hn end
    local at = (fr - hn * fph) * h.stride + uoff
    local d = sub(h.data, at + 1, at + 2048)
    if #d == 2048 then return d end
    return nil
  end
end

local function open_chd(path)
  chd_mod = chd_mod or require("chd")
  local chd, why = chd_mod.open(path)
  if not chd then return nil, why end
  local disc = { tracks = {}, closers = { function() chd_mod.close(chd) end }, chd = chd }
  if #chd.tracks > 0 then
    for _, tr in ipairs(chd.tracks) do
      local uoff = USER_OFFSET[tr.type]
      if uoff and tr.type ~= "AUDIO" then
        local frame = chd_frame_source(chd, tr.start, tr.frames, uoff)
        -- the volume descriptor: frame 16 of the track, or 150 later when a pregap is stored
        local p
        for _, cand in ipairs({ 16, 166 }) do
          local d = frame(cand)
          if d and sub(d, 1, 6) == PVD then p = cand break end
        end
        -- a GD-ROM track sits at the LBA its frames start at; a CD's first track at 0
        local lba = tr.gdrom and tr.start or (tr.number == 1 and 0 or tr.start)
        local t = make_track(tr.number, true, lba, frame, p)
        t.has_volume = p ~= nil
        disc.tracks[tr.number] = t
        if not disc.first_data then disc.first_data = t end
      end
    end
  elseif chd.dvd or chd.hunkbytes % 2048 == 0 then
    local per = chd.hunkbytes
    local total = chd.logicalbytes
    local function frame(i)
      local at = i * 2048
      if at + 2048 > total then return nil end
      local hn = math.floor(at / per)
      local h = chd_mod.hunk(chd, hn)
      if not h then return nil end
      local d = sub(h.data, at - hn * per + 1, at - hn * per + 2048)
      if #d == 2048 then return d end
      return nil
    end
    local d = frame(16)
    local t = make_track(1, true, 0, frame, 16)
    t.has_volume = d ~= nil and sub(d, 1, 6) == PVD
    disc.tracks[1], disc.first_data = t, t
  end
  if not disc.first_data then
    chd_mod.close(chd)
    return nil, "chd_no_data_track"
  end
  return disc
end

-- ------------------------------------------------------------------------------------------------------------------ open

function M.open(path)
  local ext = ext_of(path)
  local disc, why
  if ext == ".cue" then
    disc, why = open_cue(path)
  elseif ext == ".gdi" then
    disc, why = open_gdi(path)
  elseif ext == ".cso" or ext == ".zso" then
    disc, why = open_cso(path)
  elseif ext == ".chd" then
    disc, why = open_chd(path)
  else
    local t
    t, why = file_track(1, path, 0, 0)
    if t then disc = { tracks = { t }, first_data = t, closers = { t.close } } end
  end
  if not disc then return nil, why end
  function disc.close()
    for _, c in ipairs(disc.closers) do pcall(c) end
    disc.closers = {}
  end
  return disc
end

return M
