--- Raw LZMA (LZMA1) decoder in pure Lua, for CHD hunks (chdman's `lzma` / `cdlz` codecs): no header, no end marker needed, the
--- output size is known. After the LZMA specification's reference decoder (LzmaSpec.cpp). Runs in the backend's interpreter
--- (main.lua turns the JIT off): a few hundred KB per second, so the callers decode only the hunks they need.
---
---   decode(src, outsize, lc, lp, pb) -> string | nil, error      chdman: lc = 3, lp = 0, pb = 2

local bit = require("bit")
local rshift, band = bit.rshift, bit.band
local byte, char = string.byte, string.char
local unpack = unpack or table.unpack

local M = {}

local function probs(n)
  local t = {}
  for i = 0, n - 1 do t[i] = 1024 end
  return t
end

function M.decode(src, outsize, lc, lp, pb)
  lc, lp, pb = lc or 3, lp or 0, pb or 2
  if #src < 5 or byte(src, 1) ~= 0 then return nil, "lzma: bad stream start" end
  local pos = 6
  local range = 4294967295
  local code = byte(src, 2) * 16777216 + byte(src, 3) * 65536 + byte(src, 4) * 256 + byte(src, 5)

  local function bitdec(p, i)
    local pr = p[i]
    local bound = rshift(range, 11) * pr
    local b
    if code < bound then
      range = bound
      p[i] = pr + rshift(2048 - pr, 5)
      b = 0
    else
      range = range - bound
      code = code - bound
      p[i] = pr - rshift(pr, 5)
      b = 1
    end
    if range < 16777216 then
      range = range * 256
      code = code * 256 + (byte(src, pos) or 0)
      pos = pos + 1
    end
    return b
  end

  local function direct(n)
    local res = 0
    for _ = 1, n do
      range = rshift(range, 1)
      local b = 0
      if code >= range then
        code = code - range
        b = 1
      end
      if range < 16777216 then
        range = range * 256
        code = code * 256 + (byte(src, pos) or 0)
        pos = pos + 1
      end
      res = res * 2 + b
    end
    return res
  end

  local function tree(p, base, nbits)
    local m = 1
    for _ = 1, nbits do m = m * 2 + bitdec(p, base + m) end
    return m - 2 ^ nbits
  end

  local function rtree(p, base, nbits)
    local m, sym = 1, 0
    for i = 0, nbits - 1 do
      local b = bitdec(p, base + m)
      m = m * 2 + b
      sym = sym + b * 2 ^ i
    end
    return sym
  end

  local lit = probs(0x300 * 2 ^ (lc + lp))
  local is_match, is_rep, is_g0, is_g1, is_g2, is_rep0long = probs(192), probs(12), probs(12), probs(12), probs(12), probs(192)
  local pos_slot = { probs(64), probs(64), probs(64), probs(64) }
  local pos_dec, align = probs(115), probs(16)
  local function len_coder() return { choice = probs(2), low = probs(16 * 8), mid = probs(16 * 8), high = probs(256) } end
  local lenc, replenc = len_coder(), len_coder()

  local function len_dec(c, ps)
    if bitdec(c.choice, 0) == 0 then return tree(c.low, ps * 8, 3) end
    if bitdec(c.choice, 1) == 0 then return 8 + tree(c.mid, ps * 8, 3) end
    return 16 + tree(c.high, 0, 8)
  end

  local out, n = {}, 0
  local state, rep0, rep1, rep2, rep3 = 0, 0, 0, 0, 0
  local pbmask, lpmask = 2 ^ pb - 1, 2 ^ lp - 1

  while n < outsize do
    if pos > #src + 8 then return nil, "lzma: out of input" end
    local ps = band(n, pbmask)
    if bitdec(is_match, state * 16 + ps) == 0 then
      local prev = n > 0 and out[n] or 0
      local base = 0x300 * (band(n, lpmask) * 2 ^ lc + rshift(prev, 8 - lc))
      local sym = 1
      if state >= 7 then
        local mb = out[n - rep0] or 0
        while sym < 256 do
          local mbit = band(rshift(mb, 7), 1)
          mb = band(mb * 2, 255)
          local b = bitdec(lit, base + (1 + mbit) * 256 + sym)
          sym = sym * 2 + b
          if mbit ~= b then break end
        end
      end
      while sym < 256 do sym = sym * 2 + bitdec(lit, base + sym) end
      n = n + 1
      out[n] = sym - 256
      state = state < 4 and 0 or (state < 10 and state - 3 or state - 6)
    else
      local len
      if bitdec(is_rep, state) == 0 then
        rep3, rep2, rep1 = rep2, rep1, rep0
        len = len_dec(lenc, ps)
        state = state < 7 and 7 or 10
        local ls = len < 3 and len or 3
        local slot = tree(pos_slot[ls + 1], 0, 6)
        if slot < 4 then
          rep0 = slot
        else
          local nd = rshift(slot, 1) - 1
          local dist = (2 + band(slot, 1)) * 2 ^ nd
          if slot < 14 then
            dist = dist + rtree(pos_dec, dist - slot, nd)
          else
            dist = dist + direct(nd - 4) * 16 + rtree(align, 0, 4)
          end
          rep0 = dist
        end
        if rep0 == 4294967295 then break end -- end marker
      else
        if n == 0 then return nil, "lzma: bad stream" end
        if bitdec(is_g0, state) == 0 then
          if bitdec(is_rep0long, state * 16 + ps) == 0 then
            state = state < 7 and 9 or 11
            n = n + 1
            out[n] = out[n - 1 - rep0] or 0
            goto continue
          end
        else
          local dist
          if bitdec(is_g1, state) == 0 then
            dist = rep1
          else
            if bitdec(is_g2, state) == 0 then
              dist = rep2
            else
              dist = rep3
              rep3 = rep2
            end
            rep2 = rep1
          end
          rep1, rep0 = rep0, dist
        end
        len = len_dec(replenc, ps)
        state = state < 7 and 8 or 11
      end
      len = len + 2
      if rep0 >= n then return nil, "lzma: distance too far" end
      if n + len > outsize then len = outsize - n end
      for _ = 1, len do
        n = n + 1
        out[n] = out[n - 1 - rep0]
      end
    end
    ::continue::
  end
  if n < outsize then return nil, "lzma: short output" end
  local parts = {}
  for p = 1, n, 4096 do parts[#parts + 1] = char(unpack(out, p, math.min(p + 4095, n))) end
  return table.concat(parts)
end

return M
