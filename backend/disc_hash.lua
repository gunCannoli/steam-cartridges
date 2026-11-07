--- RetroAchievements' disc hashes (PlayStation, PlayStation 2, PSP, Dreamcast), ported from rcheevos (rc_hash_disc.c) so the
--- MD5 is the one the RetroAchievements server knows. Read them off any container disc_image.lua opens (iso, bin/cue, gdi,
--- cso, chd).
---   PlayStation   MD5 of the boot executable's name (as SYSTEM.CNF writes it, no ";1") followed by the executable: its
---                 size is the one in its PS-X EXE header (+2048 for the header), else the directory size. PSX.EXE if
---                 SYSTEM.CNF names no boot file.
---   PlayStation 2 the same, from BOOT2 = cdrom0:\NAME;1 (the whole file).
---   PSP           MD5 of PSP_GAME\PARAM.SFO followed by PSP_GAME\SYSDIR\EBOOT.BIN.
---   Dreamcast     MD5 of the first 256 bytes of IP.BIN (track 3 of a GD-ROM, else the first data track) followed by the
---                 boot file IP.BIN names.
--- A file is hashed up to 64 MB (rcheevos' limit).
---
---   disc_hash.hash(path) -> { md5, console, format = "disc" } | nil, reason

local disc_image = require("disc_image")
local rom_hash = require("rom_hash")

local byte, sub = string.byte, string.sub
local M = {}

local MAX_BYTES = 64 * 1024 * 1024

local function u24(s, p) return byte(s, p) + byte(s, p + 1) * 256 + byte(s, p + 2) * 65536 end
local function u32(s, p) return u24(s, p) + byte(s, p + 3) * 16777216 end

-- ------------------------------------------------------------------------------------------------------------ ISO-9660

--- The records of a directory, one after another (rc_cd_find_next_file): name, 24-bit extent, size, is_dir.
local function entries(track, sector, size, block)
  local buf = track.read(sector)
  local ptr, remaining = 1, size
  return function()
    if not buf then return nil end
    while true do
      if ptr - 1 >= 2048 - 34 or byte(buf, ptr) == 0 then
        if remaining > block then
          remaining = remaining - block
          sector = sector + 1
          buf = track.read(sector)
          ptr = 1
          if not buf then return nil end
        else
          return nil
        end
      else
        local len = byte(buf, ptr)
        local nlen = byte(buf, ptr + 32)
        local e = {
          name = sub(buf, ptr + 33, ptr + 32 + nlen), extent = u24(buf, ptr + 2), size = u32(buf, ptr + 10),
          is_dir = (byte(buf, ptr + 25) or 0) % 4 >= 2,
        }
        ptr = ptr + len
        if ptr - 1 <= 2048 then return e end
      end
    end
  end
end

--- LBA and size of a file by its path ("DIR\\NAME"), the way rc_cd_find_file_sector finds it.
local function find_file(track, path)
  local pvd = track.read(track.first_lba + 16)
  if not pvd or sub(pvd, 1, 6) ~= "\1CD001" then return nil end
  local block = byte(pvd, 129) + byte(pvd, 130) * 256
  local sector, size = u24(pvd, 159), u32(pvd, 167)
  if block == 0 then block = 2048 end
  path = path:gsub("^\\", "")
  while true do
    local dir, rest = path:match("^([^\\]*)\\(.*)$")
    if not dir then break end
    local found
    for e in entries(track, sector, size, block) do
      if #e.name == #dir and e.name:lower() == dir:lower() then
        found = e
        break
      end
    end
    if not found then return nil end
    sector, size, path = found.extent, found.size, rest
  end
  local want = path:lower()
  for e in entries(track, sector, size, block) do
    local n = e.name:lower()
    if (#e.name == #path or sub(n, #path + 1, #path + 1) == ";") and sub(n, 1, #path) == want then return e.extent, e.size end
  end
  return nil
end

--- Appends `size` bytes of a file (from sector `lba`) to the hash; false when its first sector cannot be read.
local function hash_file(stream, track, lba, size)
  local first = track.read(lba)
  if not first then return false end
  if size > MAX_BYTES then size = MAX_BYTES end
  local buf, nbuf, cur, d = {}, 0, lba, first
  while size > 0 do
    if not d then break end
    local take = size < 2048 and size or 2048
    buf[#buf + 1] = take == 2048 and d or sub(d, 1, take)
    nbuf = nbuf + 1
    size = size - take
    cur = cur + 1
    if nbuf >= 64 then
      stream.update(table.concat(buf))
      buf, nbuf = {}, 0
    end
    d = size > 0 and track.read(cur) or nil
  end
  if nbuf > 0 then stream.update(table.concat(buf)) end
  return true
end

-- ------------------------------------------------------------------------------------------------------- the consoles

--- The executable name SYSTEM.CNF gives after `key`: "BOOT = cdrom:\SLUS_000.01;1" -> "SLUS_000.01" (rc_hash_find_playstation_executable).
local function boot_name(text, key, prefix)
  text = text:gsub("%z.*$", "")
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if sub(line, 1, #key) == key then
      local rest = sub(line, #key + 1):gsub("^%s+", "")
      if sub(rest, 1, 1) == "=" then
        rest = sub(rest, 2):gsub("^%s+", "")
        if sub(rest, 1, #prefix) == prefix then rest = sub(rest, #prefix + 1) end
        rest = rest:gsub("^\\+", "")
        local name = rest:match("^([^%s;]*)")
        return sub(name, 1, 63)
      end
    end
  end
  return nil
end

local function playstation(track, key, prefix, fallback_exe)
  local name, lba, size
  local cnf, cnf_size = find_file(track, "SYSTEM.CNF")
  if cnf then
    local d = track.read(cnf)
    if d then
      name = boot_name(sub(d, 1, math.min(2047, cnf_size)), key, prefix)
      if name and name ~= "" then lba, size = find_file(track, name) end
    end
  end
  if not lba and fallback_exe then
    lba, size = find_file(track, fallback_exe)
    name = fallback_exe
  end
  if not lba then return nil end
  local head = track.read(lba)
  if not head then return nil end
  if key == "BOOT" and sub(head, 1, 7) == "PS-X EX" then size = u32(head, 29) + 2048 end
  local stream = rom_hash.md5_stream()
  stream.update(name)
  if not hash_file(stream, track, lba, size) then return nil end
  return stream.final()
end

local function psp(track)
  local lba, size = find_file(track, "PSP_GAME\\PARAM.SFO")
  if not lba then return nil end
  local stream = rom_hash.md5_stream()
  if not hash_file(stream, track, lba, size) then return nil end
  lba, size = find_file(track, "PSP_GAME\\SYSDIR\\EBOOT.BIN")
  if not lba or not hash_file(stream, track, lba, size) then return nil end
  return stream.final()
end

local function dreamcast(disc)
  local track = disc.tracks[3]
  local head = track and track.read(track.first_lba)
  if not head or sub(head, 1, 16) ~= "SEGA SEGAKATANA " then
    track = disc.first_data
    head = track and track.read(track.first_lba)
    if not head or sub(head, 1, 16) ~= "SEGA SEGAKATANA " then return nil end
  end
  local ip = sub(head, 1, 256)
  local exe = sub(ip, 97, 112):match("^(%S*)")
  if not exe or exe == "" then return nil end
  local lba, size = find_file(track, exe)
  if not lba then return nil end
  if not track.read(lba) then -- the boot file is in the last track
    local last
    for n, t in pairs(disc.tracks) do
      if t.is_data and (not last or n > last.number) then last = t end
    end
    if not last then return nil end
    track = last
  end
  local stream = rom_hash.md5_stream()
  stream.update(ip)
  if not hash_file(stream, track, lba, size) then return nil end
  return stream.final()
end

--- { md5, console, format = "disc" } for a disc image, or nil and a short reason.
function M.hash(path)
  local disc, why = disc_image.open(path)
  if not disc then return nil, why end
  local ok, md5, console = pcall(function()
    local t1 = (disc.tracks[1] and disc.tracks[1].is_data) and disc.tracks[1] or disc.first_data
    local h = playstation(t1, "BOOT", "cdrom:", "PSX.EXE")
    if h then return h, "playstation" end
    h = playstation(t1, "BOOT2", "cdrom0:", nil)
    if h then return h, "playstation2" end
    h = psp(t1)
    if h then return h, "psp" end
    h = dreamcast(disc)
    if h then return h, "dreamcast" end
    return nil
  end)
  disc.close()
  if not ok then return nil, "disc_error: " .. tostring(md5):gsub("^.-:%d+: ", "") end
  if not md5 then return nil, "disc_not_recognized" end
  return { md5 = md5, console = console, format = "disc" }
end

return M
