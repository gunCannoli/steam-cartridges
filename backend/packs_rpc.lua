--- steam-cartridges - achievement packs for the frontend (ADR-0081): the settings block and the Cartridge card.
---
---   AchievementPacksList     {}                  -> { folder, packs = [ pack ], problems = [ { name, errors } ] }
---   AchievementPacksReload   {}                  -> the same, plus matched = [appid], marked_none = [appid]
---   AchievementPacksImport   { path, replace? }  -> as Reload, or { error, errors } / { exists = true, id }
---   AchievementPacksExplain  { appid }           -> { pack = id | nil, others = [ { id, why } ], marked_none,
---                                                     files = [ { path, state = "found"|"missing"|"unreadable", unlocks } ] }
--- pack = { id, name, file, count, games = [appid], not_chosen = [ { appid, chosen } ] }.
--- `matched` is every shortcut whose pack changed or may have (all the shortcuts a pack is chosen for): the frontend
--- refreshes their achievements at once (a forced ingest), so a new pack, an edit or new icons show without a restart.

local core     = require("rpc")
local packs    = require("achievement_packs")
local ports    = require("native_ports")
local src      = require("src_native_ports")

local method = core.method

local M = {}

--- Injectable for tests. nil = the real dependency.
M.deps = {
  entries = nil, -- fun() -> shortcuts.vdf entries ; nil = registry.entries
  store = nil,   -- achievements_store-like { get_state } ; nil = achievements_store
}

--- JSON lists stay lists when empty (K1: cjson writes an empty Lua table as {}).
local function list(t)
  local ok, cjson = pcall(require, "cjson")
  if ok and type(cjson) == "table" and cjson.array_mt then setmetatable(t, cjson.array_mt) end
  return t
end

local function entries()
  if M.deps.entries then return M.deps.entries() end
  return require("registry").entries()
end

local function store() return M.deps.store or require("achievements_store") end

local function unsigned(id)
  local n = tonumber(id) or 0
  if n < 0 then n = n + 4294967296 end
  return math.floor(n)
end

local function marked_none(appid)
  local st = store().get_state(appid)
  return st ~= nil and (st.source == "none" or st.schema_appid == "none")
end

--- Which pack each shortcut uses (a built-in port it beats included): { [pack id] = { games, not_chosen } }.
local function usage()
  local by_pack = {}
  for _, def in ipairs(packs.all()) do by_pack[def.pack.id] = { games = list({}), not_chosen = list({}) } end
  for _, e in ipairs(entries()) do
    if type(e) == "table" and e.exe then
      local ok, builtin = pcall(src.builtin, e)
      builtin = ok and builtin or nil
      local okb, chosen, others = pcall(packs.best, e.exe, builtin and builtin.def)
      if okb then
        local appid = unsigned(e.appid)
        local winner = chosen and chosen.pack.id or (builtin and builtin.def.name) or nil
        if chosen and by_pack[chosen.pack.id] then table.insert(by_pack[chosen.pack.id].games, appid) end
        for _, o in ipairs(others or {}) do
          if by_pack[o.pack.id] then table.insert(by_pack[o.pack.id].not_chosen, { appid = appid, chosen = winner }) end
        end
      end
    end
  end
  return by_pack
end

function M.list()
  local all, problems = packs.all()
  local by_pack = usage()
  local out = list({})
  for _, def in ipairs(all) do
    local u = by_pack[def.pack.id] or { games = list({}), not_chosen = list({}) }
    out[#out + 1] = { id = def.pack.id, file = def.pack.file, count = def.pack.count, games = u.games, not_chosen = u.not_chosen }
  end
  local probs = list({})
  for _, p in ipairs(problems) do probs[#probs + 1] = { name = p.name, file = p.file, errors = list(p.errors) } end
  return { folder = packs.dir(), packs = out, problems = probs }
end

function M.reload()
  packs.reload()
  local res = M.list()
  local matched, none, seen = list({}), list({}), {}
  local function add(appid)
    if seen[appid] then return end
    seen[appid] = true
    if marked_none(appid) then none[#none + 1] = appid else matched[#matched + 1] = appid end
  end
  for _, p in ipairs(res.packs) do
    for _, appid in ipairs(p.games) do add(appid) end
  end
  -- A game that a pack answered before (its stored part's source): its pack may be gone or replaced, so it is looked
  -- up again too (a built-in port or another source takes over).
  for _, e in ipairs(entries()) do
    local appid = type(e) == "table" and unsigned(e.appid) or 0
    local st = appid > 0 and store().get_state(appid) or nil
    if st and st.source == "pack" then add(appid) end
  end
  res.matched, res.marked_none = matched, none
  return res
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

--- Copies a pack the user picked (Steam's file dialog) into the packs folder as <id>.json, after checking it.
function M.import(data)
  local path = type(data.path) == "string" and data.path or ""
  if path == "" then return { error = "no file chosen" } end
  local text = read_file(path)
  if not text then return { error = "the file cannot be read" } end
  if #text > packs.MAX_BYTES then return { error = "the file is larger than 1 MB" } end
  local ok, pack = pcall(require("json").decode, text)
  if not ok or type(pack) ~= "table" then return { error = "the file is not valid JSON" } end
  local errs = packs.check(pack)
  if #errs > 0 then return { error = errs[1], errors = list(errs) } end
  local existing = packs.by_id(pack.id)
  if existing and data.replace ~= true then return { exists = true, id = pack.id } end
  local dir = packs.dir()
  pcall(function()
    local fs = require("fs")
    if not fs.is_directory(dir) then fs.create_directories(dir) end
  end)
  local target = dir .. "/" .. pack.id .. ".json"
  local okw, werr = require("utils").write_file(target, text)
  if not okw then return { error = "could not write " .. target .. ": " .. tostring(werr) } end
  -- A replaced pack stored under another file name would now be a duplicate id: remove that file.
  if existing and ports.norm(existing.pack.file):lower() ~= ports.norm(target):lower() then os.remove(existing.pack.file) end
  pcall(function() require("logger"):info("Achievement pack imported: " .. pack.id .. " (" .. #pack.achievements .. " achievements)") end)
  return M.reload()
end

--- What a shortcut's packs do: the one it uses, the others and why, and the chosen pack's files.
function M.explain(data)
  local appid = unsigned(data.appid)
  local entry = nil
  if M.deps.entries then
    for _, e in ipairs(M.deps.entries()) do if unsigned(e.appid) == appid then entry = e end end
  else
    entry = require("registry").shortcut(appid)
  end
  local out = { pack = nil, others = list({}), files = list({}), marked_none = marked_none(appid) }
  if type(entry) ~= "table" or not entry.exe then return out end
  local builtin = src.builtin(entry)
  local matching = packs.matching(entry.exe)
  if #matching == 0 then return out end
  local chosen = packs.best(entry.exe, builtin and builtin.def)
  out.pack = chosen and chosen.pack.id or nil
  for _, def in ipairs(matching) do
    if def ~= chosen then
      local why
      if not chosen and builtin then
        why = "the built-in " .. tostring(builtin.def.name) .. " port is more complete"
      else
        why = "less complete than " .. tostring(chosen and chosen.pack.id or "the chosen pack")
      end
      out.others[#out.others + 1] = { id = def.pack.id, why = why }
    end
  end
  if chosen then
    local _, dir = ports.program(entry.exe)
    local port = ports.port_of(chosen, dir)
    for _, f in ipairs(ports.unlock_files(port)) do
      local text = ports.io.read(f.path)
      local state, n = "missing", 0
      if text then
        local found, kind = require("unlock_detect").read(text, chosen.detect_list)
        if kind == nil and #text > 0 then state = "unreadable" else state = "found" end
        for _ in pairs(found) do n = n + 1 end
      end
      out.files[#out.files + 1] = { path = f.path, state = state, unlocks = n }
    end
  end
  return out
end

M.AchievementPacksList = method("AchievementPacksList", function() return M.list() end)
M.AchievementPacksReload = method("AchievementPacksReload", function() return M.reload() end)
M.AchievementPacksImport = method("AchievementPacksImport", M.import)
M.AchievementPacksExplain = method("AchievementPacksExplain", M.explain)

return M
