--- steam-cartridges - the achievements source for native ports (native_ports.lua, ADR-0072).
---
--- Reads and decides; never writes the store. `fetch` gets what the store holds for the shortcut and answers what to
--- keep, and ach_service persists it: a schema built (again) with every unlock, or only the unlocks the store lacks.
--- The schema is built once, with the dump's icons when its trophy pack is found (about 3 s for 40 icons), and again
--- once the dump appears or when it was stored with another native_ports.SCHEMA_VERSION; stored unlocks are always kept.

local ports = require("native_ports")

local M = {}

M.SOURCE = "native_port"

--- Injectable for tests. nil = the real dependency.
M.deps = {
  icons = nil, -- fun(trp_path, ids) -> { [id] = data URL } | nil ; nil = trophy_pack_icons.from_trp
}

--- The port a shortcut entry launches, or nil.
function M.port(entry)
  if type(entry) ~= "table" then return nil end
  return ports.find(entry.exe, entry.launch_options)
end

function M.supports(entry) return M.port(entry) ~= nil end

local function copy(t)
  local out = {}
  for k, v in pairs(t or {}) do out[k] = v end
  return out
end

--- What to keep for a shortcut: nil and why when it launches no port, else
--- { schema, unlocks, key, rebuilt = bool, added = { [id] = { unlocked_time } } }.
--- `stored` is the store's state for the shortcut (achievements_store.get_state) or nil.
function M.fetch(entry, stored)
  local port = M.port(entry)
  if not port then return nil, "not a native port shortcut" end
  local logged = ports.read_unlocks(port)
  local schema = stored and stored.schema
  local built = type(schema) == "table" and schema.native_port == port.def.id and schema.schema_version == ports.SCHEMA_VERSION

  -- A kept schema (icons in, or still no dump): only the unlocks the store lacks are added.
  local trp = nil
  if not (built and (schema.icons or 0) > 0) then trp = port.def.trophy_pack and port.def.trophy_pack(port) end
  if built and not trp then
    local unlocks, added = copy(stored.unlocks), {}
    for id, info in pairs(logged) do
      if not unlocks[id] then unlocks[id], added[id] = info, info end
    end
    return { schema = schema, unlocks = unlocks, key = ports.schema_key(port), rebuilt = false, added = added }
  end

  local icons = nil
  if trp then
    local ok, res = pcall(M.deps.icons or function(p, ids) return require("trophy_pack_icons").from_trp(p, ids) end,
      trp, ports.trophy_ids(port))
    if ok and type(res) == "table" then
      icons = res
    else
      require("logger"):warn(port.def.name .. ": trophy icons not read: " .. tostring(res))
    end
  end
  local unlocks = copy(stored and stored.unlocks)
  for id, info in pairs(logged) do
    if not unlocks[id] then unlocks[id] = info end
  end
  return { schema = ports.schema(port, icons, entry.name), unlocks = unlocks, key = ports.schema_key(port),
    rebuilt = true, added = {} }
end

return M
