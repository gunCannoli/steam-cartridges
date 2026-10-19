--- Title normalisation and match classification for the Steam Store bucket.
---
--- `normalize` is mirrored by frontend/features/steam-store/resolve.ts
--- (normalizeTitle); both are tested against tests/fixtures/normalize-cases.json.
--- Edition-word rule ported from research/game-data-linker (MIT).

local M = {}

-- Ported from game-data-linker `STEAM_EDITION_WORDS`.
local EDITION_WORDS = {
  enhanced = true, edition = true, definitive = true, remastered = true,
  complete = true, goty = true, deluxe = true, ultimate = true, gold = true,
  standard = true, game = true, of = true, the = true, year = true, hd = true,
  remake = true, redux = true, anniversary = true, collection = true,
  bundle = true, premium = true, legacy = true, classic = true, ["and"] = true,
}

--- Remove balanced bracket groups, e.g. "(USA)", "[!]", "(v1.1)".
--- An unbalanced opener is kept (it becomes a space later).
local function strip_balanced(s, open, close)
  local out, i, n = {}, 1, #s
  while i <= n do
    local c = s:sub(i, i)
    if c == open then
      local depth, j, found = 0, i, false
      while j <= n do
        local d = s:sub(j, j)
        if d == open then
          depth = depth + 1
        elseif d == close then
          depth = depth - 1
          if depth == 0 then found = true break end
        end
        j = j + 1
      end
      if found then
        i = j + 1
      else
        out[#out + 1] = c
        i = i + 1
      end
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
  return table.concat(out)
end

---@param s any
---@return string
function M.normalize(s)
  s = tostring(s or ""):lower()
  s = s:gsub("\226\132\162", ""):gsub("\194\174", ""):gsub("\194\169", "") -- (tm) (r) (c)
  s = strip_balanced(s, "(", ")")
  s = strip_balanced(s, "[", "]")
  s = s:gsub("[^a-z0-9]+", " ")
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function is_edition_word(w)
  return EDITION_WORDS[w] or w:match("^%d%d%d%d$") ~= nil or (w:match("^[ivx]+$") ~= nil and #w <= 4)
end

--- "exact" | "edition" | "none"
---@param query string
---@param name string
function M.classify(query, name)
  local q, n = M.normalize(query), M.normalize(name)
  if q == "" or n == "" then return "none" end
  if q == n then return "exact" end
  if n:sub(1, #q + 1) == q .. " " then
    for w in n:sub(#q + 2):gmatch("%S+") do
      if not is_edition_word(w) then return "none" end
    end
    return "edition"
  end
  return "none"
end

--- Looser than classify: one title contains the other as whole words. Only ever
--- feeds suggestions, never an automatic mapping.
function M.is_near(query, name)
  local q, n = M.normalize(query), M.normalize(name)
  if q == "" or n == "" or q == n then return false end
  local pq, pn = " " .. q .. " ", " " .. n .. " "
  return pn:find(pq, 1, true) ~= nil or pq:find(pn, 1, true) ~= nil
end

return M
