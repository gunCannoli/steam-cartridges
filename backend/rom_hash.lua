--- ROM and disc hashing for RetroAchievements, in Lua (no Node.js, no external program). Replaces ra_hasher.js and
--- gives the same answers for every rule it had:
---   .m3u          the first listed file that exists (disc 1)
---   discs         .iso .bin .cue .gdi .cso .chd: RetroAchievements' own PlayStation / PS2 / PSP / Dreamcast hash of the disc
---                 (disc_hash.lua, after rcheevos), whatever the container; a .bin that is not a disc (a Genesis
---                 cartridge) is hashed as a cartridge; a disc that cannot be read is { format = "chd" | "disc_unrecognized",
---                 reason } and the caller falls back to title matching
---   .pbp          PSP EBOOT: the whole file (first 64 MB), as rcheevos does
---   .zip          the first entry with a cartridge extension (else the first entry), stored or deflated; an arcade
---                 romset (more than 3 chips, no console ROM) is not hashed: { format = "arcade_zip" }
---   other files   up to 100 MB, else { format = "large_disc" }
--- Cartridge bytes, in this order: NES iNES header (16 bytes) removed; N64 byte order made big-endian (.v64 / .n64);
--- Genesis SMD header removed and its 16 KB blocks de-interleaved; a 512-byte SNES copier header removed (size % 1024
--- == 512). Then the MD5 of what is left.
---
--- Runs in the backend's interpreter (main.lua turns the JIT off): about 1 s per 4 MB. The caller keeps each answer on
--- disk while the file is unchanged (ra_cache.lua), so a ROM is hashed once.

local bit = require("bit")
local band, bor, bxor, bnot = bit.band, bit.bor, bit.bxor, bit.bnot
local lshift, rshift, rol, tobit = bit.lshift, bit.rshift, bit.rol, bit.tobit
local byte, char, sub = string.byte, string.char, string.sub
local unpack = unpack or table.unpack

local M = {}

M.MAX_PLAIN = 104857600 -- 100 MB

-- ---------------------------------------------------------------------------------------------------------------- MD5

local K, S = {}, {}
for i = 0, 63 do K[i] = tobit(math.floor(math.abs(math.sin(i + 1)) * 4294967296)) end
do
  local s = { { 7, 12, 17, 22 }, { 5, 9, 14, 20 }, { 4, 11, 16, 23 }, { 6, 10, 15, 21 } }
  for i = 0, 63 do S[i] = s[math.floor(i / 16) + 1][i % 4 + 1] end
end
local G = {}
for i = 0, 63 do
  if i < 16 then G[i] = i elseif i < 32 then G[i] = (5 * i + 1) % 16 elseif i < 48 then G[i] = (3 * i + 5) % 16 else G[i] = (7 * i) % 16 end
end

local X = {}
local function block(h, s, p)
  for j = 0, 15 do
    local q = p + j * 4
    local b0, b1, b2, b3 = byte(s, q, q + 3)
    X[j] = bor(b0, lshift(b1, 8), lshift(b2, 16), lshift(b3, 24))
  end
  local A, B, C, D = h[1], h[2], h[3], h[4]
  for i = 0, 63 do
    local f
    if i < 16 then f = bor(band(B, C), band(bnot(B), D))
    elseif i < 32 then f = bor(band(D, B), band(bnot(D), C))
    elseif i < 48 then f = bxor(B, C, D)
    else f = bxor(C, bor(B, bnot(D))) end
    local t = D
    D = C
    C = B
    B = tobit(B + rol(tobit(A + f + K[i] + X[G[i]]), S[i]))
    A = t
  end
  h[1], h[2], h[3], h[4] = tobit(h[1] + A), tobit(h[2] + B), tobit(h[3] + C), tobit(h[4] + D)
end

local function le32hex(v)
  local out = {}
  for k = 0, 3 do out[#out + 1] = string.format("%02x", band(rshift(v, k * 8), 0xff)) end
  return table.concat(out)
end

--- MD5 of a string, as 32 lowercase hex digits.
function M.md5(s)
  local h = { tobit(0x67452301), tobit(0xefcdab89), tobit(0x98badcfe), tobit(0x10325476) }
  local n = #s
  local full = n - n % 64
  for p = 1, full, 64 do block(h, s, p) end
  local bits = n * 8
  local len = {}
  for k = 0, 7 do
    len[k + 1] = char(math.floor(bits / 2 ^ (8 * k)) % 256)
  end
  local pad = (55 - n) % 64
  local tail = sub(s, full + 1) .. "\128" .. string.rep("\0", pad) .. table.concat(len)
  for p = 1, #tail, 64 do block(h, tail, p) end
  return le32hex(h[1]) .. le32hex(h[2]) .. le32hex(h[3]) .. le32hex(h[4])
end

--- A running MD5: `update(string)` any number of times, then `final()` -> 32 lowercase hex digits. For hashing a disc image's
--- executable sector by sector without holding it in memory.
function M.md5_stream()
  local h = { tobit(0x67452301), tobit(0xefcdab89), tobit(0x98badcfe), tobit(0x10325476) }
  local pending, total = "", 0
  local self = {}
  function self.update(s)
    total = total + #s
    if pending ~= "" then s, pending = pending .. s, "" end
    local full = #s - #s % 64
    for p = 1, full, 64 do block(h, s, p) end
    pending = sub(s, full + 1)
  end
  function self.final()
    local len = {}
    for k = 0, 7 do len[k + 1] = char(math.floor(total * 8 / 2 ^ (8 * k)) % 256) end
    local tail = pending .. "\128" .. string.rep("\0", (55 - total) % 64) .. table.concat(len)
    for p = 1, #tail, 64 do block(h, tail, p) end
    return le32hex(h[1]) .. le32hex(h[2]) .. le32hex(h[3]) .. le32hex(h[4])
  end
  return self
end

-- --------------------------------------------------------------------------------------- raw DEFLATE (RFC 1951)
-- After zlib's puff.c: canonical Huffman codes decoded a bit at a time.

local LBASE = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 }
local LEXT = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 }
local DBASE = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577 }
local DEXT = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 }
local ORDER = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 }

--- Huffman table from code lengths (index 0..n-1): { count[0..15], symbol[0..] }.
local function construct(lengths, n)
  local count, symbol, offs = {}, {}, {}
  for len = 0, 15 do count[len] = 0 end
  for s = 0, n - 1 do count[lengths[s]] = count[lengths[s]] + 1 end
  offs[1] = 0
  for len = 1, 14 do offs[len + 1] = offs[len] + count[len] end
  for s = 0, n - 1 do
    local l = lengths[s]
    if l ~= 0 then
      symbol[offs[l]] = s
      offs[l] = offs[l] + 1
    end
  end
  return { count = count, symbol = symbol }
end

local FIXED_L, FIXED_D
do
  local l = {}
  for s = 0, 143 do l[s] = 8 end
  for s = 144, 255 do l[s] = 9 end
  for s = 256, 279 do l[s] = 7 end
  for s = 280, 287 do l[s] = 8 end
  FIXED_L = construct(l, 288)
  local d = {}
  for s = 0, 29 do d[s] = 5 end
  FIXED_D = construct(d, 30)
end

--- Inflates raw DEFLATE data (a zip entry, method 8). Returns the bytes, or nil and an error.
function M.inflate(data, expected)
  local pos, bitbuf, bitcnt = 1, 0, 0
  local out, outn = {}, 0

  local function bits(need)
    local val = bitbuf
    while bitcnt < need do
      local b = byte(data, pos)
      if not b then error("inflate: out of input", 0) end
      pos = pos + 1
      val = bor(val, lshift(b, bitcnt))
      bitcnt = bitcnt + 8
    end
    bitbuf = rshift(val, need)
    bitcnt = bitcnt - need
    return band(val, lshift(1, need) - 1)
  end

  local function decode(h)
    local count, symbol = h.count, h.symbol
    local code, first, index = 0, 0, 0
    for len = 1, 15 do
      code = bor(code, bits(1))
      local c = count[len]
      if code - c < first then return symbol[index + (code - first)] end
      index = index + c
      first = (first + c) * 2
      code = code * 2
    end
    error("inflate: bad code", 0)
  end

  local function codes(lencode, distcode)
    while true do
      local sym = decode(lencode)
      if sym < 256 then
        outn = outn + 1
        out[outn] = sym
      elseif sym == 256 then
        return
      else
        sym = sym - 257
        if sym >= 29 then error("inflate: bad length", 0) end
        local len = LBASE[sym + 1] + bits(LEXT[sym + 1])
        local ds = decode(distcode)
        if ds >= 30 then error("inflate: bad distance", 0) end
        local dist = DBASE[ds + 1] + bits(DEXT[ds + 1])
        if dist > outn then error("inflate: distance too far", 0) end
        for _ = 1, len do
          outn = outn + 1
          out[outn] = out[outn - dist]
        end
      end
    end
  end

  local function stored()
    bitbuf, bitcnt = 0, 0
    if pos + 3 > #data then error("inflate: out of input", 0) end
    local b0, b1, b2, b3 = byte(data, pos, pos + 3)
    pos = pos + 4
    local len = b0 + b1 * 256
    if len ~= bxor(b2 + b3 * 256, 0xffff) then error("inflate: bad stored length", 0) end
    if pos + len - 1 > #data then error("inflate: out of input", 0) end
    for k = 0, len - 1 do
      outn = outn + 1
      out[outn] = byte(data, pos + k)
    end
    pos = pos + len
  end

  local function dynamic()
    local nlen, ndist, ncode = bits(5) + 257, bits(5) + 1, bits(4) + 4
    if nlen > 286 or ndist > 30 then error("inflate: bad counts", 0) end
    local lengths = {}
    for k = 0, 18 do lengths[k] = 0 end
    for k = 1, ncode do lengths[ORDER[k]] = bits(3) end
    local lencode = construct(lengths, 19)
    lengths = {}
    local index = 0
    while index < nlen + ndist do
      local sym = decode(lencode)
      if sym < 16 then
        lengths[index] = sym
        index = index + 1
      else
        local len, rep = 0, 0
        if sym == 16 then
          if index == 0 then error("inflate: repeat with no first length", 0) end
          len = lengths[index - 1]
          rep = 3 + bits(2)
        elseif sym == 17 then rep = 3 + bits(3)
        else rep = 11 + bits(7) end
        if index + rep > nlen + ndist then error("inflate: too many lengths", 0) end
        for _ = 1, rep do
          lengths[index] = len
          index = index + 1
        end
      end
    end
    local ll, dl = {}, {}
    for k = 0, nlen - 1 do ll[k] = lengths[k] end
    for k = 0, ndist - 1 do dl[k] = lengths[nlen + k] end
    codes(construct(ll, nlen), construct(dl, ndist))
  end

  local ok, err = pcall(function()
    local last
    repeat
      last = bits(1)
      local kind = bits(2)
      if kind == 0 then stored()
      elseif kind == 1 then codes(FIXED_L, FIXED_D)
      elseif kind == 2 then dynamic()
      else error("inflate: bad block type", 0) end
    until last == 1
  end)
  if not ok then return nil, tostring(err) end
  if expected and outn ~= expected then return nil, "inflate: size mismatch" end
  local parts = {}
  for p = 1, outn, 4096 do
    parts[#parts + 1] = char(unpack(out, p, math.min(p + 4095, outn)))
  end
  return table.concat(parts)
end

-- ---------------------------------------------------------------------------------------------------- byte helpers

local function u16(s, p) local a, b = byte(s, p, p + 1); return a + b * 256 end
local function u32(s, p) local a, b, c, d = byte(s, p, p + 3); return a + b * 256 + c * 65536 + d * 16777216 end
local function ext_of(name) return (tostring(name):match("(%.[^%.\\/]+)$") or ""):lower() end

local function read_all(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local s = f:read("*a")
  f:close()
  return s
end

local function file_size(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local size = f:seek("end")
  f:close()
  return size
end

-- ------------------------------------------------------------------------------------------------ cartridge rules

--- Applies a function to every byte of a string through a byte table (only for N64 and SMD, which need it).
local function remap(s, fn)
  local n = #s
  local src, dst = {}, {}
  for p = 1, n, 4096 do
    local chunk = { byte(s, p, math.min(p + 4095, n)) }
    for k = 1, #chunk do src[p + k - 1] = chunk[k] end
  end
  fn(src, dst, n)
  local parts = {}
  for p = 1, n, 4096 do parts[#parts + 1] = char(unpack(dst, p, math.min(p + 4095, n))) end
  return table.concat(parts)
end

function M.strip_nes(s)
  if #s > 16 and sub(s, 1, 4) == "NES\26" then return sub(s, 17) end
  return s
end

function M.normalize_n64(s)
  if #s < 4 then return s end
  local b0, b1, b2, b3 = byte(s, 1, 4)
  if b0 == 0x37 and b1 == 0x80 and b2 == 0x40 and b3 == 0x12 then -- .v64: swap each 16-bit word
    return remap(s, function(src, dst, n)
      for i = 1, n do dst[i] = src[i] end
      for i = 1, n - 1, 2 do dst[i], dst[i + 1] = src[i + 1], src[i] end
    end)
  end
  if b0 == 0x40 and b1 == 0x12 and b2 == 0x37 and b3 == 0x80 then -- .n64: swap each 32-bit word
    return remap(s, function(src, dst, n)
      for i = 1, n do dst[i] = src[i] end
      for i = 1, n - 3, 4 do dst[i], dst[i + 1], dst[i + 2], dst[i + 3] = src[i + 3], src[i + 2], src[i + 1], src[i] end
    end)
  end
  return s
end

function M.normalize_smd(s)
  if not (#s > 512 and byte(s, 1) == 0xAA and byte(s, 2) == 0xBB and byte(s, 3) == 0x06) then return s end
  local raw = sub(s, 513)
  return remap(raw, function(src, dst, n)
    for i = 1, n do dst[i] = 0 end
    for start = 0, n - 1, 16384 do
      local size = math.min(16384, n - start)
      local half = math.min(8192, math.floor(size / 2))
      for j = 0, half - 1 do
        if start + 8192 + j < n then dst[start + 2 * j + 1] = src[start + 8192 + j + 1] end
        if start + j < n then dst[start + 2 * j + 2] = src[start + j + 1] end
      end
    end
  end)
end

function M.cartridge_md5(s)
  s = M.strip_nes(s)
  s = M.normalize_n64(s)
  s = M.normalize_smd(s)
  if #s % 1024 == 512 then s = sub(s, 513) end
  return M.md5(s), #s
end

-- ------------------------------------------------------------------------------------------------------- zip files

local CART_EXTS = { [".sfc"] = true, [".smc"] = true, [".nes"] = true, [".gba"] = true, [".gbc"] = true, [".gb"] = true,
  [".z64"] = true, [".n64"] = true, [".v64"] = true, [".gen"] = true, [".smd"] = true, [".md"] = true, [".bin"] = true,
  [".iso"] = true }
local CONSOLE_EXTS = { [".sfc"] = true, [".smc"] = true, [".nes"] = true, [".gba"] = true, [".z64"] = true }

--- The ROM inside a zip: { bytes, name } | { format = "arcade_zip" } | nil, err.
function M.zip_rom(z)
  if #z < 30 or u32(z, 1) ~= 0x04034b50 then return nil, "invalid_zip" end
  local eocd
  for p = #z - 21, math.max(1, #z - 65557), -1 do
    if byte(z, p) == 0x50 and sub(z, p, p + 3) == "PK\5\6" then eocd = p break end
  end
  if not eocd then return nil, "eocd_not_found" end
  local total, pos = u16(z, eocd + 10), u32(z, eocd + 16) + 1
  local entries = {}
  for _ = 1, total do
    if pos >= eocd or u32(z, pos) ~= 0x02014b50 then break end
    local fn_len, extra, comment = u16(z, pos + 28), u16(z, pos + 30), u16(z, pos + 32)
    entries[#entries + 1] = {
      method = u16(z, pos + 10), comp = u32(z, pos + 20), size = u32(z, pos + 24),
      local_offset = u32(z, pos + 42), name = sub(z, pos + 46, pos + 45 + fn_len),
    }
    pos = pos + 46 + fn_len + extra + comment
  end
  if #entries == 0 then return nil, "no_entries" end
  local chosen = entries[1]
  for _, e in ipairs(entries) do
    if CART_EXTS[ext_of(e.name)] then chosen = e break end
  end
  if #entries > 3 then
    local console = false
    for _, e in ipairs(entries) do if CONSOLE_EXTS[ext_of(e.name)] then console = true end end
    if not console then return { format = "arcade_zip", files = #entries } end
  end
  local lh = chosen.local_offset + 1
  if lh + 29 > #z or u32(z, lh) ~= 0x04034b50 then return nil, "invalid_local_header" end
  local start = lh + 30 + u16(z, lh + 26) + u16(z, lh + 28)
  if chosen.method == 0 then return { bytes = sub(z, start, start + chosen.size - 1), name = chosen.name } end
  if chosen.method ~= 8 then return nil, "unsupported_method_" .. tostring(chosen.method) end
  local bytes, err = M.inflate(sub(z, start, start + chosen.comp - 1), chosen.size)
  if not bytes then return nil, "inflate_failed: " .. tostring(err) end
  return { bytes = bytes, name = chosen.name }
end

-- ------------------------------------------------------------------------------------------------------ entry point

--- The path an `.m3u` entry names: absolute as written, otherwise relative to the playlist's folder, joined with "/" (Windows accepts it;
--- a backslash join never resolves on Linux). Public so a test can see the string, which the file system cannot show on Windows.
function M.m3u_entry_path(dir, entry)
  if entry:match("^%a:[\\/]") or entry:match("^[\\/]") then return entry end
  return dir .. "/" .. entry
end

local function resolve_m3u(path)
  local text = read_all(path) or ""
  local dir = path:match("^(.*)[\\/][^\\/]*$") or "."
  for line in text:gmatch("[^\r\n]+") do
    local t = line:gsub("^%s+", ""):gsub("%s+$", "")
    if t ~= "" and t:sub(1, 1) ~= "#" then
      local full = M.m3u_entry_path(dir, t)
      if file_size(full) then return full end
    end
  end
  return nil
end

--- { md5, size, format? } for a ROM or disc image, or { format = "chd" | "arcade_zip" | "large_disc", md5 = nil }, or
--- nil and an error ("file_not_found", a zip problem).
local DISC_EXTS = { [".cue"] = true, [".gdi"] = true, [".iso"] = true, [".bin"] = true, [".cso"] = true, [".chd"] = true }

function M.rom_md5(path, depth)
  local size = file_size(path)
  if not size then return nil, "file_not_found" end
  local ext = ext_of(path)
  if ext == ".m3u" and (depth or 0) < 4 then
    local disc = resolve_m3u(path)
    if disc then return M.rom_md5(disc, (depth or 0) + 1) end
  end
  if ext == ".pbp" then
    -- a PSP EBOOT.PBP: RetroAchievements hashes the whole file (its first 64 MB)
    local f = io.open(path, "rb")
    if not f then return nil, "file_not_found" end
    local stream, left = M.md5_stream(), math.min(size, 64 * 1024 * 1024)
    while left > 0 do
      local chunk = f:read(math.min(left, 65536))
      if not chunk or chunk == "" then break end
      stream.update(chunk)
      left = left - #chunk
    end
    f:close()
    return { md5 = stream.final(), size = size, format = "pbp" }
  end
  if DISC_EXTS[ext] then
    local r, why = require("disc_hash").hash(path)
    if r then
      r.size = size
      return r
    end
    -- a .bin that holds no disc is a cartridge (Genesis); every other disc image left unread has no usable hash
    if ext ~= ".bin" then return { format = ext == ".chd" and "chd" or "disc_unrecognized", size = size, reason = why } end
  end
  local bytes
  if ext == ".zip" then
    local z = read_all(path)
    if not z then return nil, "file_not_found" end
    local rom, err = M.zip_rom(z)
    if not rom then return nil, err end
    if rom.format then return rom end
    bytes = rom.bytes
  else
    if size > M.MAX_PLAIN then return { format = "large_disc", size = size } end
    bytes = read_all(path)
    if not bytes then return nil, "file_not_found" end
  end
  local md5, len = M.cartridge_md5(bytes)
  return { md5 = md5, size = len }
end

return M
