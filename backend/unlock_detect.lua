--- steam-cartridges - reads a game's unlock file without being told its layout (achievement packs, ADR-0081).
---
--- The caller knows the achievements (each one's id and name), so any file is read by looking for them:
---   JSON  the document is walked. An achievement is unlocked when its id is in a list of unlocked ids; when its id
---         is a key, or the value of an `id`/`name`/`apiname`/`key` field, of an object whose flag (`unlocked`,
---         `achieved`, `earned`, `completed`, `done`, `unlock`) is true or whose time field is set; or when its id
---         is a key whose value is true or a positive number. A list or a bare `id: true` map counts only at the top
---         of the document or under a key that names unlocks (`unlocked`, `achievements`, `trophies`, ...), so a
---         save's other numbers never unlock anything. An explicit flag counts anywhere.
---   text  line by line: a line that is only an id (and a time), `id=value` / `id: value` with a value that is not
---         0/false/no, or a line with an unlock word (`unlock`, `earned`, `achieved`, `trophy`, `achievement`)
---         followed by an id or a name as a whole word. Any other line is ignored.
--- A 10-digit number is the unlock time (13 digits: milliseconds); none, and the unlock is stamped when first seen.
--- Pure: text in, unlocks out. No file access, no Steam.

local M = {}

local FLAG_KEYS = { "unlocked", "achieved", "earned", "completed", "done", "unlock", "isunlocked", "isachieved" }
local TIME_KEYS = { "unlock_time", "unlocked_time", "unlocktime", "unlockedat", "earned_time", "earnedtime",
  "earned_at", "achieved_time", "timestamp", "time", "date" }
local ID_KEYS = { "id", "apiname", "api_name", "name", "key" }
local LIST_WORDS = { "unlock", "achiev", "earn", "troph", "complet", "done" }
local LINE_WORDS = { "unlock", "earn", "achiev", "troph" }

--- Seconds from a number or digit string: 10 digits (or near) are seconds, 13 are milliseconds; else nil.
function M.time(v)
  local n = tonumber(v)
  if not n then return nil end
  n = math.floor(n)
  if n >= 1e12 and n < 1e14 then return math.floor(n / 1000) end
  if n >= 1e9 and n < 1e11 then return n end
  return nil
end

--- The lookup for a list of { id, name }: resolve(token) -> id or nil; names lower-cased, longest first.
function M.lookup(list)
  local ids, by_name, names = {}, {}, {}
  for _, a in ipairs(list or {}) do
    local id = tostring(a.id)
    ids[id] = id
    ids[id:lower()] = ids[id:lower()] or id
    local name = type(a.name) == "string" and a.name:lower():match("^%s*(.-)%s*$") or ""
    if #name >= 3 and not by_name[name] then
      by_name[name] = id
      names[#names + 1] = name
    end
  end
  table.sort(names, function(x, y) return #x > #y end)
  local self = { names = names, by_name = by_name }
  function self.resolve(token)
    if token == nil then return nil end
    local t = tostring(token):match("^%s*(.-)%s*$")
    return ids[t] or ids[t:lower()] or by_name[t:lower()]
  end
  return self
end

local function lower_keys(obj)
  local out = {}
  for k, v in pairs(obj) do
    if type(k) == "string" then out[k:lower()] = { key = k, value = v } end
  end
  return out
end

--- An object's own unlock state: true / false / nil (says nothing), and its time.
local function object_state(obj)
  local keys = lower_keys(obj)
  local state, when = nil, nil
  for _, k in ipairs(FLAG_KEYS) do
    local e = keys[k]
    if e then
      local v = e.value
      if type(v) == "boolean" then state = v
      elseif type(v) == "number" then state = v ~= 0
      elseif type(v) == "string" then
        local s = v:lower()
        if s == "true" or s == "1" or s == "yes" then state = true elseif s == "false" or s == "0" or s == "no" then state = false end
      end
      if state ~= nil then break end
    end
  end
  for _, k in ipairs(TIME_KEYS) do
    local e = keys[k]
    if e and M.time(e.value) then when = M.time(e.value) break end
  end
  if state == nil and when then state = true end
  return state, when
end

local function names_unlocks(key)
  if key == nil then return true end -- the top of the document
  local k = tostring(key):lower()
  for _, w in ipairs(LIST_WORDS) do
    if k:find(w, 1, true) then return true end
  end
  return false
end

local function is_array(t)
  local n = #t
  if n == 0 then return next(t) == nil end
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
  end
  return true
end

--- Keeps an emptied list a JSON list ([] rather than {}) when the file is written back (cjson's array marker).
local function keep_array(t)
  local ok, cjson = pcall(require, "cjson")
  if ok and type(cjson) == "table" and cjson.array_mt then setmetatable(t, cjson.array_mt) end
end

local function mark(out, id, when)
  local t = when or 0
  if out[id] == nil or (t > 0 and (out[id] == 0 or t < out[id])) then out[id] = t end
end

--- Walks a decoded JSON value. `edit` (for clear) records what unlocked each achievement so it can be undone.
local function walk(node, parent_key, look, out, edit)
  if type(node) ~= "table" then return end
  if is_array(node) then
    local listed = names_unlocks(parent_key)
    local i = 1
    while i <= #node do
      local v = node[i]
      local id = (listed and (type(v) == "string" or type(v) == "number")) and look.resolve(v) or nil
      if id then
        mark(out, id, nil)
        if edit then table.remove(node, i); edit.count = edit.count + 1 else i = i + 1 end
      else
        walk(v, parent_key, look, out, edit)
        i = i + 1
      end
    end
    if edit and #node == 0 then keep_array(node) end
    return
  end
  -- An object naming its own achievement ({ "id": "x", "unlocked": true }).
  for _, k in ipairs(ID_KEYS) do
    local e = lower_keys(node)[k]
    if e and (type(e.value) == "string" or type(e.value) == "number") then
      local id = look.resolve(e.value)
      if id then
        local state, when = object_state(node)
        if state == true then
          mark(out, id, when)
          if edit then
            for _, f in ipairs(FLAG_KEYS) do local fe = lower_keys(node)[f]; if fe then node[fe.key] = false end end
            for _, f in ipairs(TIME_KEYS) do local fe = lower_keys(node)[f]; if fe and M.time(fe.value) then node[fe.key] = 0 end end
            edit.count = edit.count + 1
          end
        end
        break
      end
    end
  end
  local listed = names_unlocks(parent_key)
  for k, v in pairs(node) do
    local id = look.resolve(k)
    if id then
      if type(v) == "table" then
        local state, when = object_state(v)
        if state == true then
          mark(out, id, when)
          if edit then
            for _, f in ipairs(FLAG_KEYS) do local fe = lower_keys(v)[f]; if fe then v[fe.key] = false end end
            for _, f in ipairs(TIME_KEYS) do local fe = lower_keys(v)[f]; if fe and M.time(fe.value) then v[fe.key] = 0 end end
            edit.count = edit.count + 1
          end
        elseif state == nil then
          walk(v, k, look, out, edit)
        end
      elseif listed and (v == true or (type(v) == "number" and v > 0) or (type(v) == "string" and (v:lower() == "true" or v == "1"))) then
        mark(out, id, type(v) == "number" and M.time(v) or nil)
        if edit then node[k] = (type(v) == "number" and 0) or false; edit.count = edit.count + 1 end
      end
    elseif type(v) == "table" then
      walk(v, k, look, out, edit)
    end
  end
end

--- The id a text line unlocks, and its time, or nil.
local TRUE_VALUES = { ["true"] = true, ["yes"] = true, ["1"] = true, ["on"] = true }
local function line_unlock(line, look)
  local l = line:match("^%s*(.-)%s*$")
  -- Blank lines, comments and an INI's "[Section]" header ("[12:30:01] ..." is a log line, not a header).
  if l == "" or l:match("^[#;]") or l:match("^%[[^%]]*%]$") then return nil end
  local lower = l:lower()
  -- 1. Only the id, or the id and a time ("5 1760000000": Bloodborne's trophies.log).
  local a, b = l:match("^(%S+)%s*(%S*)$")
  if a then
    local id = look.resolve(a)
    if id and (b == "" or M.time(b)) then return id, M.time(b) end
  end
  -- 2. id=value / id: value, the value a flag or a time (an INI's "hero_of_twilight=1"). Anything else is not an
  --    unlock: "12:30:45 [INFO] ..." must never read as achievement 12.
  local k, v = l:match("^([^=:]-)%s*[=:]%s*(.-)$")
  if k and #k > 0 then
    local id = look.resolve(k)
    if id then
      local s = v:lower():gsub('^"(.*)"$', "%1")
      if TRUE_VALUES[s] then return id, nil end
      if M.time(s) then return id, M.time(s) end
    end
  end
  -- 3. An unlock word, then the first id or achievement name after it, as a whole word
  --    ("Runtime: trophy 5 unlocked": SpartanPort; "Achievement earned: Hero of Twilight").
  local from = nil
  for _, w in ipairs(LINE_WORDS) do
    local p = lower:find("%f[%w]" .. w)
    if p and (not from or p < from) then from = p end
  end
  if not from then return nil end
  local after_word = lower:find("[^%w]", from) or (#lower + 1)
  local best_at, best_id = nil, nil
  for _, name in ipairs(look.names) do
    local init = after_word
    while true do
      local s, e = lower:find(name, init, true)
      if not s then break end
      if not lower:sub(s - 1, s - 1):match("[%w_]") and not lower:sub(e + 1, e + 1):match("[%w_]") then
        if not best_at or s < best_at then best_at, best_id = s, look.by_name[name] end
        break
      end
      init = s + 1
    end
  end
  for s, token in l:gmatch("()([%w_%-%.]+)") do
    if s >= after_word then
      local tok = token:gsub("[%.%-]+$", "")
      local id = look.resolve(tok)
      if id and not M.time(tok) then
        if not best_at or s < best_at then best_at, best_id = s, id end
        break
      end
    end
  end
  if not best_id then return nil end
  return best_id, M.time(l:match("%f[%d](%d%d%d%d%d%d%d%d%d%d%d?%d?%d?)%f[%D]"))
end

--- Unlocks in a file's text: { [id] = unix seconds, 0 when the file gives none }, and "json" | "lines" | nil.
function M.read(text, list)
  local out = {}
  if type(text) ~= "string" or text == "" then return out, nil end
  if text:find("%z") then return out, nil end -- a binary file
  local look = M.lookup(list)
  local trimmed = text:match("^%s*(.-)%s*$")
  if trimmed:match("^[%[{]") then
    local ok, data = pcall(require("json").decode, trimmed)
    if ok and type(data) == "table" then
      walk(data, nil, look, out, nil)
      return out, "json"
    end
  end
  for line in text:gmatch("[^\r\n]+") do
    local id, when = line_unlock(line, look)
    if id then mark(out, id, when) end
  end
  return out, "lines"
end

--- The text with every unlock it holds undone (JSON: flags false, times 0, listed ids removed; text: the unlocking
--- lines removed), and how many were undone. nil and why for a file that is neither.
function M.clear(text, list)
  if type(text) ~= "string" then return nil, "nothing to clear" end
  if text:find("%z") then return nil, "not in a format the plugin can edit" end
  local look = M.lookup(list)
  local trimmed = text:match("^%s*(.-)%s*$")
  if trimmed:match("^[%[{]") then
    local json = require("json")
    local ok, data = pcall(json.decode, trimmed)
    if ok and type(data) == "table" then
      local edit = { count = 0 }
      walk(data, nil, look, {}, edit)
      if edit.count == 0 then return text, 0 end
      local ok_e, encoded = pcall(json.encode, data)
      if not ok_e then return nil, "could not write the file back" end
      return encoded, edit.count
    end
  end
  local kept, n = {}, 0
  local eol = text:find("\r\n", 1, true) and "\r\n" or "\n"
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    local bare = line:gsub("\r$", "")
    if line_unlock(bare, look) then n = n + 1 else kept[#kept + 1] = bare end
  end
  if n == 0 then return text, 0 end
  while #kept > 0 and kept[#kept] == "" do kept[#kept] = nil end
  return table.concat(kept, eol) .. (#kept > 0 and eol or ""), n
end

return M
