-- Runs the FiveM resource devbord-errors outside FXServer, with the natives it uses replaced by stand-ins, and writes
-- every request it would send as one line of JSON. The test in test/integrations.test.js checks those lines.
--
--   lua fivem.lua <path to devbord-errors> <dsn>

local dir, dsn = arg[1], arg[2]
local convars = {
  devbord_dsn = dsn, devbord_release = 'my-server@1.4.0', sv_hostname = '^1RP ^71', sv_maxclients = '64',
  version = 'FXServer-master SERVER v1.0.0.7290 linux', sv_enforceGameBuild = '3095', gamename = 'gta5', onesync = 'on',
}
local started = { qbx_core = true, ['qb-core'] = true, shops = true }
local versions = { ['devbord-errors'] = '1.2.0', shops = '2.1.0' }
local threads, timers, listeners, handlers, requests = {}, {}, {}, {}, {}

---@param v any
---@return string
local function encode(v)
  local t = type(v)
  if t == 'string' then
    return '"' .. v:gsub('[%c"\\]', function(c) return ('\\u%04x'):format(c:byte()) end) .. '"'
  elseif t == 'number' or t == 'boolean' then
    return tostring(v)
  elseif t == 'table' then
    local parts = {}
    if #v > 0 then
      for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    for k, x in pairs(v) do parts[#parts + 1] = encode(tostring(k)) .. ':' .. encode(x) end
    table.sort(parts)
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end

json = { encode = encode }
Config = nil
source = 0
function GetCurrentResourceName() return 'devbord-errors' end
function GetInvokingResource() return 'shops' end
function GetConvar(name, default) return convars[name] or default end
function GetConvarInt(name, default) return tonumber(convars[name]) or default end
function GetResourceState(name) return started[name] and 'started' or 'missing' end
function GetResourceMetadata(name) return versions[name] end
function GetNumPlayerIndices() return 42 end
function GetNumPlayerIdentifiers() return 2 end
function GetPlayerIdentifier(_, i) return ({ [0] = 'ip:203.0.113.7', [1] = 'license:0123456789abcdef' })[i] end
function GetPlayerName() return 'Sam' end
function PerformHttpRequest(url, callback, method, body, headers)
  requests[#requests + 1] = { url = url, method = method, body = body, headers = headers }
  callback(200, '{}')
end
function RegisterConsoleListener(fn) listeners[#listeners + 1] = fn end
function RegisterNetEvent(name, fn) handlers[name] = fn end
function AddEventHandler(name, fn) handlers[name] = fn end
function SetTimeout(_, fn) timers[#timers + 1] = fn end
function CreateThread(fn) threads[#threads + 1] = coroutine.create(fn) end
function Wait() coroutine.yield() end
local exported = {}
function exports(name, fn) exported[name] = fn end
local realPrint = print
print = function() end

dofile(dir .. '/config.lua')
dofile(dir .. '/server.lua')

-- the first pass of every thread: the heartbeat sends its first check-in
for _, co in ipairs(threads) do coroutine.resume(co) end

-- an error in the server console, as FXServer prints it
for _, line in ipairs({
  "^1SCRIPT ERROR: @shops/server/buy.lua:48: attempt to index a nil value (local 'player')^7",
  '^3> buyItem^7 (^5@shops/server/buy.lua^7:48)',
  '^3> handler^7 (^5@shops/server/main.lua^7:12)',
}) do
  for _, fn in ipairs(listeners) do fn('script:shops', line) end
end
for _, fn in ipairs(timers) do fn() end

-- the same error again within the dedupe window must not be sent
for _, fn in ipairs(listeners) do fn('script:shops', "SCRIPT ERROR: @shops/server/buy.lua:48: attempt to index a nil value (local 'player')") end
for i = #timers, #timers do timers[i]() end

exported.captureMessage('Database slow: 4.2 s', 'warning')

source = 7
handlers['devbord-errors:client']({ message = '@hud/client.lua:9: attempt to call a nil value', trace = "stack traceback:\n\t@hud/client.lua:9: in function 'draw'", resource = 'hud' })

-- a client resource that loads capture.lua: an error nobody catches in one of its threads reaches the server by itself,
-- and still ends the thread with the same error as before
local clientThreads = {}
function IsDuplicityVersion() return false end
function GetCurrentResourceName() return 'hud' end
function GetGameTimer() return os.time() * 1000 end
function TriggerServerEvent(name, data) handlers[name](data) end
function CreateThread(fn) clientThreads[#clientThreads + 1] = coroutine.create(fn) end
dofile(dir .. '/capture.lua')
-- FXServer names a chunk "@@resource/file.lua", so messages and tracebacks read "@resource/file.lua:12"
load([[
local function speed(vehicle)
  return vehicle.speed * 3.6
end
CreateThread(function()
  Wait(0)
  speed(nil)
end)
]], '@@hud/client/speedo.lua')()
for round = 1, 2 do
  local ok, err = coroutine.resume(clientThreads[1])
  if round == 2 then assert(not ok and tostring(err):find('attempt to index a nil value', 1, true), 'the error must be raised again') end
end

for _, r in ipairs(requests) do realPrint(encode(r)) end
