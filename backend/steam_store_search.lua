--- Store search: title -> native Steam appid (resolution step 3).
---
--- Adapted from research/game-data-linker `steam_search_appid` (MIT). Only an
--- exact normalised match is returned as `exact`; edition-word and near matches
--- are suggestions and are never applied automatically (ADR-0008 spirit).

local json      = require("json")
local normalize = require("steam_store_normalize")
local throttle  = require("steam_store_throttle")

local M = {}

local MAX_SUGGESTIONS = 5

local function url_encode(str)
  return (tostring(str):gsub("([^%w%-%_%.%~])", function(c) return string.format("%%%02X", c:byte()) end))
end

function M.url(title)
  return "https://store.steampowered.com/api/storesearch/?term=" .. url_encode(title) .. "&cc=us&l=english"
end

--- Classify parsed storesearch items against the query. Pure.
---@return table { exact = {appid,name}|nil, suggestions = { {steam_appid,name,reason} } }
function M.classify_items(title, items)
  local exacts, suggestions = {}, {}
  for _, it in ipairs(type(items) == "table" and items or {}) do
    if type(it) == "table" and it.id and it.name and (it.type == nil or it.type == "app") then
      local kind = normalize.classify(title, it.name)
      if kind == "exact" then
        exacts[#exacts + 1] = { appid = tonumber(it.id), name = it.name }
      elseif kind == "edition" then
        suggestions[#suggestions + 1] = { steam_appid = tonumber(it.id), name = it.name, reason = "edition" }
      elseif normalize.is_near(title, it.name) then
        suggestions[#suggestions + 1] = { steam_appid = tonumber(it.id), name = it.name, reason = "near" }
      end
    end
  end
  local out = { suggestions = {} }
  if #exacts == 1 then
    out.exact = exacts[1]
  else
    -- Zero exacts, or several with the same name: never pick one silently.
    for _, e in ipairs(exacts) do
      out.suggestions[#out.suggestions + 1] = { steam_appid = e.appid, name = e.name, reason = "near" }
    end
  end
  for _, s in ipairs(suggestions) do
    if #out.suggestions < MAX_SUGGESTIONS then out.suggestions[#out.suggestions + 1] = s end
  end
  return out
end

local MAX_CANDIDATES = 10

--- Manual link picker (Game Data editor): the store's own hits for a typed term, unclassified.
--- Read-only: nothing is mapped, suggested or cached (unlike M.search).
---@param term string
---@param http_get? fun(url: string): string|nil, string|nil   injectable for tests
---@return table  { candidates = { {steam_appid,name} } } | { error, candidates = {} }
function M.candidates(term, http_get)
  term = tostring(term or ""):match("^%s*(.-)%s*$")
  if #term < 2 then return { candidates = {} } end
  http_get = http_get or throttle.http_get
  local body, err = http_get(M.url(term))
  if not body then return { error = tostring(err or "request failed"), candidates = {} } end
  local ok, data = pcall(json.decode, body)
  if not ok or type(data) ~= "table" then return { error = "bad response", candidates = {} } end
  local out = {}
  for _, it in ipairs(type(data.items) == "table" and data.items or {}) do
    if type(it) == "table" and it.id and it.name and (it.type == nil or it.type == "app") then
      out[#out + 1] = { steam_appid = tonumber(it.id), name = it.name }
      if #out >= MAX_CANDIDATES then break end
    end
  end
  return { candidates = out }
end

--- Search the store for a shortcut title.
---@param title string
---@param http_get? fun(url: string): string|nil, string|nil   injectable for tests
---@param store? table   steam_store_store; enables the negative cache
---@return table  { exact?, suggestions } | { skipped = "negative" } | { error }
function M.search(title, http_get, store)
  local norm = normalize.normalize(title)
  if norm == "" then return { suggestions = {} } end
  if store and store.is_negative(norm) then return { skipped = "negative", suggestions = {} } end

  http_get = http_get or throttle.http_get
  local body, err = http_get(M.url(title))
  if not body then return { error = tostring(err or "request failed"), suggestions = {} } end

  local ok, data = pcall(json.decode, body)
  if not ok or type(data) ~= "table" then return { error = "bad response", suggestions = {} } end

  local out = M.classify_items(title, data.items)
  if not out.exact and #out.suggestions == 0 and store then store.set_negative(norm) end
  return out
end

return M
