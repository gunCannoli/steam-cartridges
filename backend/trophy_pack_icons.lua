--- steam-cartridges - trophy icons from a PS4 game's own trophy pack (sce_sys/trophy/trophy00.trp), as data: URLs.
---
--- A trophy pack encrypts its .ESFM files (the trophy list) but stores its PNGs plain: TROP000.PNG ... one per trophy,
--- 240x240 on Bloodborne (CUSA03173). Steam's page is https://steamloopback.host, which may not load file:/// images,
--- so each icon is shrunk to Steam's own achievement icon size (64x64, area average) and returned as a small PNG data
--- URL. Only 8-bit RGB / RGBA, non-interlaced PNGs are read (every icon in that pack); anything else is skipped.
---
--- Runs in the backend's interpreter (main.lua turns the JIT off). The caller keeps the answer in its schema, so a pack
--- is read once.

local bit = require("bit")
local band, bor, bxor, bnot, lshift, rshift = bit.band, bit.bor, bit.bxor, bit.bnot, bit.lshift, bit.rshift
local byte, char, sub, concat = string.byte, string.char, string.sub, table.concat

local M = {}

--- Steam's achievement icon size.
M.SIZE = 64

local function u32be(s, p)
  local a, b, c, d = byte(s, p, p + 3)
  if not d then return nil end
  return ((a * 256 + b) * 256 + c) * 256 + d
end

local function u64be(s, p)
  local hi, lo = u32be(s, p), u32be(s, p + 4)
  if not lo then return nil end
  return hi * 4294967296 + lo
end

local function be32(n)
  return char(band(rshift(n, 24), 255), band(rshift(n, 16), 255), band(rshift(n, 8), 255), band(n, 255))
end

-- ------------------------------------------------------------------------------------------------ trophy pack

--- The PNG entries of a trophy pack: { [name] = { offset, size } } (names upper-case, "TROP005.PNG"), or nil and why.
function M.trp_entries(path)
  local f = io.open(path, "rb")
  if not f then return nil, "cannot open " .. tostring(path) end
  local head = f:read(0x60) or ""
  if u32be(head, 1) ~= 0xDCA24D00 then f:close() return nil, "not a trophy pack" end
  local version, count, esize = u32be(head, 5), u32be(head, 17), u32be(head, 21)
  if not count or count == 0 or count > 4096 or not esize or esize < 48 or esize > 256 then
    f:close()
    return nil, "bad trophy pack header"
  end
  f:seek("set", version == 1 and 0x40 or 0x60)
  local tbl = f:read(count * esize) or ""
  f:close()
  if #tbl < count * esize then return nil, "truncated trophy pack" end
  local out = {}
  for i = 0, count - 1 do
    local o = i * esize + 1
    local name = (sub(tbl, o, o + 31):match("^[^%z]*") or ""):upper()
    if name:match("%.PNG$") then out[name] = { offset = u64be(tbl, o + 32), size = u64be(tbl, o + 40) } end
  end
  return out
end

--- One entry's bytes.
function M.trp_read(path, entry)
  local f = io.open(path, "rb")
  if not f then return nil end
  f:seek("set", entry.offset)
  local data = f:read(entry.size)
  f:close()
  return data
end

-- ------------------------------------------------------------------------------------------------ PNG in

local function paeth(a, b, c)
  local p = a + b - c
  local pa, pb, pc = math.abs(p - a), math.abs(p - b), math.abs(p - c)
  if pa <= pb and pa <= pc then return a elseif pb <= pc then return b end
  return c
end

--- Decodes an 8-bit RGB / RGBA non-interlaced PNG: { w, h, ch, rows = { [y] = { bytes } } }, or nil and why.
function M.decode_png(png)
  if sub(png or "", 1, 8) ~= "\137PNG\r\n\26\n" then return nil, "not a PNG" end
  local pos, w, h, ch, idat = 9, nil, nil, nil, {}
  while pos + 8 <= #png do
    local len, ctype = u32be(png, pos), sub(png, pos + 4, pos + 7)
    local body = sub(png, pos + 8, pos + 7 + len)
    if ctype == "IHDR" then
      w, h = u32be(body, 1), u32be(body, 5)
      local depth, color, interlace = byte(body, 9), byte(body, 10), byte(body, 13)
      if depth ~= 8 or interlace ~= 0 or (color ~= 2 and color ~= 6) then return nil, "unsupported PNG format" end
      ch = color == 6 and 4 or 3
    elseif ctype == "IDAT" then
      idat[#idat + 1] = body
    elseif ctype == "IEND" then
      break
    end
    pos = pos + 12 + len
  end
  if not w or #idat == 0 or w > 4096 or h > 4096 then return nil, "no image data" end
  local stride = w * ch
  -- zlib: a 2-byte header, raw DEFLATE, a 4-byte checksum.
  local raw, err = require("rom_hash").inflate(sub(concat(idat), 3), h * (stride + 1))
  if not raw then return nil, err end
  local rows, prev = {}, {}
  for x = 1, stride do prev[x] = 0 end
  local p = 1
  for y = 1, h do
    local filter = byte(raw, p)
    local cur = { byte(raw, p + 1, p + stride) }
    p = p + stride + 1
    if filter == 1 then
      for x = ch + 1, stride do cur[x] = band(cur[x] + cur[x - ch], 255) end
    elseif filter == 2 then
      for x = 1, stride do cur[x] = band(cur[x] + prev[x], 255) end
    elseif filter == 3 then
      for x = 1, stride do cur[x] = band(cur[x] + math.floor(((cur[x - ch] or 0) + prev[x]) / 2), 255) end
    elseif filter == 4 then
      for x = 1, stride do
        cur[x] = band(cur[x] + paeth(cur[x - ch] or 0, prev[x], prev[x - ch] or 0), 255)
      end
    elseif filter ~= 0 then
      return nil, "bad PNG filter"
    end
    rows[y] = cur
    prev = cur
  end
  return { w = w, h = h, ch = ch, rows = rows }
end

-- ------------------------------------------------------------------------------------------------ resize

--- For each output index, the source indices (1-based) it covers and their share: an area average.
local function spans(src, dst)
  local scale, out = src / dst, {}
  for o = 0, dst - 1 do
    local a, b, list = o * scale, (o + 1) * scale, {}
    for s = math.floor(a), math.ceil(b) - 1 do
      local wgt = math.min(b, s + 1) - math.max(a, s)
      if wgt > 0 then list[#list + 1] = { s + 1, wgt / scale } end
    end
    out[o + 1] = list
  end
  return out
end

--- Shrinks an image to size x size. RGBA is averaged premultiplied, so transparent pixels add no colour.
function M.resize(img, size)
  local ch, xs, ys = img.ch, spans(img.w, size), spans(img.h, size)
  -- Horizontal pass: every source row to `size` pixels (premultiplied when there is alpha).
  local tmp = {}
  for y = 1, img.h do
    local row, out = img.rows[y], {}
    for ox = 1, size do
      local r, g, b, a = 0, 0, 0, 0
      for _, t in ipairs(xs[ox]) do
        local i, wgt = (t[1] - 1) * ch, t[2]
        if ch == 4 then
          local al = row[i + 4] / 255
          r, g, b, a = r + row[i + 1] * al * wgt, g + row[i + 2] * al * wgt, b + row[i + 3] * al * wgt, a + al * wgt
        else
          r, g, b = r + row[i + 1] * wgt, g + row[i + 2] * wgt, b + row[i + 3] * wgt
        end
      end
      local k = (ox - 1) * 4
      out[k + 1], out[k + 2], out[k + 3], out[k + 4] = r, g, b, a
    end
    tmp[y] = out
  end
  -- Vertical pass, then back to straight bytes.
  local rows = {}
  for oy = 1, size do
    local out = {}
    for ox = 1, size do
      local k = (ox - 1) * 4
      local r, g, b, a = 0, 0, 0, 0
      for _, t in ipairs(ys[oy]) do
        local src, wgt = tmp[t[1]], t[2]
        r, g, b, a = r + src[k + 1] * wgt, g + src[k + 2] * wgt, b + src[k + 3] * wgt, a + src[k + 4] * wgt
      end
      local j = (ox - 1) * ch
      if ch == 4 then
        local inv = a > 0 and 1 / a or 0
        out[j + 1] = math.min(255, math.floor(r * inv + 0.5))
        out[j + 2] = math.min(255, math.floor(g * inv + 0.5))
        out[j + 3] = math.min(255, math.floor(b * inv + 0.5))
        out[j + 4] = math.min(255, math.floor(a * 255 + 0.5))
      else
        out[j + 1] = math.min(255, math.floor(r + 0.5))
        out[j + 2] = math.min(255, math.floor(g + 0.5))
        out[j + 3] = math.min(255, math.floor(b + 0.5))
      end
    end
    rows[oy] = out
  end
  return { w = size, h = size, ch = ch, rows = rows }
end

-- ------------------------------------------------------------------------------------------------ PNG out

local CRC = {}
for n = 0, 255 do
  local c = n
  for _ = 1, 8 do c = band(c, 1) == 1 and bxor(0xEDB88320, rshift(c, 1)) or rshift(c, 1) end
  CRC[n] = c
end

local function crc32(s)
  local c = bnot(0)
  for i = 1, #s do c = bxor(CRC[band(bxor(c, byte(s, i)), 255)], rshift(c, 8)) end
  return bnot(c)
end

local function adler32(s)
  local a, b = 1, 0
  for i = 1, #s do
    a = (a + byte(s, i)) % 65521
    b = (b + a) % 65521
  end
  return b * 65536 + a
end

local function chunk(ctype, body)
  return be32(#body) .. ctype .. body .. be32(crc32(ctype .. body))
end

--- Encodes an image as a PNG: filter 0 rows in stored (uncompressed) DEFLATE blocks.
function M.encode_png(img)
  local parts = {}
  for y = 1, img.h do
    local row = img.rows[y]
    parts[#parts + 1] = "\0"
    for x = 1, #row, 4096 do parts[#parts + 1] = char(unpack(row, x, math.min(x + 4095, #row))) end
  end
  local raw = concat(parts)
  local blocks, p = { "\120\1" }, 1
  repeat
    local piece = sub(raw, p, p + 65534)
    p = p + #piece
    local n = #piece
    blocks[#blocks + 1] = char(p > #raw and 1 or 0, band(n, 255), rshift(n, 8), band(bnot(n), 255), band(rshift(bnot(n), 8), 255))
    blocks[#blocks + 1] = piece
  until p > #raw
  blocks[#blocks + 1] = be32(adler32(raw))
  local ihdr = be32(img.w) .. be32(img.h) .. char(8, img.ch == 4 and 6 or 2, 0, 0, 0)
  return "\137PNG\r\n\26\n" .. chunk("IHDR", ihdr) .. chunk("IDAT", concat(blocks)) .. chunk("IEND", "")
end

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function M.base64(s)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = byte(s, i, i + 2)
    local n = lshift(a, 16) + lshift(b or 0, 8) + (c or 0)
    local q1, q2 = rshift(n, 18) + 1, band(rshift(n, 12), 63) + 1
    local q3, q4 = band(rshift(n, 6), 63) + 1, band(n, 63) + 1
    out[#out + 1] = sub(B64, q1, q1) .. sub(B64, q2, q2) .. (b and sub(B64, q3, q3) or "=") .. (c and sub(B64, q4, q4) or "=")
  end
  return concat(out)
end

--- A PNG's bytes shrunk to size x size, as a data: URL, or nil and why.
function M.icon_url(png, size)
  local img, err = M.decode_png(png)
  if not img then return nil, err end
  return "data:image/png;base64," .. M.base64(M.encode_png(M.resize(img, size or M.SIZE)))
end

--- Every trophy icon of a pack: { [trophy id] = data URL } (TROP000.PNG is id 0). Missing or unreadable icons are left
--- out. Returns nil and why when the pack cannot be read.
function M.from_trp(path, ids, size)
  local entries, err = M.trp_entries(path)
  if not entries then return nil, err end
  local out = {}
  for _, id in ipairs(ids) do
    local e = entries[string.format("TROP%03d.PNG", id)]
    local png = e and M.trp_read(path, e)
    local url = png and M.icon_url(png, size)
    if url then out[id] = url end
  end
  return out
end

return M
