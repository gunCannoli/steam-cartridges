--- steam-cartridges - achievement packs: a game's achievements from a short JSON file the user drops in a folder
--- (ADR-0081). Any `*.json` in <data dir>/packs with these fields is a pack:
---
---   id            the pack's name (a-z, 0-9, - and _, up to 64); names the icon folder <data dir>/packs/<id>/
---   exe           the program(s) the Steam shortcut starts ("Dusklight.exe"; "Folder/game.exe" for a common name)
---   files         where the game writes its achievements: paths with {game} (the exe's folder), %VARS%, ~, .., one *
---   achievements  { name, description, hidden?, rarity?, platinum?, id?, ra_icon? } in the game's order; without
---                 `id`, an achievement's id is its position from 0; `ra_icon` is a RetroAchievements badge name
---                 used as the icon while the player has a RetroAchievements key (ra_badges.lua, ADR-0082)
---   icons         optional: a folder of PNGs (name order) or a PS4 trophy00.trp, when the plugin cannot find them
---
--- A pack is compiled into the native ports definition shape (native_ports.lua), so the engine reads, resets and
--- builds its schema as for a built-in port. How its files are laid out is detected (unlock_detect.lua). Packs are
--- the last achievement source, except against a built-in port for the same shortcut, which a pack replaces when it
--- is at least as complete (src_native_ports, ach_service). A pack is data, never code: nothing here loads Lua.

local ports = require("native_ports")

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  dir = nil,   -- the packs folder; nil = <data dir>/packs
  icons = nil, -- trophy_pack_icons-like module: { icon_url(png, size), trp_entries(path), from_trp(path, ids) }
  ra = nil,    -- ra_badges-like module: { valid(name), available(name), fetch(names) -> { [name] = data URL } }
}

M.MAX_BYTES = 1024 * 1024
M.MAX_ACHIEVEMENTS = 1000
M.MAX_ICON_BYTES = 512 * 1024

local FIELDS = { id = true, exe = true, files = true, achievements = true, icons = true }
local ACH_FIELDS = { id = true, name = true, description = true, hidden = true, rarity = true, platinum = true, ra_icon = true }

local io_ = ports.io
local norm, parent = ports.norm, ports.parent

local function icons_mod() return M.deps.icons or require("trophy_pack_icons") end
local function ra_mod() return M.deps.ra or require("ra_badges") end

function M.dir()
  if M.deps.dir then return M.deps.dir end
  return norm(require("data_dir").file("packs"))
end

-- ------------------------------------------------------------------------------------------------ paths

--- Lexically resolves "." and ".." segments of an absolute path.
local function resolve_dots(p)
  local head, rest = p:match("^(%a:)(/.*)$")
  if not head then head, rest = "", p end
  local out = {}
  for seg in rest:gmatch("[^/]+") do
    if seg == ".." then
      if #out > 0 then out[#out] = nil end
    elseif seg ~= "." then
      out[#out + 1] = seg
    end
  end
  return head .. "/" .. table.concat(out, "/")
end

local function is_absolute(p) return p:match("^%a:/") ~= nil or p:match("^/") ~= nil end

--- A path template's problem, or nil.
function M.check_path(t)
  if type(t) ~= "string" or t:match("^%s*$") then return "is not a path" end
  for word in t:gmatch("{([^}]*)}") do
    if word ~= "game" then return "uses {" .. word .. "}, which is not a path word (only {game})" end
  end
  local _, stars = t:gsub("%*", "")
  if stars > 1 then return "has more than one *" end
  if stars == 1 and not ("/" .. norm(t) .. "/"):find("/%*/") then return "uses * inside a name; * must be a whole folder name" end
  local probe = io_.expand((t:gsub("{game}", "X:/folder")))
  if not is_absolute(probe) then return "is not a full path (start with {game}, a drive or %APPDATA%)" end
  return nil
end

--- The paths a template names for a game whose exe is in `exe_dir` (one per folder a * matches).
function M.expand(t, exe_dir)
  local p = io_.expand((tostring(t):gsub("{game}", function() return tostring(exe_dir or "") end)))
  p = resolve_dots(norm(p))
  local before, after = p:match("^(.-)/%*/(.*)$")
  if not before then
    before = p:match("^(.-)/%*$")
    if not before then return { p } end
    after = nil
  end
  local out = {}
  for _, d in ipairs(io_.list_dirs(before)) do
    out[#out + 1] = after and (norm(d) .. "/" .. after) or norm(d)
  end
  return out
end

-- ------------------------------------------------------------------------------------------------ check

local function is_list(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end

--- A pack table's problems, in plain words ({} when it is fine).
function M.check(pack)
  local errs = {}
  local function err(s) errs[#errs + 1] = s end
  if type(pack) ~= "table" or is_list(pack) and #pack > 0 then return { "the file is not a pack (an object with id, exe, files and achievements)" } end
  for k in pairs(pack) do
    if type(k) ~= "string" or not FIELDS[k] then err("`" .. tostring(k) .. "` is not a pack field (id, exe, files, achievements, icons)") end
  end
  if type(pack.id) ~= "string" or not pack.id:match("^[a-z0-9][a-z0-9_%-]*$") or #pack.id > 64 then
    err("id must be lower case letters, digits, - and _ (up to 64), like \"dusklight\"")
  end
  local function strings(field, what)
    local v = pack[field]
    if type(v) == "string" then v = { v } end
    if not is_list(v) or #v == 0 then err(field .. " must list at least one " .. what) return {} end
    for i, s in ipairs(v) do
      if type(s) ~= "string" or s:match("^%s*$") then err(field .. "[" .. (i - 1) .. "] is not text") end
    end
    return v
  end
  for i, e in ipairs(strings("exe", "program")) do
    if type(e) == "string" and e:find("[{}%%*]") then err("exe[" .. (i - 1) .. "] must be a program name, not a path with {, % or *") end
  end
  for i, f in ipairs(strings("files", "file")) do
    local why = type(f) == "string" and M.check_path(f)
    if why then err("files[" .. (i - 1) .. "] " .. why) end
  end
  if pack.icons ~= nil then
    local why = M.check_path(pack.icons)
    if why then err("icons " .. why) end
  end
  local list = pack.achievements
  if not is_list(list) or #list == 0 then
    err("achievements must list at least one achievement")
  elseif #list > M.MAX_ACHIEVEMENTS then
    err("achievements has " .. #list .. " entries; at most " .. M.MAX_ACHIEVEMENTS)
  else
    local seen, plats = {}, 0
    for i, a in ipairs(list) do
      local at = "achievements[" .. (i - 1) .. "]"
      if type(a) ~= "table" or is_list(a) and #a > 0 then
        err(at .. " is not an object with name and description")
      else
        for k in pairs(a) do
          if type(k) ~= "string" or not ACH_FIELDS[k] then err(at .. ": `" .. tostring(k) .. "` is not an achievement field (name, description, hidden, rarity, platinum, id, ra_icon)") end
        end
        if a.ra_icon ~= nil and not ra_mod().valid(a.ra_icon) then
          err(at .. ": ra_icon must be a RetroAchievements badge name (letters and digits, up to " .. require("ra_badges").MAX_NAME .. ")")
        end
        if type(a.name) ~= "string" or a.name:match("^%s*$") then err(at .. " has no name") end
        if a.description ~= nil and type(a.description) ~= "string" then err(at .. ": description must be text") end
        if a.hidden ~= nil and type(a.hidden) ~= "boolean" then err(at .. ": hidden must be true or false") end
        if a.platinum ~= nil and type(a.platinum) ~= "boolean" then err(at .. ": platinum must be true or false") end
        if a.platinum == true then plats = plats + 1 end
        if a.rarity ~= nil and (type(a.rarity) ~= "number" or a.rarity < 0 or a.rarity > 100) then err(at .. ": rarity must be a percent from 0 to 100") end
        if a.id ~= nil and type(a.id) ~= "string" and type(a.id) ~= "number" then err(at .. ": id must be text or a number") end
        local id = a.id ~= nil and tostring(a.id) or tostring(i - 1)
        if seen[id] then err(at .. ": id \"" .. id .. "\" is used twice") end
        seen[id] = true
      end
    end
    if plats > 1 then err("only one achievement can be the platinum") end
  end
  return errs
end

-- ------------------------------------------------------------------------------------------------ compile

--- djb2 of a text, 8 hex digits: a pack's revision.
function M.revision(text)
  local h = 5381
  for i = 1, #text do h = (h * 33 + text:byte(i)) % 4294967296 end
  return string.format("%08x", h)
end

--- How much a definition tells (achievements first, then details), for choosing between packs (D8, D11).
function M.details(def)
  local n = 0
  for _, t in ipairs(def.game and def.game.trophies or {}) do
    if type(t.description) == "string" and t.description ~= "" then n = n + 1 end
    if t.global_pct then n = n + 1 end
    if t.hidden then n = n + 1 end
    if t.grade == "P" then n = n + 1 end
  end
  return n
end

local function exe_entries(pack)
  local out = {}
  for _, e in ipairs(type(pack.exe) == "string" and { pack.exe } or pack.exe) do
    out[#out + 1] = norm(e):lower()
  end
  return out
end

--- A checked pack as a native ports definition. `file` and `text` are its file and contents.
function M.compile(pack, file, text)
  local trophies, detect, plat = {}, {}, false
  for i, a in ipairs(pack.achievements) do
    local id = a.id ~= nil and tostring(a.id) or tostring(i - 1)
    trophies[#trophies + 1] = {
      id = id, name = a.name, description = a.description or "", hidden = a.hidden == true,
      global_pct = a.rarity, grade = a.platinum and "P" or nil, position = i - 1,
      ra_icon = type(a.ra_icon) == "string" and a.ra_icon or nil,
    }
    detect[#detect + 1] = { id = id, name = a.name }
    if a.platinum then plat = true end
  end
  local files = type(pack.files) == "string" and { pack.files } or pack.files
  local def = {
    id = "pack_" .. pack.id,
    name = pack.id,
    exe = exe_entries(pack),
    game = { key = pack.id, points = 10, auto_platinum = plat or nil, trophies = trophies },
    unlocks = {
      detect = true,
      files = function(port)
        local out = {}
        for _, t in ipairs(files) do
          for _, p in ipairs(M.expand(t, port.root)) do out[#out + 1] = p end
        end
        return out
      end,
    },
    detect_list = detect,
    icons_line = pack.icons,
    pack = { id = pack.id, file = file, revision = M.revision(text or ""), count = #trophies },
  }
  def.pack.details = M.details(def)
  return def
end

-- ------------------------------------------------------------------------------------------------ loading

local loaded, problems, sig = nil, nil, nil

local function load()
  if loaded then return end
  loaded, problems = {}, {}
  local json = require("json")
  local files = io_.list_files(M.dir(), ".json")
  table.sort(files, function(a, b) return a:lower() < b:lower() end)
  local by_id = {}
  for _, file in ipairs(files) do
    local name = file:match("([^/]*)$")
    local text = io_.read(file)
    local errs
    if not text then
      errs = { "cannot be read" }
    elseif #text > M.MAX_BYTES then
      errs = { "is larger than 1 MB" }
    else
      local ok, pack = pcall(json.decode, text)
      if not ok or type(pack) ~= "table" then
        errs = { "is not valid JSON" }
      else
        local okc, res = pcall(M.check, pack)
        errs = okc and res or { "could not be checked: " .. tostring(res) }
        if #errs == 0 and by_id[pack.id] then
          errs = { "has the id \"" .. pack.id .. "\" of " .. by_id[pack.id] .. "; each pack needs its own id" }
        end
        if #errs == 0 then
          local okd, def = pcall(M.compile, pack, file, text)
          if okd then
            by_id[pack.id] = name
            loaded[#loaded + 1] = def
          else
            errs = { "could not be read: " .. tostring(def) }
          end
        end
      end
    end
    if errs and #errs > 0 then
      problems[#problems + 1] = { file = file, name = name, errors = errs }
      pcall(function() require("logger"):warn("Achievement pack " .. name .. " skipped: " .. errs[1]) end)
    end
  end
end

--- Every loaded pack (compiled definitions), and the files that are not packs: { file, name, errors }.
function M.all()
  load()
  return loaded, problems
end

--- Read the folder again on the next use.
function M.reload() loaded, problems, sig = nil, nil, nil end

--- A pack by its definition id ("pack_<id>") or its own id.
function M.by_id(id)
  for _, def in ipairs(M.all()) do
    if def.id == id or def.pack.id == id then return def end
  end
  return nil
end

--- The loaded packs as "id@revision", sorted (part of ach_service.signature: an added or edited pack asks again).
function M.signature()
  if sig then return sig end
  local parts = {}
  for _, def in ipairs(M.all()) do parts[#parts + 1] = def.pack.id .. "@" .. def.pack.revision end
  table.sort(parts)
  sig = table.concat(parts, ",")
  return sig
end

-- ------------------------------------------------------------------------------------------------ matching

--- The exe path of a shortcut's command line, lower case, forward slashes.
local function exe_path(cmd)
  local s = tostring(cmd or ""):gsub("^%s+", "")
  local first = s:match('^"([^"]*)"') or s:match("^(.-%.[eE][xX][eE])%s") or s:match("^(.-%.[eE][xX][eE])$") or s:match("^(%S*)")
  return norm(first):lower()
end

--- Whether a pack's `exe` matches a shortcut's exe: the path ends with an entry ("dusklight.exe" or
--- "dusklight/game.exe"); an entry without an extension matches the exe's name without one.
function M.matches(def, cmd)
  local path = exe_path(cmd)
  if path == "" then return false end
  local bare = path:gsub("%.exe$", "")
  for _, e in ipairs(def.exe or {}) do
    local target = e:find("%.%w+$") and path or bare
    if target == e or target:sub(-(#e + 1)) == "/" .. e then return true end
  end
  return false
end

local function better(a, b)
  if a.pack.count ~= b.pack.count then return a.pack.count > b.pack.count end
  if a.pack.details ~= b.pack.details then return a.pack.details > b.pack.details end
  return tostring(a.pack.file):lower() < tostring(b.pack.file):lower()
end

--- The packs matching a shortcut's exe, the most complete first.
function M.matching(cmd)
  local out = {}
  for _, def in ipairs(M.all()) do
    if M.matches(def, cmd) then out[#out + 1] = def end
  end
  table.sort(out, better)
  return out
end

--- The pack a shortcut uses, or nil, and the other matching packs. With `builtin` (a built-in port's definition for
--- the same shortcut), the pack must be at least as complete to replace it (a tie goes to the pack, D11).
function M.best(cmd, builtin)
  local list = M.matching(cmd)
  local top = list[1]
  if not top then return nil, {} end
  if builtin then
    local count = #(builtin.game and builtin.game.trophies or {})
    if top.pack.count < count or (top.pack.count == count and top.pack.details < M.details(builtin)) then
      return nil, list
    end
  end
  local others = {}
  for i = 2, #list do others[#others + 1] = list[i] end
  return top, others
end

-- ------------------------------------------------------------------------------------------------ icons

--- The trophy00.trp beside a PS4 port whose trophy icon count is `count`: in the exe's folder, a folder inside
--- it, or a folder beside it. Bloodborne's trophy_pack rule made general (ADR-0071).
function M.find_dump(exe_dir, count)
  if not exe_dir or exe_dir == "" or (count or 0) <= 0 then return nil end
  local rel = "/sce_sys/trophy/trophy00.trp"
  local dirs = { exe_dir }
  for _, d in ipairs(io_.list_dirs(exe_dir)) do dirs[#dirs + 1] = norm(d) end
  local up = parent(exe_dir)
  if up then
    for _, d in ipairs(io_.list_dirs(up)) do
      d = norm(d)
      if d:lower() ~= exe_dir:lower() then dirs[#dirs + 1] = d end
    end
  end
  for _, d in ipairs(dirs) do
    local p = d .. rel
    if io_.exists(p) then
      local entries = icons_mod().trp_entries(p)
      local n = 0
      for name in pairs(entries or {}) do
        if name:match("^TROP%d%d%d%.PNG$") then n = n + 1 end
      end
      if n == count then return p end
    end
  end
  return nil
end

--- Natural order: numbers inside names compare as numbers ("ach_2" before "ach_10").
local function natural_less(a, b)
  local function key(s)
    return (s:lower():gsub("%d+", function(d) return string.format("%012d", tonumber(d)) end))
  end
  return key(a) < key(b)
end

--- Where each achievement's icon comes from, without decoding anything: { [position] = { png = path } |
--- { trp = path } }, the first source that has it (the user's folder, the pack's `icons` line, the dump).
function M.icon_plan(def, exe_dir)
  local count = def.pack.count
  local plan = {}
  -- 1. <packs>/<id>/<n>.png
  local own = M.dir() .. "/" .. def.pack.id
  for _, p in ipairs(io_.list_files(own, ".png")) do
    local n = tonumber(p:match("([^/]*)%.[pP][nN][gG]$"))
    if n and n >= 0 and n < count and n % 1 == 0 then plan[n] = { png = p } end
  end
  -- 2. the `icons` line: a .trp, or a folder (numbered names by number, the rest in name order)
  if def.icons_line then
    for _, src in ipairs(M.expand(def.icons_line, exe_dir)) do
      if src:lower():match("%.trp$") then
        if io_.exists(src) then
          for n = 0, count - 1 do plan[n] = plan[n] or { trp = src } end
        end
      else
        local files = io_.list_files(src, ".png")
        table.sort(files, function(a, b) return natural_less(a:match("([^/]*)$"), b:match("([^/]*)$")) end)
        local numbered, rest = {}, {}
        for _, p in ipairs(files) do
          local n = tonumber(p:match("([^/]*)%.[pP][nN][gG]$"))
          if n and n % 1 == 0 then numbered[n] = p else rest[#rest + 1] = p end
        end
        local next_rest = 1
        for n = 0, count - 1 do
          if not plan[n] then
            if numbered[n] then
              plan[n] = { png = numbered[n] }
            elseif rest[next_rest] and next(numbered) == nil then
              plan[n] = { png = rest[next_rest] }
              next_rest = next_rest + 1
            end
          end
        end
      end
    end
  end
  -- 3. the player's dump, found by count
  local missing = false
  for n = 0, count - 1 do if not plan[n] then missing = true break end end
  if missing then
    local trp = M.find_dump(exe_dir, count)
    if trp then
      for n = 0, count - 1 do plan[n] = plan[n] or { trp = trp } end
    end
  end
  -- 4. a RetroAchievements badge (`ra_icon`), only with a key; counted only while it can be fetched or is cached
  local ra = ra_mod()
  for _, t in ipairs(def.game.trophies) do
    if not plan[t.position] and t.ra_icon and ra.available(t.ra_icon) then plan[t.position] = { ra = t.ra_icon } end
  end
  return plan
end

--- How many achievements have an icon source (no decoding): the rebuild check.
function M.icon_count(def, exe_dir)
  local n = 0
  for _ in pairs(M.icon_plan(def, exe_dir)) do n = n + 1 end
  return n
end

--- The icons, decoded and shrunk: { [achievement id] = data URL }.
function M.icons(def, exe_dir)
  local mod = icons_mod()
  local plan = M.icon_plan(def, exe_dir)
  local out, by_trp, badges = {}, {}, {}
  for _, t in ipairs(def.game.trophies) do
    local src = plan[t.position]
    if src and src.ra then
      badges[#badges + 1] = src.ra
    elseif src and src.png then
      local png = io_.read(src.png)
      if png and #png <= M.MAX_ICON_BYTES then
        local ok, url = pcall(mod.icon_url, png, 64)
        if ok and url then out[t.id] = url end
      end
    elseif src and src.trp then
      by_trp[src.trp] = by_trp[src.trp] or {}
      table.insert(by_trp[src.trp], t)
    end
  end
  for trp, list in pairs(by_trp) do
    local positions = {}
    for _, t in ipairs(list) do positions[#positions + 1] = t.position end
    local ok, got = pcall(mod.from_trp, trp, positions)
    if ok and type(got) == "table" then
      for _, t in ipairs(list) do out[t.id] = got[t.position] end
    end
  end
  if #badges > 0 then
    local ok, got = pcall(ra_mod().fetch, badges)
    if ok and type(got) == "table" then
      for _, t in ipairs(def.game.trophies) do
        local src = plan[t.position]
        if src and src.ra and got[src.ra] then out[t.id] = got[src.ra] end
      end
    end
  end
  return out
end

return M
