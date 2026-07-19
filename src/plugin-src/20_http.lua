local function baseUrl()
	return string.format("http://%s:%d", state.host, state.port)
end

local function describeHttpFailure(response)
	local statusLabel = response.StatusMessage
	if not statusLabel or statusLabel == "" then
		statusLabel = "HTTP " .. tostring(response.StatusCode or "error")
	end
	local detail = nil
	if response.Body and response.Body ~= "" then
		local decodeOk, decoded = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk and type(decoded) == "table" then
			detail = decoded.error or decoded.message or decoded.code
			if decoded.code and detail and not string.find(tostring(detail), tostring(decoded.code), 1, true) then
				detail = tostring(detail) .. " (" .. tostring(decoded.code) .. ")"
			end
		else
			detail = string.sub(tostring(response.Body), 1, 240)
		end
	end
	if detail and detail ~= "" then
		return tostring(statusLabel) .. ": " .. tostring(detail)
	end
	return tostring(statusLabel)
end

local function requestWithBase(urlBase, method, route, body)
	local options = {
		Url = urlBase .. route,
		Method = method,
		Headers = {
			["Content-Type"] = "application/json"
		}
	}
	if state.sessionToken then
		options.Headers["X-Amarillo-Session-Token"] = state.sessionToken
	end

	if body ~= nil then
		options.Body = HttpService:JSONEncode(body)
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)

	if not ok then
		return false, tostring(response)
	end
	if not response.Success then
		return false, describeHttpFailure(response)
	end

	local parsed = nil
	if response.Body and response.Body ~= "" then
		local decodeOk, decoded = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk then
			parsed = decoded
		end
	end

	return true, parsed or {}
end

local function request(method, route, body)
	return requestWithBase(baseUrl(), method, route, body)
end

local function cloneErrorContext(context)
	local result = {}
	if type(context) == "table" then
		for key, value in pairs(context) do
			result[key] = value
		end
	end
	result.pluginVersion = PLUGIN_VERSION
	result.pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION
	result.studioInstanceId = state.studioInstanceId
	result.placeId = game.PlaceId
	result.placeName = game.Name
	return result
end

local function generateErrorEventId()
	local ok, eventId = pcall(function()
		return HttpService:GenerateGUID(false)
	end)
	if ok and eventId then
		return eventId
	end
	return string.format("%s-%s", tostring(os.time()), tostring(now()))
end

local function captureErrorStack(message)
	local stack = nil
	pcall(function()
		if debug and debug.traceback then
			stack = debug.traceback(tostring(message), 3)
		end
	end)
	return stack
end

local function enqueuePluginError(payload)
	state.pendingErrorReports = state.pendingErrorReports or {}
	table.insert(state.pendingErrorReports, payload)
	while #state.pendingErrorReports > ERROR_REPORT_QUEUE_LIMIT do
		table.remove(state.pendingErrorReports, 1)
	end
end

local function sendPluginError(payload)
	local callOk, requestOk, response = pcall(function()
		return request("POST", "/errors/add", payload)
	end)
	return callOk and requestOk == true and type(response) == "table" and response.ok == true
end

local function flushPluginErrorReports(force)
	if not state.pendingErrorReports or #state.pendingErrorReports == 0 then
		return
	end
	if not state.sessionId or not state.sessionToken then
		return
	end
	local currentTime = now()
	if not force and currentTime - (state.lastErrorReportFlushAt or 0) < ERROR_REPORT_RETRY_SECONDS then
		return
	end
	state.lastErrorReportFlushAt = currentTime
	local pending = state.pendingErrorReports
	state.pendingErrorReports = {}
	for _, payload in ipairs(pending) do
		if not sendPluginError(payload) then
			enqueuePluginError(payload)
		end
	end
end

local function reportPluginError(message, code, context, severity)
	if not message or message == "" then
		return
	end
	local normalizedMessage = tostring(message)
	local payload = {
		component = "plugin",
		severity = severity or "error",
		code = code or "PLUGIN",
		eventId = generateErrorEventId(),
		message = normalizedMessage,
		sessionId = state.sessionId,
		projectId = state.selectedProjectId,
		context = cloneErrorContext(context),
		stack = captureErrorStack(normalizedMessage)
	}
	if not sendPluginError(payload) then
		enqueuePluginError(payload)
	end
end

-- OPT-005: Send pre-serialized JSON body to avoid double JSONEncode
local function requestRawBody(method, route, rawJsonBody)
	local options = {
		Url = baseUrl() .. route,
		Method = method,
		Headers = {
			["Content-Type"] = "application/json"
		},
		Body = rawJsonBody
	}
	if state.sessionToken then
		options.Headers["X-Amarillo-Session-Token"] = state.sessionToken
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)

	if not ok then
		return false, tostring(response)
	end
	if not response.Success then
		return false, describeHttpFailure(response)
	end

	local parsed = nil
	if response.Body and response.Body ~= "" then
		local decodeOk, decoded = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk then
			parsed = decoded
		end
	end
	return true, parsed or {}
end

local function fetchProjectsCatalog()
	local ok, response = request("GET", "/projects")
	if not ok then
		return false, response
	end
	state.availableProjects = response.projects or {}
	return true, response
end

local function fetchDaemonHealth()
	local ok, response = request("GET", "/health")
	if not ok then
		state.workspaceRoot = nil
		state.workspaceName = nil
		state.connectionOffer = nil
		return false, response
	end

	state.workspaceRoot = response.workspaceRoot
	state.workspaceName = workspaceNameFromRoot(response.workspaceRoot)
	state.connectionOffer = response.connectionOffer or nil
	return true, response
end

local function handshakeStatusText(offer)
	if not offer or not offer.status then
		return "no offer"
	end
	if offer.status == "pending" then
		return "waiting for confirmation"
	end
	if offer.status == "declined" then
		return "declined"
	end
	if offer.status == "accepted" then
		return "accepted"
	end
	if offer.status == "ready" then
		return "connected"
	end
	return tostring(offer.status)
end

local function isNoProjectWorkspaceError(message)
	return type(message) == "string" and string.find(message, "No compatible Argon project was found in the workspace.", 1, true) ~= nil
end
