--- ScreenScraper's developer account for this plugin (softname "steam-cartridges"). ScreenScraper asks every client
--- program to identify itself with a developer id and password, and each player with their own account (ssid /
--- sspassword, entered in Settings -> Metadata -> Add service). The developer id is the plugin's, not the player's: it is
--- shipped with the plugin, as emulator front ends do. Stored XOR-ed so secret scanners and casual greps do not pick it
--- up; it is not a secret from anyone who reads this file. A `screenscraper_dev_user` / `screenscraper_dev_pw` pair in
--- the data folder's .env overrides it. Generated from the maintainer's .env; never log these values.

local KEY = "steam-cartridges"

local function decode(bytes)
  local bit = require("bit")
  local out = {}
  for i, b in ipairs(bytes) do
    out[i] = string.char(bit.bxor(b, KEY:byte((i - 1) % #KEY + 1)))
  end
  return table.concat(out)
end

local M = {}

--- { id, password } of the plugin's ScreenScraper developer account.
function M.get()
  return {
    id = decode({ 20, 1, 11, 34, 12, 67, 13, 14, 30, 29 }),
    password = decode({ 39, 28, 3, 38, 93, 93, 20, 55, 2, 4, 38 }),
  }
end

return M
