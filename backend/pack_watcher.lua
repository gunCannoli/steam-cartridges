--- steam-cartridges - Per-game Achievement Pack watcher (file + read-only memory).
---
--- Spins up on `shortcut.launched` (via CheckUnlocks) when the game's active pack declares a `watch` block,
--- evaluates pure-JSON `when` triggers against watched file and/or process-memory variables, logs live
--- variable changes when `debug: true`, and tears down completely (closing any OS process handle) on `shortcut.quit`.

local logger = require("logger")
local eval   = require("pack_watch_eval")
local pmem   = require("proc_mem")

local M = {}

--- Injectable for hermetic tests. nil = real dependency.
M.deps = {
  read_file = nil, -- fun(path) -> string | nil
  file_stat = nil, -- fun(path) -> { size = n, mtime = n } | nil
  expand    = nil, -- fun(template, exe_dir) -> { paths }
  now       = nil, -- fun() -> unix seconds
  log       = nil, -- fun(msg) -> nil
}

local sessions = {} -- [appid] = { pack_id, debug, mem, prev, last, file_sig, seeded, mem_warned }

local function now_sec() return (M.deps.now or os.time)() end

local function log_info(msg)
  if M.deps.log then M.deps.log(msg) else logger:info(msg) end
end

local function read_file(path)
  if M.deps.read_file then return M.deps.read_file(path) end
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  return data
end

local function file_stat(path)
  if M.deps.file_stat then return M.deps.file_stat(path) end
  local ok_fs, fs = pcall(require, "fs")
  if ok_fs and fs and fs.stat then
    local ok, st = pcall(fs.stat, path)
    if ok and type(st) == "table" then
      return { size = tonumber(st.size) or 0, mtime = tonumber(st.mtime or st.modified) or 0 }
    end
  end
  -- Fallback: check existence + byte size via io.open
  local f = io.open(path, "rb")
  if not f then return nil end
  local sz = f:seek("end") or 0
  f:close()
  return { size = sz, mtime = 0 }
end

local function expand_path(tmpl, root)
  if M.deps.expand then return M.deps.expand(tmpl, root) end
  return require("achievement_packs").expand(tmpl, root)
end

local function is_list(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end

local function fmt_val(v)
  if type(v) == "number" then
    if v == math.floor(v) then return string.format("%d", v) end
    return string.format("%.3f", v)
  end
  return tostring(v)
end

--- Read all `watch.file` sources whose underlying file changed since the last tick.
local function poll_files(sess, watch, root, curr)
  if not watch.file then return end
  local flist = is_list(watch.file) and watch.file or { watch.file }
  for fi, fspec in ipairs(flist) do
    local paths = type(fspec.paths) == "string" and { fspec.paths } or (fspec.paths or {})
    local best_path, best_stat = nil, nil
    for _, tmpl in ipairs(paths) do
      for _, p in ipairs(expand_path(tmpl, root) or {}) do
        local st = file_stat(p)
        if st then
          if not best_stat or (st.mtime > best_stat.mtime) or (st.mtime == best_stat.mtime and st.size > best_stat.size) then
            best_path, best_stat = p, st
          end
        end
      end
    end
    if best_path and best_stat then
      local sig_key = tostring(fi) .. ":" .. best_path
      local sig = tostring(best_stat.size) .. ":" .. tostring(best_stat.mtime)
      -- When mtime is 0 (fallback stat), always re-read so in-place overwrites of the same size are seen.
      if best_stat.mtime == 0 or sess.file_sig[sig_key] ~= sig then
        sess.file_sig[sig_key] = sig
        local raw = read_file(best_path)
        if raw then
          local vals = eval.extract_file_vars(raw, fspec)
          for k, v in pairs(vals) do curr[k] = v end
        end
      end
    end
  end
end

--- Read all `watch.memory` variables from the running game process (read-only).
local function poll_memory(sess, watch, def, curr)
  local mspec = watch.memory
  if not mspec or type(mspec.vars) ~= "table" then return end

  if sess.mem and not pmem.alive(sess.mem) then
    if sess.debug then log_info("[watch:" .. sess.pack_id .. "] process exited, detaching memory") end
    pmem.close(sess.mem)
    sess.mem = nil
  end

  if not sess.mem then
    local proc = mspec.process or (def.exe and def.exe[1])
    if not proc then return end
    local pid = pmem.find_pid(proc)
    if not pid then return end
    local h, err = pmem.open(pid)
    if not h then
      if not sess.mem_warned then
        sess.mem_warned = true
        log_info("[watch:" .. sess.pack_id .. "] cannot open process " .. tostring(proc) .. " (pid " .. tostring(pid) .. "): " .. tostring(err))
      end
      return
    end
    sess.mem = h
    sess.mem_warned = false
    if sess.debug then
      log_info("[watch:" .. sess.pack_id .. "] attached read-only to " .. tostring(proc) .. " (pid=" .. tostring(pid) .. ", ptr=" .. tostring(pmem.ptr_size(h)) .. "B)")
    end
  end

  for vname, vs in pairs(mspec.vars) do
    local spec = vs
    if mspec.ptr_size and not vs.ptr_size then
      spec = { base = vs.base, addr = vs.addr, offsets = vs.offsets, ptr_size = mspec.ptr_size }
    end
    local addr, aerr = pmem.resolve_address(sess.mem, spec)
    if addr then
      local bytes = pmem.read(sess.mem, addr, eval.byte_size(vs))
      if bytes then
        curr[vname] = eval.decode_value(bytes, 0, vs.type, vs.size)
      end
    elseif sess.debug and not sess.seeded then
      log_info("[watch:" .. sess.pack_id .. "] var " .. vname .. " unresolved: " .. tostring(aerr))
    end
  end
end

--- Default poll interval (ms) for a pack's watch block.
function M.poll_ms(port)
  local w = port and port.def and port.def.watch
  if not w then return nil end
  if type(w.poll_ms) == "number" then return math.max(100, math.min(60000, math.floor(w.poll_ms))) end
  return w.memory and 500 or 2000
end

--- Poll one tick for `appid` using its active `port`.
--- Returns `unlocked_map` ({ [ach_id] = { unlocked_time } }), `poll_ms`.
--- When `final` is true (game exited), does one final file check, closes any memory handle, and drops the session.
function M.poll(appid, port, existing_unlocks, final)
  local def = port and port.def
  if not (def and def.watch) then
    if final then M.stop(appid) end
    return {}, nil
  end

  local sess = sessions[appid]
  local pack_id = (def.pack and def.pack.id) or def.id or "pack"
  if not sess or sess.pack_id ~= pack_id then
    if sess then M.stop(appid) end
    sess = {
      pack_id    = pack_id,
      debug      = def.debug == true,
      mem        = nil,
      prev       = {},
      last       = {},
      file_sig   = {},
      seeded     = false,
      mem_warned = false,
    }
    sessions[appid] = sess
    if sess.debug then
      log_info("[watch:" .. pack_id .. "] session started (file=" .. tostring(def.watch.file ~= nil) .. ", memory=" .. tostring(def.watch.memory ~= nil) .. ")")
    end
  end

  -- Start with last known values (so unchanged file vars stay available alongside live memory vars)
  local curr = {}
  for k, v in pairs(sess.last) do curr[k] = v end

  poll_files(sess, def.watch, port.root, curr)
  if not final then
    poll_memory(sess, def.watch, def, curr)
  end

  -- Debug live value logger
  if sess.debug then
    if not sess.seeded then
      local parts = {}
      for k, v in pairs(curr) do parts[#parts + 1] = k .. "=" .. fmt_val(v) end
      table.sort(parts)
      if #parts > 0 then
        log_info("[watch:" .. pack_id .. "] seed: " .. table.concat(parts, ", "))
      end
    else
      local changes = {}
      for k, v in pairs(curr) do
        local old = sess.last[k]
        if old ~= v then
          changes[#changes + 1] = k .. ": " .. fmt_val(old) .. " -> " .. fmt_val(v)
        end
      end
      table.sort(changes)
      for _, line in ipairs(changes) do
        log_info("[watch:" .. pack_id .. "] " .. line)
      end
    end
  end

  -- Evaluate rules against curr & prev (prev is nil on the seed tick so delta rules never false-fire)
  local prev_for_eval = sess.seeded and sess.prev or nil
  local unlocked = {}
  local t_now = now_sec()
  existing_unlocks = existing_unlocks or {}

  for _, rule in ipairs(def.watch_rules or {}) do
    if not existing_unlocks[rule.id] and eval.eval(rule.when, curr, prev_for_eval) then
      unlocked[rule.id] = { unlocked_time = t_now }
      if sess.debug then
        log_info("[watch:" .. pack_id .. "] unlock " .. tostring(rule.id) .. " (" .. tostring(rule.name) .. ")")
      end
    end
  end

  -- Advance prev / last snapshots
  if next(curr) ~= nil then
    sess.prev = {}
    for k, v in pairs(curr) do
      sess.prev[k] = v
      sess.last[k] = v
    end
    sess.seeded = true
  end

  -- Auto-platinum if all other non-DLC trophies are now unlocked
  if def.game and def.game.auto_platinum and next(unlocked) ~= nil then
    local plat_id, all_done = nil, true
    for _, t in ipairs(def.game.trophies or {}) do
      if t.grade == "P" then
        plat_id = t.id
      elseif not t.dlc then
        if not existing_unlocks[t.id] and not unlocked[t.id] then all_done = false end
      end
    end
    if plat_id and all_done and not existing_unlocks[plat_id] then
      unlocked[plat_id] = { unlocked_time = t_now }
    end
  end

  local ms = M.poll_ms(port)
  if final then
    M.stop(appid)
  end
  return unlocked, ms
end

--- Stop and clean up the watcher session for `appid` (closes any open OS process handle).
function M.stop(appid)
  local sess = sessions[appid]
  if not sess then return end
  if sess.mem then
    pmem.close(sess.mem)
    sess.mem = nil
  end
  sessions[appid] = nil
  if sess.debug then
    log_info("[watch:" .. sess.pack_id .. "] session stopped")
  end
end

--- Tests / diagnostics: whether a watcher session is active for `appid`.
function M.is_active(appid) return sessions[appid] ~= nil end

--- Tests: clear all sessions.
function M._reset()
  for appid in pairs(sessions) do M.stop(appid) end
end

return M
