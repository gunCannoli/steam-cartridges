--- FLAC frame decoder in Lua for CHD's `cdfl` codec (chdman may pick FLAC for a hunk of a data track that is all zeros or
--- very repetitive): a stream of FLAC frames with no file header, 16-bit stereo, decoded to the 2352-byte CD sector bytes.
---
---   decode(src, pairs) -> string of pairs * 4 bytes | nil, error

local byte, char = string.byte, string.char
local unpack = unpack or table.unpack
local floor = math.floor

local M = {}

local function reader(s)
  return { s = s, pos = 0 }
end

local function bits(r, n)
  local v, need = 0, n
  while need > 0 do
    local cur = byte(r.s, floor(r.pos / 8) + 1)
    if not cur then error("flac: out of input", 0) end
    local avail = 8 - r.pos % 8
    local take = need < avail and need or avail
    v = v * 2 ^ take + floor(cur / 2 ^ (avail - take)) % 2 ^ take
    r.pos = r.pos + take
    need = need - take
  end
  return v
end

local function sbits(r, n)
  if n == 0 then return 0 end
  local v = bits(r, n)
  if v >= 2 ^ (n - 1) then v = v - 2 ^ n end
  return v
end

local function unary(r)
  local n = 0
  while bits(r, 1) == 0 do n = n + 1 end
  return n
end

local function residual(r, order, blocksize, out)
  local method = bits(r, 2)
  if method > 1 then error("flac: bad residual", 0) end
  local po = bits(r, 4)
  local parts = 2 ^ po
  local pbits = method == 0 and 4 or 5
  local escape = method == 0 and 15 or 31
  local n = order
  for p = 0, parts - 1 do
    local count = floor(blocksize / parts) - (p == 0 and order or 0)
    local k = bits(r, pbits)
    if k == escape then
      local width = bits(r, 5)
      for _ = 1, count do
        n = n + 1
        out[n] = sbits(r, width)
      end
    else
      for _ = 1, count do
        local q = unary(r)
        local v = q * 2 ^ k + (k > 0 and bits(r, k) or 0)
        n = n + 1
        out[n] = (v % 2 == 0) and v / 2 or -(v + 1) / 2
      end
    end
  end
end

local function subframe(r, blocksize, bps)
  if bits(r, 1) ~= 0 then error("flac: bad subframe", 0) end
  local t = bits(r, 6)
  local wasted = 0
  if bits(r, 1) == 1 then wasted = unary(r) + 1 end
  bps = bps - wasted
  local out = {}
  if t == 0 then
    local v = sbits(r, bps)
    for i = 1, blocksize do out[i] = v end
  elseif t == 1 then
    for i = 1, blocksize do out[i] = sbits(r, bps) end
  elseif t >= 8 and t <= 12 then
    local order = t - 8
    for i = 1, order do out[i] = sbits(r, bps) end
    local res = {}
    residual(r, order, blocksize, res)
    for i = order + 1, blocksize do
      local x, r0 = 0, res[i]
      if order == 1 then x = out[i - 1]
      elseif order == 2 then x = 2 * out[i - 1] - out[i - 2]
      elseif order == 3 then x = 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]
      elseif order == 4 then x = 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4] end
      out[i] = x + r0
    end
  elseif t >= 32 then
    local order = t - 31
    for i = 1, order do out[i] = sbits(r, bps) end
    local prec = bits(r, 4) + 1
    local shift = sbits(r, 5)
    local coef = {}
    for j = 1, order do coef[j] = sbits(r, prec) end
    local res = {}
    residual(r, order, blocksize, res)
    local div = 2 ^ shift
    for i = order + 1, blocksize do
      local sum = 0
      for j = 1, order do sum = sum + coef[j] * out[i - j] end
      out[i] = res[i] + floor(sum / div)
    end
  else
    error("flac: bad subframe type", 0)
  end
  if wasted > 0 then
    local m = 2 ^ wasted
    for i = 1, blocksize do out[i] = out[i] * m end
  end
  return out
end

local BLOCK = { [1] = 192, [2] = 576, [3] = 1152, [4] = 2304, [5] = 4608, [8] = 256, [9] = 512, [10] = 1024, [11] = 2048, [12] = 4096,
  [13] = 8192, [14] = 16384, [15] = 32768 }

function M.decode(src, npairs)
  local r = reader(src)
  local L, R, n = {}, {}, 0
  local ok, err = pcall(function()
    while n < npairs do
      r.pos = math.ceil(r.pos / 8) * 8
      if bits(r, 14) ~= 0x3FFE then error("flac: lost sync", 0) end
      bits(r, 2)
      local bsc, src_ = bits(r, 4), bits(r, 4)
      local chan, size = bits(r, 4), bits(r, 3)
      bits(r, 1)
      local first = bits(r, 8)
      local extra = first >= 0xFC and 5 or first >= 0xF8 and 4 or first >= 0xF0 and 3 or first >= 0xE0 and 2 or first >= 0xC0 and 1 or 0
      for _ = 1, extra do bits(r, 8) end
      local blocksize = BLOCK[bsc]
      if bsc == 6 then blocksize = bits(r, 8) + 1 elseif bsc == 7 then blocksize = bits(r, 16) + 1 end
      if not blocksize then error("flac: bad block size", 0) end
      if src_ == 12 then bits(r, 8) elseif src_ == 13 or src_ == 14 then bits(r, 16) end
      bits(r, 8) -- header CRC
      local bps = ({ [0] = 16, 8, 12, 0, 16, 20, 24 })[size] or 16
      local a, b
      if chan <= 1 then
        a = subframe(r, blocksize, bps)
        if chan == 1 then b = subframe(r, blocksize, bps) end
        if not b then b = a end
      elseif chan == 8 then
        a, b = subframe(r, blocksize, bps), subframe(r, blocksize, bps + 1)
        for i = 1, blocksize do b[i] = a[i] - b[i] end
      elseif chan == 9 then
        a, b = subframe(r, blocksize, bps + 1), subframe(r, blocksize, bps)
        for i = 1, blocksize do a[i] = b[i] + a[i] end
      elseif chan == 10 then
        local mid, side = subframe(r, blocksize, bps), subframe(r, blocksize, bps + 1)
        a, b = {}, {}
        for i = 1, blocksize do
          local m = mid[i] * 2 + side[i] % 2
          a[i] = floor((m + side[i]) / 2)
          b[i] = floor((m - side[i]) / 2)
        end
      else
        error("flac: unsupported channel layout", 0)
      end
      r.pos = math.ceil(r.pos / 8) * 8 + 16 -- frame CRC
      for i = 1, blocksize do
        n = n + 1
        L[n], R[n] = a[i], b[i]
      end
    end
  end)
  if not ok then return nil, tostring(err) end
  -- CD sector bytes: chdman stores each 16-bit sample high byte first (checked against chdman's own output)
  local parts = {}
  for p = 1, npairs, 1024 do
    local chunk = {}
    for i = p, math.min(p + 1023, npairs) do
      local l, rr = L[i] % 65536, R[i] % 65536
      local k = #chunk
      chunk[k + 1], chunk[k + 2], chunk[k + 3], chunk[k + 4] = floor(l / 256), l % 256, floor(rr / 256), rr % 256
    end
    parts[#parts + 1] = char(unpack(chunk))
  end
  return table.concat(parts)
end

return M
