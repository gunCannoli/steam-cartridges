--- steam-cartridges - the achievements source for native ports (native_ports.lua, ADR-0072) and achievement packs
--- (achievement_packs.lua, ADR-0081).
---
--- Reads and decides; never writes the store. `fetch` gets what the store holds for the shortcut and answers what to
--- keep, and ach_service persists it: a schema built (again) with every unlock, or only the unlocks the store lacks.
--- The schema is built once, with icons when they are found (a built-in: the dump's trophy pack, about 3 s for 40; a
--- pack: its icon sources), and again once more icons appear, when it was stored with another
--- native_ports.SCHEMA_VERSION, or when the pack changed (another pack chosen, or its file edited); stored unlocks
--- are always kept (by id, else by name when the new list numbers the game differently).
---
--- Which definition answers (ADR-0081): a built-in port the shortcut launches, unless a matching pack is at least as
--- complete (it may be an updated version: D11); with no built-in port, the most complete matching pack, but only as
--- the last source (`pack_port`, asked by ach_service after every other source).

local ports = require("native_ports")

local M = {}

M.SOURCE = "native_port"

--- Injectable for tests. nil = the real dependency.
M.deps = {
  icons = nil, -- fun(trp_path, ids) -> { [id] = data URL } | nil ; nil = trophy_pack_icons.from_trp
}

local function packs() return require("achievement_packs") end

--- The built-in port a shortcut entry launches, or nil.
function M.builtin(entry)
  if type(entry) ~= "table" then return nil end
  return ports.find(entry.exe, entry.launch_options)
end

local function pack_port_of(def, entry)
  local _, dir = ports.program(entry.exe)
  return ports.port_of(def, dir)
end

--- The port a shortcut entry launches where built-in ports stand: the built-in, or a pack that replaces it.
function M.port(entry)
  local builtin = M.builtin(entry)
  if not builtin then return nil end
  local ok, pack = pcall(function() return (packs().best(entry.exe, builtin.def)) end)
  if ok and pack then return pack_port_of(pack, entry) end
  return builtin
end

function M.supports(entry) return M.builtin(entry) ~= nil end

--- The pack a shortcut uses as the last source: only when no built-in port matches it.
function M.pack_port(entry)
  if type(entry) ~= "table" or M.builtin(entry) then return nil end
  local ok, pack = pcall(function() return (packs().best(entry.exe)) end)
  if ok and pack then return pack_port_of(pack, entry) end
  return nil
end

function M.pack_supports(entry) return M.pack_port(entry) ~= nil end

local function copy(t)
  local out = {}
  for k, v in pairs(t or {}) do out[k] = v end
  return out
end

--- Stored unlocks carried to a new list: by name first (case ignored; two packs can number one game differently, so
--- an id in both lists may name different achievements), else the same id.
local function carry(stored, old_schema, game)
  local out, known, by_name = {}, {}, {}
  for _, t in ipairs(game.trophies) do
    known[tostring(t.id)] = true
    if type(t.name) == "string" then by_name[t.name:lower()] = tostring(t.id) end
  end
  local old_names = {}
  for _, a in ipairs(type(old_schema) == "table" and old_schema.achievements or {}) do
    if type(a) == "table" and a.id ~= nil and type(a.name) == "string" then old_names[tostring(a.id)] = a.name:lower() end
  end
  for id, info in pairs(stored or {}) do
    id = tostring(id)
    local target = (old_names[id] and by_name[old_names[id]]) or (known[id] and id) or nil
    if target and (not out[target] or (info.unlocked_time or 0) < (out[target].unlocked_time or 0)) then
      out[target] = info
    end
  end
  return out
end

--- What to keep for a shortcut's port: { schema, unlocks, key, rebuilt = bool, added, source }.
local function answer(port, entry, stored)
  local def = port.def
  local logged = ports.read_unlocks(port)
  local schema = stored and stored.schema
  local same = type(schema) == "table" and schema.native_port == def.id
  local built = same and schema.schema_version == ports.SCHEMA_VERSION
    and schema.pack_rev == (def.pack and def.pack.revision or nil)
  local source = def.pack and "pack" or "native_port"

  local icons, rebuild_for_icons = nil, false
  if def.pack then
    -- A pack: rebuild when its sources hold more icons than the stored schema.
    local ok, available = pcall(packs().icon_count, def, port.root)
    available = ok and available or 0
    rebuild_for_icons = available > ((built and schema.icons) or 0)
    if not built or rebuild_for_icons then
      local oki, res = pcall(packs().icons, def, port.root)
      if oki and type(res) == "table" then
        icons = res
      else
        require("logger"):warn("Achievement pack " .. tostring(def.name) .. ": icons not read: " .. tostring(res))
      end
    end
  elseif not (built and (schema.icons or 0) > 0) and def.trophy_pack then
    -- A built-in: the dump's trophy pack, once it is found.
    local trp = def.trophy_pack(port)
    if trp then
      rebuild_for_icons = true
      local ok, res = pcall(M.deps.icons or function(p, ids) return require("trophy_pack_icons").from_trp(p, ids) end,
        trp, ports.trophy_ids(port))
      if ok and type(res) == "table" then
        icons = res
      else
        require("logger"):warn(def.name .. ": trophy icons not read: " .. tostring(res))
      end
    end
  end

  if built and not rebuild_for_icons then
    -- A kept schema: only the unlocks the store lacks are added.
    local unlocks, added = copy(stored.unlocks), {}
    for id, info in pairs(logged) do
      if not unlocks[id] then unlocks[id], added[id] = info, info end
    end
    return { schema = schema, unlocks = unlocks, key = ports.schema_key(port), rebuilt = false, added = added, source = source }
  end

  local unlocks = same and copy(stored and stored.unlocks) or carry(stored and stored.unlocks, schema, def.game)
  for id, info in pairs(logged) do
    if not unlocks[id] then unlocks[id] = info end
  end
  return { schema = ports.schema(port, icons, entry.name), unlocks = unlocks, key = ports.schema_key(port),
    rebuilt = true, added = {}, source = source }
end

--- What to keep for a shortcut where built-in ports stand: nil and why when it launches none, else
--- { schema, unlocks, key, rebuilt = bool, added = { [id] = { unlocked_time } }, source = "native_port" | "pack" }.
--- `stored` is the store's state for the shortcut (achievements_store.get_state) or nil.
function M.fetch(entry, stored)
  local port = M.port(entry)
  if not port then return nil, "not a native port shortcut" end
  return answer(port, entry, stored)
end

--- The same, for a shortcut only a pack answers (the last source).
function M.fetch_pack(entry, stored)
  local port = M.pack_port(entry)
  if not port then return nil, "no achievement pack for this shortcut" end
  return answer(port, entry, stored)
end

return M
