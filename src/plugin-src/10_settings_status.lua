local function now()
	return os.clock()
end

local function currentIsoTime()
	local ok, value = pcall(function()
		return DateTime.now():ToIsoDate()
	end)
	if ok and value then
		return value
	end
	return tostring(os.time())
end

local function addDestructiveConfirmationPayload(body)
	body = body or {}
	if state.pendingDestructiveCommand then
		body.destructiveConfirmationPending = true
		body.destructiveConfirmationType = state.pendingDestructiveCommand.type
		body.destructiveConfirmationSinceAt = state.pendingDestructiveSinceAt
	else
		body.destructiveConfirmationPending = false
		body.destructiveConfirmationType = nil
		body.destructiveConfirmationSinceAt = nil
	end
	return body
end

local function addVersionPayload(body)
	body = body or {}
	body.pluginVersion = PLUGIN_VERSION
	body.pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION
	body.privilegedActionConfirmationEnabled = state.confirmPrivilegedActions == true
	addDestructiveConfirmationPayload(body)
	return body
end

local function pluginVersionQuery()
	local query = "pluginVersion=" .. HttpService:UrlEncode(PLUGIN_VERSION)
		.. "&pluginProtocolVersion=" .. tostring(AMARILLO_PROTOCOL_VERSION)
		.. "&privilegedActionConfirmationEnabled=" .. tostring(state.confirmPrivilegedActions == true)
	if state.pendingDestructiveCommand then
		query = query
			.. "&destructiveConfirmationPending=true"
			.. "&destructiveConfirmationType=" .. HttpService:UrlEncode(tostring(state.pendingDestructiveCommand.type or ""))
			.. "&destructiveConfirmationSinceAt=" .. HttpService:UrlEncode(tostring(state.pendingDestructiveSinceAt or ""))
	else
		query = query .. "&destructiveConfirmationPending=false"
	end
	return query
end

local function setTextIfPresent(element, text)
	if element then
		element.Text = text
	end
end

local function normalizePort(value)
	local parsed = tonumber(value)
	if not parsed then
		return nil
	end
	parsed = math.floor(parsed)
	if parsed < 1 or parsed > 65535 then
		return nil
	end
	return parsed
end

local function shouldMirrorLogToOutput(message)
	local lower = string.lower(tostring(message or ""))
	local markers = {
		"failed",
		"falhou",
		"error",
		"erro",
		"blocked",
		"bloqueado",
		"rejected",
		"rejeitado",
		"unavailable",
		"offline",
		"timeout",
		"connection lost",
		"still pending"
	}
	for _, marker in ipairs(markers) do
		if string.find(lower, marker, 1, true) then
			return true
		end
	end
	return false
end

local function appendLog(message)
	local stamped = string.format("[%s] %s", os.date("%H:%M:%S"), message)
	table.insert(state.logs, 1, stamped)
	while #state.logs > 18 do
		table.remove(state.logs)
	end
	if state.ui.logBox then
		state.ui.logBox.Text = table.concat(state.logs, "\n")
	end
	if shouldMirrorLogToOutput(message) then
		warn("[Amarillo] " .. tostring(message))
	end
end

local function updateStatus(text)
	setTextIfPresent(state.ui.statusLabel, "Status: " .. text)
	setTextIfPresent(state.ui.advancedStatusLabel, "Status: " .. text)
end

local function updateProject(text)
	setTextIfPresent(state.ui.projectLabel, "Workspace: " .. text)
	setTextIfPresent(state.ui.advancedProjectLabel, "Workspace: " .. text)
end

local function updateSession(text)
	setTextIfPresent(state.ui.sessionLabel, "Session: " .. text)
	setTextIfPresent(state.ui.advancedSessionLabel, "Session: " .. text)
end

local function updateQueue(text)
	setTextIfPresent(state.ui.queueLabel, "Queue: " .. text)
	setTextIfPresent(state.ui.advancedQueueLabel, "Queue: " .. text)
end

local function updateConflict(text)
	setTextIfPresent(state.ui.conflictLabel, "Conflicts: " .. text)
	setTextIfPresent(state.ui.advancedConflictLabel, "Conflicts: " .. text)
end

local function updateEndpointSummary()
	local endpointText = string.format("%s:%d", state.host, state.port)
	setTextIfPresent(state.ui.endpointLabel, endpointText)
	setTextIfPresent(state.ui.settingsEndpointLabel, "Current: " .. endpointText)
end

local function workspaceNameFromRoot(workspaceRoot)
	if type(workspaceRoot) ~= "string" or workspaceRoot == "" then
		return nil
	end

	local normalized = string.gsub(workspaceRoot, "\\", "/")
	normalized = string.gsub(normalized, "/+$", "")
	local folderName = string.match(normalized, "([^/]+)$")
	return folderName or workspaceRoot
end

local function getInstancePathSegments(instance)
	local segments = {}
	local current = instance
	while current and current ~= game do
		table.insert(segments, 1, current.Name)
		current = current.Parent
	end
	return segments
end

local function currentWorkspaceLabel()
	if state.workspaceName and state.workspaceName ~= "" then
		return state.workspaceName
	end
	if state.project and state.project.name then
		return state.project.name
	end
	return "-"
end

local function currentPlaceName()
	local fallback = tostring(game.Name or "")
	local placeId = tonumber(game.PlaceId) or 0
	if placeId > 0 then
		local ok, info = pcall(function()
			return MarketplaceService:GetProductInfo(placeId)
		end)
		if ok and type(info) == "table" and type(info.Name) == "string" and info.Name ~= "" then
			return info.Name
		end
	end
	if fallback ~= "" then
		return fallback
	end
	return "Place " .. tostring(placeId)
end

local function findProjectById(projectId)
	for _, project in ipairs(state.availableProjects or {}) do
		if project.id == projectId then
			return project
		end
	end
	return nil
end

local function projectSelectionModeLabel()
	if state.projectSelectionReason == "preferred_project" then
		return "manual"
	end
	if state.projectSelectionReason == "place_match" then
		return "auto/placeId"
	end
	if state.projectSelectionReason then
		return "auto/fallback"
	end
	return nil
end

local function updateProjectTargetSummary()
	local targetName = nil
	local modeLabel = nil
	if state.connected and state.project and state.project.name then
		targetName = state.project.name
		modeLabel = projectSelectionModeLabel()
	end
	if state.selectedProjectId then
		if not targetName then
			targetName = state.selectedProjectName
			local project = findProjectById(state.selectedProjectId)
			if not targetName then
				targetName = project and project.name or state.selectedProjectId
			end
		end
		modeLabel = modeLabel or "manual"
	end
	if not targetName then
		targetName = "Auto"
	end
	if modeLabel then
		targetName = targetName .. " [" .. modeLabel .. "]"
	end
	setTextIfPresent(state.ui.targetProjectLabel, "Target project: " .. targetName)
	setTextIfPresent(state.ui.settingsProjectLabel, "Target project: " .. targetName)
end

local function saveSettings()
	plugin:SetSetting(SETTINGS_KEY, {
		host = state.host,
		port = state.port,
		projectId = state.selectedProjectId,
		portCustomized = state.portCustomized,
		confirmPrivilegedActions = state.confirmPrivilegedActions,
		confirmDestructiveActions = state.confirmPrivilegedActions,
		confirmPropertyChanges = state.confirmPrivilegedActions
	})
end

local function loadSettings()
	local saved = plugin:GetSetting(SETTINGS_KEY)
	if type(saved) == "table" then
		local migratedLegacyPort = false
		state.host = saved.host or state.host
		state.portCustomized = saved.portCustomized == true
		local savedPort = normalizePort(saved.port)
		if savedPort then
			if savedPort == LEGACY_DEFAULT_PORT and not state.portCustomized then
				state.port = DEFAULT_PORT
				migratedLegacyPort = true
			else
				state.port = savedPort
			end
		end
		state.selectedProjectId = saved.projectId
		if saved.confirmPrivilegedActions ~= nil then
			state.confirmPrivilegedActions = saved.confirmPrivilegedActions
		elseif saved.confirmDestructiveActions ~= nil then
			state.confirmPrivilegedActions = saved.confirmDestructiveActions
		elseif saved.confirmPropertyChanges ~= nil then
			state.confirmPrivilegedActions = saved.confirmPropertyChanges
		end
		if migratedLegacyPort then
			saveSettings()
			appendLog("Old default port migrated to 8323. Adjust it in Settings if you want a different port.")
		end
	end
end
