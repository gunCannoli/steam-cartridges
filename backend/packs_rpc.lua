--- steam-cartridges - achievement packs for the Game Data editor's achievements block (ADR-0081, ADR-0083).
---
---   AchievementPacksList     {}         -> { folder, bundled_folder, packs = [ pack ], problems = [ { name, errors } ] }
---   AchievementPacksExplain  { appid }  -> { pack = id | nil, assigned, others = [ { id, why } ], marked_none,
---                                            files = [ { path, state = "found"|"missing"|"unreadable", unlocks } ] }
--- pack = { id, file, count, bundled?, replaces_bundled?, games = [appid], not_chosen = [ { appid, chosen } ] }:
--- `bundled` ships with the plugin; `replaces_bundled` is the user's pack with a shipped pack's id. List reads both
--- folders again, so a pack file added while Steam runs shows in the editor's list. A pack is given to a game with
--- SetAchievementSource { source = "pack" } (record_rpc).

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
  packs.reload()
  local all, problems = packs.all()
  local by_pack = usage()
  local out = list({})
  for _, def in ipairs(all) do
    local u = by_pack[def.pack.id] or { games = list({}), not_chosen = list({}) }
    out[#out + 1] = { id = def.pack.id, file = def.pack.file, count = def.pack.count, games = u.games, not_chosen = u.not_chosen,
      bundled = def.pack.bundled or nil, replaces_bundled = def.pack.replaces_bundled or nil }
  end
  local probs = list({})
  for _, p in ipairs(problems) do probs[#probs + 1] = { name = p.name, file = p.file, errors = list(p.errors), bundled = p.bundled } end
  return { folder = packs.dir(), bundled_folder = packs.bundled_dir(), packs = out, problems = probs }
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
  local out = { pack = nil, assigned = false, others = list({}), files = list({}), marked_none = marked_none(appid) }
  if type(entry) ~= "table" or not entry.exe then return out end
  local builtin = src.builtin(entry)
  local matching = packs.matching(entry.exe)
  local given = packs.assigned_def(entry)
  local chosen
  if given then
    chosen, out.assigned = given, true
  else
    if #matching == 0 then return out end
    chosen = packs.best(entry.exe, builtin and builtin.def)
  end
  out.pack = chosen and chosen.pack.id or nil
  for _, def in ipairs(matching) do
    if def ~= chosen then
      local why
      if given then
        why = "you chose " .. given.pack.id .. " for this game"
      elseif not chosen and builtin and def.pack.bundled and def.pack.count == #(builtin.def.game and builtin.def.game.trophies or {})
          and def.pack.details == packs.details(builtin.def) then
        why = "an included pack, only as complete as the built-in " .. tostring(builtin.def.name) .. " port, which stays"
      elseif not chosen and builtin then
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
M.AchievementPacksExplain = method("AchievementPacksExplain", M.explain)

return M
