--- steam-cartridges - Pure JSON watch validator, value decoders & trigger evaluator for Achievement Packs.
---
--- Data only, never code (ADR-0081): validates `watch` (`file` and/or `memory`) and pure-JSON `when` triggers,
--- decodes typed binary/hex, JSON, INI, and text values (with optional composable transforms), and evaluates
--- trigger trees against `{ curr, prev }`.

local bit = require("bit")

local M = {}

M.TYPES = {
  u8 = 1, i8 = 1, bool = 1,
  u16 = 2, u16le = 2, u16be = 2, i16 = 2, i16le = 2, i16be = 2,
  u32 = 4, u32le = 4, u32be = 4, i32 = 4, i32le = 4, i32be = 4,
  u64 = 8, u64le = 8, u64be = 8,
  f32 = 4, f32le = 4, f32be = 4,
  f64 = 8, f64le = 8, f64be = 8,
  string = 0, bytes = 0,
}

M.OPS = {
  eq = true, ne = true, gt = true, gte = true, lt = true, lte = true,
  bit_set = true, bit_clear = true, mask_eq = true,
  contains = true, ["in"] = true,
  changed = true, increased = true, decreased = true,
}

M.FILE_FORMATS = { binary = true, json = true, ini = true, text = true, gms1_ds_list = true }

local function is_list(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end

--- Parse a hex ("0x1A2B") or decimal integer (or nil).
function M.parse_int(v)
  if type(v) == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return nil end
    return math.floor(v)
  end
  if type(v) ~= "string" then return nil end
  local s = v:match("^%s*(.-)%s*$")
  local neg = false
  if s:sub(1, 1) == "-" then neg = true s = s:sub(2):match("^%s*(.-)%s*$") end
  local hex = s:match("^0[xX](%x+)$")
  local n = hex and tonumber(hex, 16) or tonumber(s, 10)
  if not n then return nil end
  return neg and -math.floor(n) or math.floor(n)
end

--- Parse a hex byte string like "2E 01 00 00" or "2E010000" into raw bytes (or nil).
function M.parse_hex_bytes(s)
  if type(s) ~= "string" then return nil end
  local clean = s:gsub("[%s_%-]", ""):gsub("^0[xX]", "")
  if #clean == 0 or (#clean % 2) ~= 0 or clean:find("[^%x]") then return nil end
  return (clean:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end))
end

-- ------------------------------------------------------------------------------------------------ binary decoding

local ffi_ok, ffi = pcall(require, "ffi")
local F32_BUF = ffi_ok and ffi and ffi.new("union { uint8_t b[4]; float f; }") or nil
local F64_BUF = ffi_ok and ffi and ffi.new("union { uint8_t b[8]; double d; }") or nil

local function decode_float(bytes, pos, sz, be)
  if not ffi_ok or not ffi then return nil end
  local sub = bytes:sub(pos, pos + sz - 1)
  if #sub < sz then return nil end
  if be then sub = sub:reverse() end
  if sz == 4 then
    ffi.copy(F32_BUF.b, sub, 4)
    return tonumber(F32_BUF.f)
  else
    ffi.copy(F64_BUF.b, sub, 8)
    return tonumber(F64_BUF.d)
  end
end

--- Decode a typed value from `bytes` at 0-based `offset`.
function M.decode_value(bytes, offset, typ, size)
  if type(bytes) ~= "string" then return nil end
  local pos = (offset or 0) + 1
  if pos < 1 or pos > #bytes then return nil end

  if typ == "string" then
    local len = size or (#bytes - pos + 1)
    local sub = bytes:sub(pos, pos + len - 1)
    local nul = sub:find("\0", 1, true)
    return nul and sub:sub(1, nul - 1) or sub
  elseif typ == "bytes" then
    local len = size or 1
    local sub = bytes:sub(pos, pos + len - 1)
    if #sub < len then return nil end
    return (sub:gsub(".", function(c) return string.format("%02x", c:byte()) end))
  end

  local need = M.TYPES[typ]
  if not need or need <= 0 or (pos + need - 1) > #bytes then return nil end

  if typ == "u8" then
    return bytes:byte(pos)
  elseif typ == "i8" then
    local v = bytes:byte(pos)
    return v >= 128 and v - 256 or v
  elseif typ == "bool" then
    return bytes:byte(pos) ~= 0
  elseif typ == "f32" or typ == "f32le" then
    return decode_float(bytes, pos, 4, false)
  elseif typ == "f32be" then
    return decode_float(bytes, pos, 4, true)
  elseif typ == "f64" or typ == "f64le" then
    return decode_float(bytes, pos, 8, false)
  elseif typ == "f64be" then
    return decode_float(bytes, pos, 8, true)
  end

  local be = typ:sub(-2) == "be"
  local signed = typ:sub(1, 1) == "i"
  local v = 0
  if be then
    for i = 0, need - 1 do v = v * 256 + bytes:byte(pos + i) end
  else
    for i = need - 1, 0, -1 do v = v * 256 + bytes:byte(pos + i) end
  end
  if signed then
    local half = 2 ^ (need * 8 - 1)
    if v >= half then v = v - half * 2 end
  end
  return v
end

--- Byte length needed to read a variable spec from memory.
function M.byte_size(spec)
  local typ = spec.type
  if typ == "string" or typ == "bytes" then
    return math.max(1, math.min(1024, tonumber(spec.size) or 32))
  end
  return M.TYPES[typ] or 4
end

-- ------------------------------------------------------------------------------------------------ transforms

local B64 = {}
do
  local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for i = 1, #chars do B64[chars:byte(i)] = i - 1 end
end

local function base64_decode(s)
  local out = {}
  local buf, bits = 0, 0
  for i = 1, #s do
    local v = B64[s:byte(i)]
    if v then
      buf = buf * 64 + v
      bits = bits + 6
      if bits >= 8 then
        bits = bits - 8
        local byte = math.floor(buf / (2 ^ bits)) % 256
        out[#out + 1] = string.char(byte)
      end
    end
  end
  return table.concat(out)
end

local function apply_xor(s, mask, stride, phase)
  stride = stride or 1
  phase = phase or 0
  local out = {}
  for i = 1, #s do
    local b = s:byte(i)
    if ((i - 1) % stride) == phase then
      b = bit.bxor(b, mask)
    end
    out[i] = string.char(b)
  end
  return table.concat(out)
end

--- Apply a list of composable transforms to raw file bytes.
--- Supported: "base64", "xor:0xNN", "xor_stride:N:0xNN[:phase]", "line:N", "hex_to_bytes".
function M.apply_transforms(raw, transforms)
  if type(raw) ~= "string" then return nil end
  if type(transforms) ~= "table" or #transforms == 0 then return raw end
  local cur = raw
  for _, t in ipairs(transforms) do
    local name = tostring(t)
    if name == "base64" then
      cur = base64_decode(cur)
    elseif name == "hex_to_bytes" then
      cur = M.parse_hex_bytes(cur) or ""
    elseif name:match("^line:(%d+)$") then
      local want = tonumber(name:match("^line:(%d+)$"))
      local idx, found = 0, ""
      for line in (cur .. "\n"):gmatch("(.-)\r?\n") do
        idx = idx + 1
        if idx == want then found = line break end
      end
      cur = found
    elseif name:match("^xor:(.+)$") then
      local mask = M.parse_int(name:match("^xor:(.+)$"))
      if mask then cur = apply_xor(cur, mask % 256, 1, 0) end
    elseif name:match("^xor_stride:(%d+):([^:]+):?(%d*)$") then
      local st, m, ph = name:match("^xor_stride:(%d+):([^:]+):?(%d*)$")
      local mask = M.parse_int(m)
      if mask and tonumber(st) and tonumber(st) > 0 then
        cur = apply_xor(cur, mask % 256, tonumber(st), tonumber(ph) or 0)
      end
    end
  end
  return cur
end

--- Parse a GameMaker Studio 1.4 `ds_list_write()` hex string (or raw bytes) into a 0-based Lua array.
function M.parse_gms1_ds_list(data)
  if type(data) ~= "string" or #data < 8 then return nil end
  -- If it looks like uppercase/lowercase hex text ("2E010000..."), convert to raw bytes first.
  local raw = data
  local trimmed = data:match("^%s*(.-)%s*$")
  if #trimmed >= 16 and (#trimmed % 2) == 0 and not trimmed:find("[^%x]") then
    raw = M.parse_hex_bytes(trimmed)
  end
  if not raw or #raw < 8 then return nil end
  local magic = M.decode_value(raw, 0, "u32le")
  if magic ~= 0x012E and magic ~= 0x012D then return nil end
  local count = M.decode_value(raw, 4, "u32le")
  if not count or count > 100000 then return nil end
  local out = {}
  local pos = 8
  for i = 0, count - 1 do
    if pos + 4 > #raw then break end
    local vtype = M.decode_value(raw, pos, "u32le")
    pos = pos + 4
    if vtype == 0 then
      if pos + 8 > #raw then break end
      out[i] = M.decode_value(raw, pos, "f64le")
      pos = pos + 8
    elseif vtype == 1 then
      if pos + 4 > #raw then break end
      local slen = M.decode_value(raw, pos, "u32le")
      pos = pos + 4
      if not slen or pos + slen > #raw then break end
      out[i] = raw:sub(pos + 1, pos + slen)
      pos = pos + slen
    else
      break
    end
  end
  return out
end

-- ------------------------------------------------------------------------------------------------ file extraction

local function json_path(tbl, path)
  local cur = tbl
  local s = tostring(path or ""):gsub("^%$%.?", "")
  for seg in s:gmatch("[^%.]+") do
    if type(cur) ~= "table" then return nil end
    local name, idx = seg:match("^(.-)%[(%d+)%]$")
    if name then
      if name ~= "" then cur = cur[name] end
      if type(cur) ~= "table" then return nil end
      -- Support 0-based indexing on JSON arrays (1-based in Lua)
      cur = cur[tonumber(idx) + 1]
    else
      cur = cur[seg]
    end
  end
  return cur
end

local function parse_ini(text)
  local sections = {}
  local cur_sec = ""
  sections[cur_sec] = {}
  for line in (text .. "\n"):gmatch("(.-)\r?\n") do
    local s = line:match("^%s*(.-)%s*$")
    if s ~= "" and s:sub(1, 1) ~= ";" and s:sub(1, 1) ~= "#" then
      local sec = s:match("^%[(.+)%]$")
      if sec then
        cur_sec = sec:match("^%s*(.-)%s*$")
        sections[cur_sec] = sections[cur_sec] or {}
      else
        local k, v = s:match("^([^=]+)=(.*)$")
        if k then
          sections[cur_sec][k:match("^%s*(.-)%s*$")] = v:match("^%s*(.-)%s*$")
        end
      end
    end
  end
  return sections
end

local function coerce_scalar(v, typ)
  if v == nil then return nil end
  if typ == "number" then return tonumber(v) end
  if typ == "bool" then
    local lo = tostring(v):lower()
    if lo == "1" or lo == "true" or lo == "yes" then return true end
    if lo == "0" or lo == "false" or lo == "no" then return false end
    return nil
  end
  if typ == "string" then return tostring(v) end
  local n = tonumber(v)
  return n ~= nil and n or v
end

--- Extract all declared variables from a file's raw bytes according to `file_spec`.
function M.extract_file_vars(raw, file_spec)
  local out = {}
  if type(raw) ~= "string" or type(file_spec) ~= "table" or type(file_spec.vars) ~= "table" then return out end
  local data = M.apply_transforms(raw, file_spec.transforms)
  if not data then return out end
  local fmt = file_spec.format or "binary"

  if fmt == "binary" then
    for name, vs in pairs(file_spec.vars) do
      local vdata = vs.transforms and M.apply_transforms(data, vs.transforms) or data
      local off = M.parse_int(vs.offset) or 0
      if vs.magic then
        local pat = M.parse_hex_bytes(vs.magic)
        local hit = pat and vdata:find(pat, 1, true)
        if hit then
          off = (hit - 1) + off
        else
          off = -1
        end
      end
      if off >= 0 then
        out[name] = M.decode_value(vdata, off, vs.type or "u8", vs.size)
      end
    end
  elseif fmt == "json" then
    local ok, decoded = pcall(require("json").decode, data)
    if ok and type(decoded) == "table" then
      for name, vs in pairs(file_spec.vars) do
        local v = json_path(decoded, vs.path)
        if vs.type then v = coerce_scalar(v, vs.type) end
        out[name] = v
      end
    end
  elseif fmt == "ini" then
    local sections = parse_ini(data)
    for name, vs in pairs(file_spec.vars) do
      local sec = sections[vs.section or ""]
      local raw_v = sec and sec[vs.key]
      if raw_v ~= nil then
        out[name] = coerce_scalar(raw_v, vs.type)
      end
    end
  elseif fmt == "text" then
    local lines = {}
    for line in (data .. "\n"):gmatch("(.-)\r?\n") do lines[#lines + 1] = line end
    for name, vs in pairs(file_spec.vars) do
      local target = vs.line and lines[vs.line] or data
      if target then
        local raw_v = vs.pattern and target:match(vs.pattern) or target
        if raw_v ~= nil then
          out[name] = coerce_scalar(raw_v, vs.type)
        end
      end
    end
  elseif fmt == "gms1_ds_list" then
    -- Support per-var line/transforms (e.g. AM2R has multiple ds_list lines in one save file)
    local cache = {}
    for name, vs in pairs(file_spec.vars) do
      local key = vs.transforms and table.concat(vs.transforms, "|") or ""
      local list = cache[key]
      if list == nil then
        local slice = vs.transforms and M.apply_transforms(data, vs.transforms) or data
        list = M.parse_gms1_ds_list(slice) or false
        cache[key] = list
      end
      if list and vs.index ~= nil then
        out[name] = list[tonumber(vs.index)]
      end
    end
  end

  return out
end

-- ------------------------------------------------------------------------------------------------ trigger evaluation

--- Pure evaluation of a JSON `when` rule against current and previous variable maps.
function M.eval(when, curr, prev)
  if type(when) ~= "table" then return false end

  if when.all ~= nil then
    if type(when.all) ~= "table" or #when.all == 0 then return false end
    for _, sub in ipairs(when.all) do
      if not M.eval(sub, curr, prev) then return false end
    end
    return true
  end

  if when.any ~= nil then
    if type(when.any) ~= "table" or #when.any == 0 then return false end
    for _, sub in ipairs(when.any) do
      if M.eval(sub, curr, prev) then return true end
    end
    return false
  end

  if when["not"] ~= nil then
    return not M.eval(when["not"], curr, prev)
  end

  local vname = when.var
  local op = when.op
  if type(vname) ~= "string" or type(op) ~= "string" then return false end
  local cur = curr and curr[vname]
  if cur == nil then return false end

  if op == "changed" then
    local pv = prev and prev[vname]
    return pv ~= nil and cur ~= pv
  elseif op == "increased" then
    local pv = prev and prev[vname]
    return type(pv) == "number" and type(cur) == "number" and cur > pv
  elseif op == "decreased" then
    local pv = prev and prev[vname]
    return type(pv) == "number" and type(cur) == "number" and cur < pv
  end

  local rhs
  if when.ref ~= nil then
    if when.ref == "prev" then
      rhs = prev and prev[vname]
    else
      rhs = curr and curr[when.ref]
    end
    if rhs == nil then return false end
  else
    rhs = when.value
  end

  if op == "eq" then
    return cur == rhs
  elseif op == "ne" then
    return cur ~= rhs
  elseif op == "gt" then
    return type(cur) == "number" and type(rhs) == "number" and cur > rhs
  elseif op == "gte" then
    return type(cur) == "number" and type(rhs) == "number" and cur >= rhs
  elseif op == "lt" then
    return type(cur) == "number" and type(rhs) == "number" and cur < rhs
  elseif op == "lte" then
    return type(cur) == "number" and type(rhs) == "number" and cur <= rhs
  elseif op == "bit_set" or op == "bit_clear" then
    local b = M.parse_int(rhs)
    if type(cur) ~= "number" or not b or b < 0 or b > 31 then return false end
    local set = bit.band(math.floor(cur), bit.lshift(1, b)) ~= 0
    return op == "bit_set" and set or (not set)
  elseif op == "mask_eq" then
    local mask = M.parse_int(when.mask)
    local want = M.parse_int(rhs)
    if type(cur) ~= "number" or not mask or not want then return false end
    return bit.band(math.floor(cur), mask) == want
  elseif op == "contains" then
    return type(cur) == "string" and type(rhs) == "string" and cur:find(rhs, 1, true) ~= nil
  elseif op == "in" then
    if type(rhs) ~= "table" then return false end
    for _, item in ipairs(rhs) do
      if cur == item then return true end
    end
    return false
  end

  return false
end

-- ------------------------------------------------------------------------------------------------ validation

local WATCH_FIELDS = { poll_ms = true, memory = true, file = true }
local MEM_FIELDS   = { process = true, ptr_size = true, vars = true }
local FILE_FIELDS  = { paths = true, format = true, transforms = true, vars = true }

local function check_transforms(tr, at, err)
  if tr == nil then return end
  if not is_list(tr) then err(at .. ".transforms must be a list of transform names") return end
  for i, t in ipairs(tr) do
    local s = type(t) == "string" and t or ""
    local ok = s == "base64" or s == "hex_to_bytes"
      or s:match("^line:%d+$") ~= nil
      or (s:match("^xor:(.+)$") and M.parse_int(s:match("^xor:(.+)$")) ~= nil)
      or (s:match("^xor_stride:(%d+):([^:]+):?(%d*)$") ~= nil)
    if not ok then
      err(at .. ".transforms[" .. (i - 1) .. "] is not a supported transform")
    end
  end
end

--- Validate a `watch` block; returns (errs, declared_var_names).
function M.check_watch(watch, check_path)
  local errs, vars = {}, {}
  local function err(s) errs[#errs + 1] = s end

  if type(watch) ~= "table" or (is_list(watch) and #watch > 0) then
    return { "watch must be an object with memory and/or file" }, vars
  end
  for k in pairs(watch) do
    if type(k) ~= "string" or not WATCH_FIELDS[k] then
      err("watch.`" .. tostring(k) .. "` is not a watch field (poll_ms, memory, file)")
    end
  end
  if watch.poll_ms ~= nil and (type(watch.poll_ms) ~= "number" or watch.poll_ms < 100 or watch.poll_ms > 60000) then
    err("watch.poll_ms must be a number between 100 and 60000")
  end
  if watch.memory == nil and watch.file == nil then
    err("watch must define memory and/or file")
  end

  if watch.memory ~= nil then
    local m = watch.memory
    if type(m) ~= "table" or (is_list(m) and #m > 0) then
      err("watch.memory must be an object")
    else
      for k in pairs(m) do
        if type(k) ~= "string" or not MEM_FIELDS[k] then
          err("watch.memory.`" .. tostring(k) .. "` is not a memory field (process, ptr_size, vars)")
        end
      end
      if m.process ~= nil and (type(m.process) ~= "string" or m.process:match("^%s*$")) then
        err("watch.memory.process must be a program name")
      end
      if m.ptr_size ~= nil and m.ptr_size ~= 4 and m.ptr_size ~= 8 then
        err("watch.memory.ptr_size must be 4 or 8")
      end
      if type(m.vars) ~= "table" or next(m.vars) == nil then
        err("watch.memory.vars must define at least one variable")
      else
        for vname, vs in pairs(m.vars) do
          local at = "watch.memory.vars." .. tostring(vname)
          if type(vs) ~= "table" then
            err(at .. " must be an object")
          else
            if vs.base == nil and vs.addr == nil then err(at .. " must have base or addr") end
            if vs.type == nil or not M.TYPES[vs.type] then err(at .. ": unknown type `" .. tostring(vs.type) .. "`") end
            if vs.offsets ~= nil then
              if not is_list(vs.offsets) then
                err(at .. ".offsets must be a list of hex/integer offsets")
              else
                for i, o in ipairs(vs.offsets) do
                  if M.parse_int(o) == nil then err(at .. ".offsets[" .. (i - 1) .. "] is not a valid offset") end
                end
              end
            end
            vars[vname] = "memory"
          end
        end
      end
    end
  end

  if watch.file ~= nil then
    local flist = is_list(watch.file) and watch.file or { watch.file }
    if #flist == 0 then err("watch.file must define at least one file source") end
    for fi, f in ipairs(flist) do
      local at = is_list(watch.file) and ("watch.file[" .. (fi - 1) .. "]") or "watch.file"
      if type(f) ~= "table" or (is_list(f) and #f > 0) then
        err(at .. " must be an object")
      else
        for k in pairs(f) do
          if type(k) ~= "string" or not FILE_FIELDS[k] then
            err(at .. ".`" .. tostring(k) .. "` is not a file watch field (paths, format, transforms, vars)")
          end
        end
        local paths = type(f.paths) == "string" and { f.paths } or f.paths
        if not is_list(paths) or #paths == 0 then
          err(at .. ".paths must list at least one file path")
        else
          for pi, p in ipairs(paths) do
            local why = check_path and check_path(p)
            if why then err(at .. ".paths[" .. (pi - 1) .. "] " .. why) end
          end
        end
        local fmt = f.format or "binary"
        if not M.FILE_FORMATS[fmt] then
          err(at .. ": unknown format `" .. tostring(fmt) .. "` (binary, json, ini, text, gms1_ds_list)")
        end
        check_transforms(f.transforms, at, err)
        if type(f.vars) ~= "table" or next(f.vars) == nil then
          err(at .. ".vars must define at least one variable")
        else
          for vname, vs in pairs(f.vars) do
            local vat = at .. ".vars." .. tostring(vname)
            if type(vs) ~= "table" then
              err(vat .. " must be an object")
            else
              if fmt == "binary" then
                if vs.offset == nil or M.parse_int(vs.offset) == nil then err(vat .. " needs an integer/hex offset") end
                if vs.type ~= nil and not M.TYPES[vs.type] then err(vat .. ": unknown type `" .. tostring(vs.type) .. "`") end
                if vs.magic ~= nil and not M.parse_hex_bytes(vs.magic) then err(vat .. ".magic must be hex bytes") end
              elseif fmt == "json" then
                if type(vs.path) ~= "string" or vs.path == "" then err(vat .. " needs a json path") end
              elseif fmt == "ini" then
                if type(vs.key) ~= "string" or vs.key == "" then err(vat .. " needs an ini key") end
              elseif fmt == "gms1_ds_list" then
                if tonumber(vs.index) == nil then err(vat .. " needs a numeric index") end
              end
              check_transforms(vs.transforms, vat, err)
              if vars[vname] then err(vat .. ": variable name `" .. vname .. "` is already defined") end
              vars[vname] = "file"
            end
          end
        end
      end
    end
  end

  return errs, vars
end

--- Validate a pure JSON `when` trigger tree against `vars`.
function M.check_when(when, vars, at, errs)
  errs = errs or {}
  local function err(s) errs[#errs + 1] = s end
  if type(when) ~= "table" or (is_list(when) and #when > 0) then
    err(at .. " must be a JSON object")
    return errs
  end
  if when.all ~= nil then
    if not is_list(when.all) or #when.all == 0 then
      err(at .. ".all must be a non-empty list of conditions")
    else
      for i, sub in ipairs(when.all) do M.check_when(sub, vars, at .. ".all[" .. (i - 1) .. "]", errs) end
    end
    return errs
  end
  if when.any ~= nil then
    if not is_list(when.any) or #when.any == 0 then
      err(at .. ".any must be a non-empty list of conditions")
    else
      for i, sub in ipairs(when.any) do M.check_when(sub, vars, at .. ".any[" .. (i - 1) .. "]", errs) end
    end
    return errs
  end
  if when["not"] ~= nil then
    M.check_when(when["not"], vars, at .. ".not", errs)
    return errs
  end

  if type(when.var) ~= "string" or when.var == "" then
    err(at .. " must specify var (or all/any/not)")
  elseif vars and not vars[when.var] then
    err(at .. ": unknown var `" .. when.var .. "`")
  end
  if type(when.op) ~= "string" or not M.OPS[when.op] then
    err(at .. ": unknown op `" .. tostring(when.op) .. "`")
  else
    local unary = when.op == "changed" or when.op == "increased" or when.op == "decreased"
    if not unary and when.value == nil and when.ref == nil then
      err(at .. ": op `" .. when.op .. "` needs value or ref")
    end
    if when.ref ~= nil and when.ref ~= "prev" and vars and not vars[when.ref] then
      err(at .. ": unknown ref `" .. tostring(when.ref) .. "`")
    end
    if when.op == "mask_eq" and M.parse_int(when.mask) == nil then
      err(at .. ": op `mask_eq` needs a hex/integer mask")
    end
    if when.op == "in" and not is_list(when.value) then
      err(at .. ": op `in` needs a list value")
    end
  end
  return errs
end

return M
