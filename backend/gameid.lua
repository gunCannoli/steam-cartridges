--- Converts between Steam's two ids for a non-Steam game.
---
---   appid  - 32-bit, used in shortcuts.vdf and library URLs (/library/app/<appid>)
---   gameid - 64-bit, used for screenshot folders and recordings
---
---   gameid = (appid << 32) | 0x02000000
---   appid  = gameid >> 32
---
--- Verified against all 9 non-Steam screenshot folders on the dev machine: the
--- low word was 0x02000000 in every case and the high word matched a shortcut.
---
--- Lua numbers are doubles, so a 64-bit gameid (up to ~1.8e19) cannot be held
--- exactly as a number. We format gameids as decimal STRINGS and do the 64-bit
--- arithmetic by hand on 32-bit halves.

local gameid = {}

local SHORTCUT_LOW_WORD = 0x02000000 -- 33554432
local TWO_32            = 4294967296

--- Multiply a decimal string by 2^32 and add the low word, without ever
--- exceeding 2^53 in intermediate values. Works in base 10^7 chunks.
---@param high integer appid (unsigned 32-bit)
---@param low integer low dword
---@return string decimal
local function compose(high, low)
  -- Represent the result as base-10^7 limbs, little-endian.
  local BASE = 10000000
  local limbs = { 0 }

  ---@param n integer
  local function add(n)
    local carry = n
    local idx = 1
    while carry > 0 do
      local sum = (limbs[idx] or 0) + carry
      limbs[idx] = sum % BASE
      carry = math.floor(sum / BASE)
      idx = idx + 1
    end
  end

  ---@param m integer
  local function mul(m)
    local carry = 0
    for idx = 1, #limbs do
      local product = limbs[idx] * m + carry
      limbs[idx] = product % BASE
      carry = math.floor(product / BASE)
    end
    while carry > 0 do
      limbs[#limbs + 1] = carry % BASE
      carry = math.floor(carry / BASE)
    end
  end

  add(high)
  -- 2^32 = 65536 * 65536; both factors keep limb*m well under 2^53.
  mul(65536)
  mul(65536)
  add(low)

  local out = { tostring(limbs[#limbs]) }
  for idx = #limbs - 1, 1, -1 do
    out[#out + 1] = string.format("%07d", limbs[idx])
  end
  return table.concat(out)
end

--- appid -> 64-bit gameid, as a decimal string.
---@param appid integer
---@return string gameid
function gameid.from_appid(appid)
  return compose(appid % TWO_32, SHORTCUT_LOW_WORD)
end

--- 64-bit gameid (decimal string) -> appid.
--- Divides the decimal string by 2^32 without overflowing.
---@param id string|integer
---@return integer|nil appid
function gameid.to_appid(id)
  local digits = tostring(id):match("^%s*(%d+)%s*$")
  if not digits then return nil end

  -- Long division by 65536, twice.
  ---@param str string
  ---@return string quotient
  local function div65536(str)
    local out, remainder = {}, 0
    for pos = 1, #str do
      local value = remainder * 10 + tonumber(str:sub(pos, pos))
      local digit = math.floor(value / 65536)
      remainder = value % 65536
      if #out > 0 or digit > 0 then out[#out + 1] = tostring(digit) end
    end
    return #out > 0 and table.concat(out) or "0"
  end

  local appid = tonumber(div65536(div65536(digits)))
  if not appid or appid <= 0 or appid >= TWO_32 then return nil end
  return appid
end

--- Is this a non-Steam game's gameid (rather than a plain Steam appid)?
---@param id string|integer
---@return boolean
function gameid.is_non_steam(id)
  local digits = tostring(id):match("^%s*(%d+)%s*$")
  if not digits then return false end
  -- Anything above 2^32 is a composed shortcut gameid. Compare by length first
  -- to avoid converting huge values to floats.
  if #digits > 10 then return true end
  if #digits < 10 then return false end
  return digits > "4294967295"
end

return gameid
