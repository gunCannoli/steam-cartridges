--- CHD (MAME "Compressed Hunks of Data") v5 reader in Lua: just enough to read the sectors of a CD / GD-ROM / DVD image
--- for RetroAchievements hashing. After libchdr (header, map, metadata, hunk read) and MAME's chdman:
---   header v5 (124 bytes), compressed map (Huffman + RLE) or plain map, hunks stored as `none`, `self`, or by one of the
---   file's four codecs: cdlz (CD + LZMA), cdzl (CD + deflate), lzma, zlib, huff. Not read: cdfl / flac (audio only), cdzs /
---   zstd, parent files, versions below 5 (each answers a short reason; the caller falls back to title matching).
--- CD frames are 2448 bytes (2352 of sector data + 96 of subcode); a `cd*` hunk stores 2352 per frame (subcode dropped).
---
---   chd.open(path) -> chd | nil, reason
---   chd.hunk(chd, n) -> { data = string, stride = 2352 | 2448 } | nil, reason     (the last few hunks are kept)
---   chd.tracks -> list of { number, type, frames, start (frame in the file), pregap, pgtype, gdrom }  (CD / GD-ROM images)
---   chd.dvd -> true for a DVD image (cooked 2048-byte sectors)

local rom_hash = require("rom_hash")
local lzma_raw = require("lzma_raw")
local flac_raw = require("flac_raw")

local byte, sub = string.byte, string.sub
local M = {}

local function be(s, p, n)
  local v = 0
  for i = 0, n - 1 do v = v * 256 + (byte(s, p + i) or 0) end
  return v
end

-- ------------------------------------------------------------------------------------------------ bitstream, huffman

local function bits(s) return { s = s, pos = 0 } end

local function bread(b, n)
  local v, need = 0, n
  while need > 0 do
    local cur = byte(b.s, math.floor(b.pos / 8) + 1) or 0
    local avail = 8 - b.pos % 8
    local take = need < avail and need or avail
    v = v * 2 ^ take + math.floor(cur / 2 ^ (avail - take)) % 2 ^ take
    b.pos = b.pos + take
    need = need - take
  end
  return v
end

--- Canonical Huffman decoder from code lengths (index 0..n-1), as libchdr assigns the codes.
local function huff_build(lengths, n)
  local histo = {}
  for l = 0, 32 do histo[l] = 0 end
  for i = 0, n - 1 do histo[lengths[i]] = histo[lengths[i]] + 1 end
  local start = 0
  for l = 32, 1, -1 do
    local nextstart = math.floor((start + histo[l]) / 2)
    histo[l] = start
    start = nextstart
  end
  local by_len, maxlen = {}, 0
  for i = 0, n - 1 do
    local l = lengths[i]
    if l > 0 then
      by_len[l] = by_len[l] or {}
      by_len[l][histo[l]] = i
      histo[l] = histo[l] + 1
      if l > maxlen then maxlen = l end
    end
  end
  return { by_len = by_len, maxlen = maxlen }
end

local function huff_decode(h, b)
  local code = 0
  for l = 1, h.maxlen do
    code = code * 2 + bread(b, 1)
    local t = h.by_len[l]
    if t and t[code] then return t[code] end
  end
  error("chd: bad huffman code", 0)
end

--- libchdr huffman_import_tree_rle (the map's tree: 16 codes, 8 bits).
local function huff_import_rle(b, numcodes, maxbits)
  local numbits = maxbits >= 16 and 5 or (maxbits >= 8 and 4 or 3)
  local lengths, cur = {}, 0
  while cur < numcodes do
    local nb = bread(b, numbits)
    if nb ~= 1 then
      lengths[cur] = nb
      cur = cur + 1
    else
      nb = bread(b, numbits)
      if nb == 1 then
        lengths[cur] = 1
        cur = cur + 1
      else
        local rep = bread(b, numbits) + 3
        if cur + rep > numcodes then error("chd: bad huffman tree", 0) end
        for _ = 1, rep do
          lengths[cur] = nb
          cur = cur + 1
        end
      end
    end
  end
  return huff_build(lengths, numcodes)
end

--- libchdr huffman_import_tree_huffman (the `huff` codec's tree: 256 codes, 16 bits).
local function huff_import_huff(b, numcodes)
  local small = {}
  small[0] = bread(b, 3)
  local start, count = bread(b, 3) + 1, 0
  for i = 1, 23 do
    if i < start or count == 7 then
      small[i] = 0
    else
      count = bread(b, 3)
      small[i] = count == 7 and 0 or count
    end
  end
  local sh = huff_build(small, 24)
  local rlefullbits, temp = 0, numcodes - 9
  while temp ~= 0 do
    temp = math.floor(temp / 2)
    rlefullbits = rlefullbits + 1
  end
  local lengths, cur, last = {}, 0, 0
  while cur < numcodes do
    local v = huff_decode(sh, b)
    if v ~= 0 then
      last = v - 1
      lengths[cur] = last
      cur = cur + 1
    else
      local c = bread(b, 3) + 2
      if c == 9 then c = c + bread(b, rlefullbits) end
      while c > 0 and cur < numcodes do
        lengths[cur] = last
        cur = cur + 1
        c = c - 1
      end
    end
  end
  return huff_build(lengths, numcodes)
end

-- ------------------------------------------------------------------------------------------------------------- codecs

local function zlib_raw(src, destlen)
  local out, err = rom_hash.inflate(src, destlen)
  if not out then return nil, err end
  return out
end

local function huff_codec(src, destlen)
  local ok, res = pcall(function()
    local b = bits(src)
    local h = huff_import_huff(b, 256)
    local out = {}
    for i = 1, destlen do out[i] = string.char(huff_decode(h, b)) end
    return table.concat(out)
  end)
  if not ok then return nil, tostring(res) end
  return res
end

--- cdlz / cdzl: [ecc bitmap][base length, 2 or 3 bytes][base stream][subcode stream]; the base stream holds the frames'
--- 2352 sector bytes, back to back. The subcode is not needed and is not decoded.
local function cd_codec(base_fn)
  return function(src, destlen)
    local frames = math.floor(destlen / 2448)
    local lenbytes = destlen < 65536 and 2 or 3
    local ecc = math.floor((frames + 7) / 8)
    local hdr = ecc + lenbytes
    if #src < hdr then return nil, "chd: cd hunk too short" end
    local complen = be(src, ecc + 1, lenbytes)
    if #src < hdr + complen then return nil, "chd: cd hunk truncated" end
    local base, err = base_fn(sub(src, hdr + 1, hdr + complen), frames * 2352)
    if not base then return nil, err end
    return base, 2352
  end
end

--- cdfl: the sectors as FLAC audio, from the start of the hunk's data (no length header); the subcode is not needed.
local function cdfl_codec(src, destlen)
  local out, err = flac_raw.decode(src, math.floor(destlen / 2448) * 588)
  if not out then return nil, err end
  return out, 2352
end

local CODECS = {
  cdfl = cdfl_codec,
  zlib = zlib_raw,
  lzma = function(src, destlen) return lzma_raw.decode(src, destlen, 3, 0, 2) end,
  huff = huff_codec,
  cdzl = cd_codec(zlib_raw),
  cdlz = cd_codec(function(src, destlen) return lzma_raw.decode(src, destlen, 3, 0, 2) end),
}

-- ---------------------------------------------------------------------------------------------------------------- open

local function read_at(f, at, n)
  if not f:seek("set", at) then return nil end
  return f:read(n)
end

local function parse_map(chd, f)
  local h = chd
  local mapped = {}
  if h.compressors[1] == "" then -- uncompressed: one 4-byte hunk offset per hunk
    local raw = read_at(f, h.mapoffset, h.hunkcount * 4)
    if not raw or #raw < h.hunkcount * 4 then error("chd: map truncated", 0) end
    for i = 0, h.hunkcount - 1 do
      mapped[i] = { type = 4, length = h.hunkbytes, offset = be(raw, i * 4 + 1, 4) * h.hunkbytes }
    end
    return mapped
  end
  local head = read_at(f, h.mapoffset, 16)
  if not head or #head < 16 then error("chd: map truncated", 0) end
  local mapbytes, firstoffs = be(head, 1, 4), be(head, 5, 6)
  local lengthbits, selfbits, parentbits = byte(head, 13), byte(head, 14), byte(head, 15)
  local comp = read_at(f, h.mapoffset + 16, mapbytes)
  if not comp or #comp < mapbytes then error("chd: map truncated", 0) end
  local b = bits(comp)
  local dec = huff_import_rle(b, 16, 8)
  local types, rep, last = {}, 0, 0
  for i = 0, h.hunkcount - 1 do
    if rep > 0 then
      types[i] = last
      rep = rep - 1
    else
      local v = huff_decode(dec, b)
      if v == 7 then
        types[i], rep = last, 2 + huff_decode(dec, b)
      elseif v == 8 then
        local hi = huff_decode(dec, b)
        types[i], rep = last, 2 + 16 + hi * 16 + huff_decode(dec, b)
      else
        types[i], last = v, v
      end
    end
  end
  local cur, last_self = firstoffs, 0
  for i = 0, h.hunkcount - 1 do
    local t, e = types[i], { offset = cur, length = 0 }
    if t <= 3 then
      e.type, e.length = t, bread(b, lengthbits)
      cur = cur + e.length
      bread(b, 16)
    elseif t == 4 then
      e.type, e.length = 4, h.hunkbytes
      cur = cur + e.length
      bread(b, 16)
    elseif t == 5 then
      e.type = 5
      last_self = bread(b, selfbits)
      e.offset = last_self
    elseif t == 6 then
      e.type = 6
      bread(b, parentbits)
    elseif t == 10 or t == 9 then
      if t == 10 then last_self = last_self + 1 end
      e.type, e.offset = 5, last_self
    else
      e.type = 6 -- parent pseudo-types
    end
    mapped[i] = e
  end
  return mapped
end

local function parse_metadata(chd, f)
  local list, at, guard = {}, chd.metaoffset, 0
  while at ~= 0 and guard < 4096 do
    local hd = read_at(f, at, 16)
    if not hd or #hd < 16 then break end
    local tag, len, nxt = sub(hd, 1, 4), be(hd, 6, 3), be(hd, 9, 8)
    local data = read_at(f, at + 16, len) or ""
    list[#list + 1] = { tag = tag, data = (data:gsub("%z.*$", "")) }
    at, guard = nxt, guard + 1
  end
  return list
end

local function ceil4(n) return math.floor((n + 3) / 4) * 4 end

local function parse_tracks(chd, meta)
  local tracks, gd = {}, false
  for _, m in ipairs(meta) do
    local t = m.tag
    if t == "CHT2" or t == "CHTR" or t == "CHGD" or t == "CHGT" or t == "CHT\0" then
      local d = m.data
      local tr = {
        number = tonumber(d:match("TRACK:(%d+)")), type = d:match("TYPE:(%S+)") or "", frames = tonumber(d:match("FRAMES:(%d+)")) or 0,
        pregap = tonumber(d:match("PREGAP:(%d+)")) or 0, pgtype = d:match("PGTYPE:(%S+)") or "", gdrom = (t == "CHGD" or t == "CHGT"),
      }
      if tr.gdrom then gd = true end
      if tr.number then tracks[#tracks + 1] = tr end
    elseif t == "DVD\0" or t == "DVD " then
      chd.dvd = true
    end
  end
  table.sort(tracks, function(a, b) return a.number < b.number end)
  local frame = 0
  for _, tr in ipairs(tracks) do
    tr.start = frame
    frame = frame + ceil4(tr.frames)
  end
  chd.tracks, chd.gdrom = tracks, gd
end

function M.open(path)
  local f = io.open(path, "rb")
  if not f then return nil, "file_not_found" end
  local ok, chd, why = pcall(function()
    local h = read_at(f, 0, 124)
    if not h or #h < 124 or sub(h, 1, 8) ~= "MComprHD" then return nil, "chd_bad_header" end
    local version = be(h, 13, 4)
    if version ~= 5 then return nil, "chd_version_" .. version end
    local c = { path = path, file = f, cache = {}, cache_n = 0, compressors = {} }
    for i = 0, 3 do
      local tag = sub(h, 17 + i * 4, 20 + i * 4)
      c.compressors[i + 1] = tag == "\0\0\0\0" and "" or tag
    end
    c.logicalbytes, c.mapoffset, c.metaoffset = be(h, 33, 8), be(h, 41, 8), be(h, 49, 8)
    c.hunkbytes, c.unitbytes = be(h, 57, 4), be(h, 61, 4)
    if c.hunkbytes == 0 or c.unitbytes == 0 then return nil, "chd_bad_header" end
    if sub(h, 105, 124) ~= string.rep("\0", 20) then return nil, "chd_has_parent" end
    c.hunkcount = math.ceil(c.logicalbytes / c.hunkbytes)
    c.map = parse_map(c, f)
    parse_tracks(c, parse_metadata(c, f))
    return c
  end)
  if not ok then
    f:close()
    return nil, (tostring(chd):gsub("^chd: ", "chd_"))
  end
  if not chd then
    f:close()
    return nil, why
  end
  return chd
end

function M.close(chd)
  if chd and chd.file then
    chd.file:close()
    chd.file = nil
  end
end

local function decode_hunk(chd, n, depth)
  local e = chd.map[n]
  if not e then return nil, "chd_hunk_out_of_range" end
  if e.type == 4 then
    local d = read_at(chd.file, e.offset, chd.hunkbytes)
    if not d or #d < chd.hunkbytes then return nil, "chd_read_failed" end
    return { data = d, stride = 2448 }
  elseif e.type == 5 then
    if depth > 8 then return nil, "chd_self_loop" end
    return M.hunk(chd, e.offset, depth + 1)
  elseif e.type == 6 then
    return nil, "chd_has_parent"
  end
  local tag = chd.compressors[e.type + 1]
  local codec = CODECS[tag]
  if not codec then return nil, "chd_codec_" .. tostring(tag) end
  local src = read_at(chd.file, e.offset, e.length)
  if not src or #src < e.length then return nil, "chd_read_failed" end
  local data, extra = codec(src, chd.hunkbytes)
  if not data then return nil, "chd_" .. (tostring(extra):gsub("^chd: ", ""):gsub("%W", "_")) end
  return { data = data, stride = type(extra) == "number" and extra or 2448 }
end

function M.hunk(chd, n, depth)
  local c = chd.cache[n]
  if c then return c end
  local h, why = decode_hunk(chd, n, depth or 0)
  if not h then return nil, why end
  if chd.cache_n >= 12 then chd.cache, chd.cache_n = {}, 0 end
  chd.cache[n] = h
  chd.cache_n = chd.cache_n + 1
  return h
end

return M
