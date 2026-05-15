assert(plugin, "Amarillo must run as a Roblox Studio plugin")

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local InsertService = game:GetService("InsertService")
local okScriptEditor, ScriptEditorService = pcall(function() return game:GetService("ScriptEditorService") end)

local SETTINGS_KEY = "AmarilloSettings"
local PLUGIN_VERSION = "1.1.0"
local AMARILLO_PROTOCOL_VERSION = 1
local DEFAULT_HOST = "127.0.0.1"
local LEGACY_DEFAULT_PORT = 8123
local DEFAULT_PORT = 8323
local POLL_MIN_INTERVAL = 0.25
local POLL_MAX_INTERVAL = 1.0
local POLL_IDLE_THRESHOLD_1 = 5.0
local POLL_IDLE_THRESHOLD_2 = 30.0
local OFFER_ACTIVE_POLL_INTERVAL = 0.5
local OFFER_IDLE_POLL_INTERVAL = 1.5
local OFFER_RETRY_POLL_INTERVAL = 1.0
local SNAPSHOT_INTERVAL = 0.5
local REMOTE_PUSH_SUPPRESSION_SECONDS = 1.0
local SCRIPT_PATCH_DEBOUNCE_SECONDS = 0.35
local INITIAL_STUDIO_SYNC_RETRY_SECONDS = 2.0
local INITIAL_STUDIO_SYNC_LOG_SECONDS = 10.0

local state = {
	host = DEFAULT_HOST,
	port = DEFAULT_PORT,
	portCustomized = false,
	studioInstanceId = HttpService:GenerateGUID(false),
	sessionId = nil,
	sessionToken = nil,
	project = nil,
	connected = false,
	awaitingInitialSync = false,
	awaitingInitialStudioSync = false,
	lastInitialStudioSyncAttemptAt = 0,
	lastInitialStudioSyncErrorAt = 0,
	lastInitialStudioSyncErrorMessage = nil,
	selectedProjectId = nil,
	selectedProjectName = nil,
	projectSelectionReason = nil,
	projectSelectionMessage = nil,
	workspaceRoot = nil,
	workspaceName = nil,
	connectionOffer = nil,
	seenOfferIds = {},
	pendingConnectionContext = nil,
	settingsProjectId = nil,
	availableProjects = {},
	currentView = "home",
	lastSnapshotJson = nil,
	suppressPushUntil = 0,
	lastPollAt = 0,
	lastSnapshotAt = 0,
	lastActivityAt = 0,
	isApplyingRemote = false,
	logs = {},
	treeCache = nil,
	pendingScriptPatches = {},
	openDocumentCache = {},
	pendingDestructiveCommand = nil,
	confirmDestructiveActions = true,
	syncState = "ready",
	syncMessage = nil,
	versionState = "unknown",
	versionMessage = nil,
	lastSyncStatusMessage = nil,
	ui = {}
}

local disconnectWatcher
local startWatcher
local resetSessionState
local widget
local executeModifyProperty
local executeCreateInstance
local executeDeleteInstance
local executeInsertModel
local executeDestructiveCommand
local showDestructiveConfirmation
local hideDestructiveConfirmation
local acceptDestructiveAction
local declineDestructiveAction

local function now()
	return os.clock()
end

local function addVersionPayload(body)
	body = body or {}
	body.pluginVersion = PLUGIN_VERSION
	body.pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION
	return body
end

local function pluginVersionQuery()
	return "pluginVersion=" .. HttpService:UrlEncode(PLUGIN_VERSION)
		.. "&pluginProtocolVersion=" .. tostring(AMARILLO_PROTOCOL_VERSION)
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
		confirmDestructiveActions = state.confirmDestructiveActions,
		confirmPropertyChanges = state.confirmDestructiveActions
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
		if saved.confirmDestructiveActions ~= nil then
			state.confirmDestructiveActions = saved.confirmDestructiveActions
		elseif saved.confirmPropertyChanges ~= nil then
			state.confirmDestructiveActions = saved.confirmPropertyChanges
		end
		if migratedLegacyPort then
			saveSettings()
			appendLog("Old default port migrated to 8323. Adjust it in Settings if you want a different port.")
		end
	end
end

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

local function reportPluginError(message, code, context, severity)
	if not message or message == "" then
		return
	end
	pcall(function()
		request("POST", "/errors/add", {
			component = "plugin",
			severity = severity or "error",
			code = code or "PLUGIN",
			message = tostring(message),
			sessionId = state.sessionId,
			projectId = state.selectedProjectId,
			context = context
		})
	end)
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

local function serializeValue(value)
	local valueType = typeof(value)
	if valueType == "Color3" then
		return { value.R, value.G, value.B }
	end
	if valueType == "Vector3" then
		return { value.X, value.Y, value.Z }
	end
	if valueType == "Vector2" then
		return {
			__type = "Vector2",
			x = value.X,
			y = value.Y
		}
	end
	if valueType == "UDim2" then
		return {
			__type = "UDim2",
			xScale = value.X.Scale,
			xOffset = value.X.Offset,
			yScale = value.Y.Scale,
			yOffset = value.Y.Offset
		}
	end
	if valueType == "UDim" then
		return {
			__type = "UDim",
			scale = value.Scale,
			offset = value.Offset
		}
	end
	if valueType == "CFrame" then
		local components = { value:GetComponents() }
		return {
			__type = "CFrame",
			components = components
		}
	end
	if valueType == "EnumItem" then
		return tostring(value.Name)
	end
	if valueType == "Rect" then
		return {
			__type = "Rect",
			minX = value.Min.X,
			minY = value.Min.Y,
			maxX = value.Max.X,
			maxY = value.Max.Y
		}
	end
	if valueType == "NumberSequence" then
		local points = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(points, {
				time = keypoint.Time,
				value = keypoint.Value,
				envelope = keypoint.Envelope
			})
		end
		return {
			__type = "NumberSequence",
			keypoints = points
		}
	end
	if valueType == "ColorSequence" then
		local points = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(points, {
				time = keypoint.Time,
				value = { keypoint.Value.R, keypoint.Value.G, keypoint.Value.B }
			})
		end
		return {
			__type = "ColorSequence",
			keypoints = points
		}
	end
	if valueType == "BrickColor" then
		return tostring(value.Name)
	end
	if valueType == "boolean" or valueType == "number" or valueType == "string" then
		return value
	end
	return nil
end

local function valuesEqual(left, right)
	if left == right then
		return true
	end
	if type(left) ~= type(right) then
		return false
	end
	if type(left) ~= "table" then
		return false
	end

	local remaining = 0
	for key, value in pairs(left) do
		remaining = remaining + 1
		if not valuesEqual(value, right[key]) then
			return false
		end
	end
	for _ in pairs(right) do
		remaining = remaining - 1
	end
	return remaining == 0
end

local function convertIncomingValue(currentValue, raw)
	if raw == nil then
		return nil
	end

	if type(raw) == "table" and raw.__type == "UDim2" then
		return UDim2.new(raw.xScale or 0, raw.xOffset or 0, raw.yScale or 0, raw.yOffset or 0)
	end
	if type(raw) == "table" and raw.__type == "UDim" then
		return UDim.new(raw.scale or 0, raw.offset or 0)
	end
	if type(raw) == "table" and raw.__type == "Vector2" then
		return Vector2.new(raw.x or 0, raw.y or 0)
	end
	if type(raw) == "table" and raw.__type == "Rect" then
		return Rect.new(raw.minX or 0, raw.minY or 0, raw.maxX or 0, raw.maxY or 0)
	end
	if type(raw) == "table" and raw.__type == "CFrame" and type(raw.components) == "table" then
		return CFrame.new(table.unpack(raw.components))
	end
	if type(raw) == "table" and raw.__type == "NumberSequence" then
		local points = {}
		for _, point in ipairs(raw.keypoints or {}) do
			table.insert(points, NumberSequenceKeypoint.new(point.time or 0, point.value or 0, point.envelope or 0))
		end
		return NumberSequence.new(points)
	end
	if type(raw) == "table" and raw.__type == "ColorSequence" then
		local points = {}
		for _, point in ipairs(raw.keypoints or {}) do
			local color = point.value or { 1, 1, 1 }
			table.insert(points, ColorSequenceKeypoint.new(point.time or 0, Color3.new(color[1] or 1, color[2] or 1, color[3] or 1)))
		end
		return ColorSequence.new(points)
	end

	local currentType = typeof(currentValue)
	if type(raw) == "table" and #raw == 3 and currentType == "Color3" then
		return Color3.new(raw[1] or 0, raw[2] or 0, raw[3] or 0)
	end
	if type(raw) == "table" and #raw == 3 and currentType == "Vector3" then
		return Vector3.new(raw[1] or 0, raw[2] or 0, raw[3] or 0)
	end
	if currentType == "EnumItem" and type(raw) == "string" then
		local enumType = currentValue.EnumType
		if enumType and enumType[raw] then
			return enumType[raw]
		end
	end
	return raw
end

local function safeGetProperty(instance, propertyName)
	local ok, value = pcall(function()
		return instance[propertyName]
	end)
	if ok then
		return value
	end
	return nil
end

local propertyNameCache = {}

local function propertyNamesForInstance(instance)
	local className = instance.ClassName
	local cached = propertyNameCache[className]
	if cached then
		return cached
	end

	local propertyNames = {}

	if instance:IsA("Script") or instance:IsA("LocalScript") or instance:IsA("ModuleScript") then
		propertyNames.Enabled = true
	end
	if instance:IsA("ScreenGui") then
		propertyNames.ResetOnSpawn = true
		propertyNames.IgnoreGuiInset = true
		propertyNames.DisplayOrder = true
		propertyNames.Enabled = true
		propertyNames.ZIndexBehavior = true
	end
	if instance:IsA("GuiObject") then
		propertyNames.Position = true
		propertyNames.Size = true
		propertyNames.AnchorPoint = true
		propertyNames.BackgroundTransparency = true
		propertyNames.Visible = true
		propertyNames.ZIndex = true
	end
	if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
		propertyNames.Text = true
		propertyNames.TextSize = true
		propertyNames.TextTransparency = true
		propertyNames.TextColor3 = true
	end
	if instance:IsA("BasePart") then
		propertyNames.Anchored = true
		propertyNames.CanCollide = true
		propertyNames.CanQuery = true
		propertyNames.CanTouch = true
		propertyNames.CastShadow = true
		propertyNames.Color = true
		propertyNames.Material = true
		propertyNames.Size = true
		propertyNames.Transparency = true
		propertyNames.Massless = true
		propertyNames.Shape = true
		propertyNames.BottomSurface = true
		propertyNames.TopSurface = true
		propertyNames.CFrame = true
		propertyNames.Position = true
		propertyNames.Orientation = true
	end
	if instance:IsA("MeshPart") then
		propertyNames.MeshId = true
		propertyNames.TextureID = true
		propertyNames.RenderFidelity = true
	end

	propertyNameCache[className] = propertyNames
	return propertyNames
end

local function isReservedAttributeName(attributeName)
	return type(attributeName) == "string" and string.sub(attributeName, 1, 3) == "RBX"
end

local function syncableAttributes(attributes)
	local filtered = {}
	local hasAttributes = false
	for attributeName, attributeValue in pairs(attributes or {}) do
		if not isReservedAttributeName(attributeName) then
			filtered[attributeName] = attributeValue
			hasAttributes = true
		end
	end
	return filtered, hasAttributes
end

local function collectProperties(instance)
	local propertyNames = propertyNamesForInstance(instance)
	local properties = {}
	for propertyName in pairs(propertyNames) do
		local value = safeGetProperty(instance, propertyName)
		local serialized = serializeValue(value)
		if serialized ~= nil then
			properties[propertyName] = serialized
		end
	end

	local attributes, hasAttributes = syncableAttributes(instance:GetAttributes())
	if hasAttributes then
		properties.Attributes = attributes
	end

	return properties
end

-- OPT-003: Event-driven open document cache instead of polling GetEditorDocuments()
local function collectOpenDocumentSources()
	return state.openDocumentCache
end

-- Full refresh (used on watcher start / reconnect only)
local function refreshOpenDocumentCache()
	local sources = {}
	if okScriptEditor and ScriptEditorService then
		local okEditor, openDocs = pcall(function()
			return ScriptEditorService:GetEditorDocuments()
		end)
		if okEditor and openDocs then
			for _, doc in ipairs(openDocs) do
				local isOpen = false
				pcall(function()
					isOpen = not doc:IsClosed()
				end)
				if isOpen then
					local okScript, scriptInst = pcall(function()
						return doc:GetScript()
					end)
					if okScript and scriptInst then
						local okText, text = pcall(function()
							return doc:GetText()
						end)
						if okText then
							sources[scriptInst] = text
						end
					end
				end
			end
		end
	end
	state.openDocumentCache = sources
end

local function readScriptSource(instance, openDocumentSources)
	if openDocumentSources and openDocumentSources[instance] ~= nil then
		return openDocumentSources[instance]
	end
	local ok, source = pcall(function()
		return instance.Source
	end)
	if ok then
		return source
	end
	return nil
end

local function updateScriptSourceIfChanged(instance, desiredSource, openDocumentSources)
	local currentSource = readScriptSource(instance, openDocumentSources)
	if currentSource == desiredSource then
		return false
	end

	local sourceUpdated = false
	if okScriptEditor and ScriptEditorService then
		pcall(function()
			local result = ScriptEditorService:UpdateSourceAsync(instance, function()
				return desiredSource
			end)
			if result then
				sourceUpdated = true
			end
		end)
	end

	if not sourceUpdated then
		pcall(function()
			instance.Source = desiredSource
		end)
	end
	return true
end

local function indexDesiredChildren(children)
	local indexed = {}
	for _, child in ipairs(children or {}) do
		local bucket = indexed[child.name]
		if bucket then
			table.insert(bucket, child)
		else
			indexed[child.name] = { child }
		end
	end
	return indexed
end

local function findDesiredChildForInstance(instance, desiredChildIndex)
	local bucket = desiredChildIndex and desiredChildIndex[instance.Name]
	if not bucket then
		return nil
	end
	for _, desiredChild in ipairs(bucket) do
		if desiredChild.className == instance.ClassName then
			return desiredChild
		end
	end
	return bucket[1]
end

local function hasDesiredChildNamed(desiredChildIndex, name)
	return desiredChildIndex ~= nil and desiredChildIndex[name] ~= nil
end

-- Engine/player-owned instances cannot be safely rewritten by plugin threads.
local function isPlayerControlledInstance(instance)
	if not instance then
		return false
	end
	if instance:IsA("Player") then
		return true
	end
	local okPlayersDescendant, playersDescendant = pcall(function()
		return instance:IsDescendantOf(Players)
	end)
	if okPlayersDescendant and playersDescendant then
		return true
	end

	local okPlayers, playerList = pcall(function()
		return Players:GetPlayers()
	end)
	if not okPlayers then
		return false
	end
	for _, player in ipairs(playerList) do
		local character = nil
		pcall(function()
			character = player.Character
		end)
		if character then
			if instance == character then
				return true
			end
			local okCharacterDescendant, characterDescendant = pcall(function()
				return instance:IsDescendantOf(character)
			end)
			if okCharacterDescendant and characterDescendant then
				return true
			end
		end
	end
	return false
end

local function isProtectedSyncInstance(instance)
	return instance and (instance:IsA("Terrain") or isPlayerControlledInstance(instance))
end

local function shouldIncludeSnapshotChild(instance, desiredChildIndex)
	if isPlayerControlledInstance(instance) then
		return false
	end
	if not isProtectedSyncInstance(instance) then
		return true
	end
	return hasDesiredChildNamed(desiredChildIndex, instance.Name)
end

local function destroyUnexpectedChild(instance, contextLabel)
	if isProtectedSyncInstance(instance) then
		return false
	end

	local ok, err = pcall(function()
		instance:Destroy()
	end)
	if not ok then
		local fullName = instance.Name
		pcall(function()
			fullName = instance:GetFullName()
		end)
		appendLog("Failed to destroy during sync (" .. tostring(contextLabel) .. "): " .. tostring(fullName) .. " -> " .. tostring(err))
	end
	return ok
end

local function describeInstanceForLog(instance)
	local fullName = instance and instance.Name or "?"
	pcall(function()
		fullName = instance:GetFullName()
	end)
	return fullName
end

local function snapshotNode(instance, openDocumentSources, desiredNode)
	local node = {
		name = instance.Name,
		className = instance.ClassName,
		classNameSource = "studio",
		properties = collectProperties(instance),
		children = {}
	}

	if instance:IsA("Script") then
		node.fileKind = "server"
	elseif instance:IsA("LocalScript") then
		node.fileKind = "client"
	elseif instance:IsA("ModuleScript") then
		node.fileKind = "module"
	end

	if node.fileKind then
		node.source = readScriptSource(instance, openDocumentSources) or ""
	end

	local desiredChildIndex = indexDesiredChildren(desiredNode and desiredNode.children or nil)
	for _, child in ipairs(instance:GetChildren()) do
		if shouldIncludeSnapshotChild(child, desiredChildIndex) then
			table.insert(node.children, snapshotNode(child, openDocumentSources, findDesiredChildForInstance(child, desiredChildIndex)))
		end
	end
	table.sort(node.children, function(left, right)
		return left.name < right.name
	end)

	return node
end

local function resolveMountContainer(segments)
	local current = game
	for index, segment in ipairs(segments) do
		if index == 1 then
			local ok, service = pcall(function()
				return game:GetService(segment)
			end)
			if ok then
				current = service
			else
				current = game:FindFirstChild(segment)
			end
		else
			current = current and current:FindFirstChild(segment)
		end
		if not current then
			return nil
		end
	end
	return current
end

local function snapshotCurrentProject()
	if not state.project then
		return nil
	end
	local openDocumentSources = collectOpenDocumentSources()
	local mounts = {}
	local cachedMounts = {}
	for _, mount in ipairs(state.treeCache and state.treeCache.mounts or {}) do
		cachedMounts[mount.id] = mount
	end
	for _, mount in ipairs(state.project.mounts or {}) do
		local container = resolveMountContainer(string.split(mount.path, "."))
		if container then
			local children = {}
			local desiredMount = cachedMounts[mount.id]
			local desiredChildIndex = indexDesiredChildren(desiredMount and desiredMount.children or nil)
			for _, child in ipairs(container:GetChildren()) do
				if shouldIncludeSnapshotChild(child, desiredChildIndex) then
					table.insert(children, snapshotNode(child, openDocumentSources, findDesiredChildForInstance(child, desiredChildIndex)))
				end
			end
			table.sort(children, function(left, right)
				return left.name < right.name
			end)
			table.insert(mounts, {
				id = mount.id,
				segments = string.split(mount.path, "."),
				children = children
			})
		end
	end
	return {
		projectId = state.project.id,
		mounts = mounts
	}
end

local function setProperty(instance, propertyName, rawValue)
	if propertyName == "Attributes" and type(rawValue) == "table" then
		local currentAttributes = instance:GetAttributes()
		local desiredAttributes = syncableAttributes(rawValue)
		local currentSyncableAttributes = syncableAttributes(currentAttributes)
		if valuesEqual(currentSyncableAttributes, desiredAttributes) then
			return
		end
		for attributeName in pairs(currentAttributes) do
			if not isReservedAttributeName(attributeName) and desiredAttributes[attributeName] == nil then
				instance:SetAttribute(attributeName, nil)
			end
		end
		for attributeName, attributeValue in pairs(desiredAttributes) do
			if not valuesEqual(currentAttributes[attributeName], attributeValue) then
				instance:SetAttribute(attributeName, attributeValue)
			end
		end
		return
	end

	local currentValue = safeGetProperty(instance, propertyName)
	local currentSerialized = serializeValue(currentValue)
	if currentSerialized ~= nil and valuesEqual(currentSerialized, rawValue) then
		return
	end
	local converted = convertIncomingValue(currentValue, rawValue)
	if currentValue == converted then
		return
	end
	local ok, err = pcall(function()
		instance[propertyName] = converted
	end)
	if not ok then
		appendLog("setProperty failed (" .. tostring(propertyName) .. "): " .. tostring(err))
	end
end

local function applyProperties(instance, properties)
	for propertyName, value in pairs(properties or {}) do
		setProperty(instance, propertyName, value)
	end
end

local function isImplicitFolderNode(desiredNode)
	return desiredNode
		and desiredNode.className == "Folder"
		and desiredNode.classNameSource == "defaultFolder"
end

-- Returns true if the desired node may contain Studio-only descendants
-- that the daemon cannot fully represent on disk.
local function mayContainStudioOnlyChildren(desiredNode)
	if desiredNode.keepUnknowns == true then
		return true
	end
	-- Implicit folders never come from explicit declarations;
	-- the daemon simply didn't know the real class, so it can't
	-- know about non-script children either.
	if isImplicitFolderNode(desiredNode) then
		return true
	end
	-- Nodes whose class was preserved from Studio (corrected during
	-- a prior apply) also cannot list non-script children.
	if desiredNode.classNameSource == "studio" then
		return true
	end
	return false
end

-- Returns true if a Studio instance class cannot be represented as a file
-- on disk (i.e. the daemon would never produce a node for it).
local NON_SYNCABLE_BASE_CLASSES = {
	"GuiObject", "GuiBase2d", "UIBase", "UIComponent",
	"BasePart", "Model", "Camera", "Light",
	"Humanoid", "Attachment", "Constraint",
	"Sound", "ParticleEmitter", "Beam", "Trail",
	"ValueBase", "BodyMover", "JointInstance"
}
local function isNonSyncableInstance(instance)
	for _, baseClass in ipairs(NON_SYNCABLE_BASE_CLASSES) do
		if instance:IsA(baseClass) then
			return true
		end
	end
	return false
end

local function hasNonSyncableDescendant(instance)
	for _, descendant in ipairs(instance:GetDescendants()) do
		if isProtectedSyncInstance(descendant) or isNonSyncableInstance(descendant) then
			return true
		end
	end
	return false
end

local function shouldDestroyUnexpectedChild(child, desiredNode)
	if isProtectedSyncInstance(child) or isNonSyncableInstance(child) then
		return false
	end
	if mayContainStudioOnlyChildren(desiredNode) and hasNonSyncableDescendant(child) then
		return false
	end
	return true
end

local function findExistingChildForDesired(parent, desiredNode)
	local sameName = nil
	for _, child in ipairs(parent:GetChildren()) do
		if child.Name == desiredNode.name then
			if child.ClassName == desiredNode.className then
				return child
			end
			sameName = sameName or child
		end
	end
	return sameName
end

local function ensureInstance(parent, desiredNode)
	local existing = findExistingChildForDesired(parent, desiredNode)
	local corrected = false
	if isPlayerControlledInstance(existing) then
		appendLog("Sync ignored player-controlled instance: " .. describeInstanceForLog(existing))
		return nil, true
	end
	if existing and existing.ClassName ~= desiredNode.className then
		if isProtectedSyncInstance(existing) then
			appendLog("Sync ignorou substituicao de instancia protegida: " .. describeInstanceForLog(existing) .. " (" .. existing.ClassName .. " -> " .. tostring(desiredNode.className) .. ")")
			return nil, corrected
		end
		if isImplicitFolderNode(desiredNode) and existing.ClassName ~= "Folder" then
			appendLog("Preserved Studio class for implicit Folder: " .. describeInstanceForLog(existing) .. " (" .. existing.ClassName .. ")")
			return existing, true
		end
		-- Never destroy non-syncable Studio instances (GUIs, Parts, Models,
		-- etc.) due to class mismatch. The daemon may produce an approximate
		-- class that doesn't match the real Studio class. Preserve what
		-- Studio already has to avoid duplicating/losing instances.
		if isNonSyncableInstance(existing) then
			appendLog("Preserved non-syncable Studio instance: " .. describeInstanceForLog(existing) .. " (" .. existing.ClassName .. " vs desired " .. tostring(desiredNode.className) .. ")")
			return existing, true
		end
		if not destroyUnexpectedChild(existing, "class mismatch replacement") then
			return nil, corrected
		end
		existing = nil
	end

	if not existing then
		existing = Instance.new(desiredNode.className)
		existing.Name = desiredNode.name
		existing.Parent = parent
	end

	if existing.Name ~= desiredNode.name then
		local okRename, renameErr = pcall(function()
			existing.Name = desiredNode.name
		end)
		if not okRename then
			appendLog("Failed to rename during sync: " .. describeInstanceForLog(existing) .. " -> " .. tostring(renameErr))
			return nil, true
		end
	end
	return existing, corrected
end

local function applyNode(parent, desiredNode, openDocumentSources)
	local instance, corrected = ensureInstance(parent, desiredNode)
	if not instance then
		return corrected
	end
	applyProperties(instance, desiredNode.properties)

	if desiredNode.fileKind and desiredNode.source ~= nil then
		updateScriptSourceIfChanged(instance, desiredNode.source, openDocumentSources)
	end

	local desiredChildren = {}
	for _, child in ipairs(desiredNode.children or {}) do
		desiredChildren[child.name] = true
		if applyNode(instance, child, openDocumentSources) then
			corrected = true
		end
	end

	if desiredNode.keepUnknowns ~= true then
		for _, child in ipairs(instance:GetChildren()) do
			if not desiredChildren[child.Name] then
				-- Preserve Studio-only objects, but remove syncable scripts/folders
				-- that disappeared from the desired tree so moves do not duplicate.
				if shouldDestroyUnexpectedChild(child, desiredNode) then
					destroyUnexpectedChild(child, "node cleanup")
				end
			end
		end
	end
	return corrected
end

local function normalizeProjectSnapshotForCache(projectSnapshot)
	local mounts = {}
	for _, mount in ipairs(projectSnapshot.mounts or {}) do
		table.insert(mounts, {
			id = mount.id,
			segments = mount.segments or {},
			children = mount.children or {}
		})
	end
	return {
		projectId = projectSnapshot.projectId,
		mounts = mounts
	}
end

local function applySyncSummary(sessionSummary)
	if type(sessionSummary) ~= "table" then
		return
	end
	state.syncState = sessionSummary.syncState or "ready"
	state.syncMessage = sessionSummary.syncMessage
	state.versionState = sessionSummary.versionState or state.versionState
	state.versionMessage = sessionSummary.versionMessage or state.versionMessage
	if sessionSummary.requiresPluginUpdate == true or state.versionState == "blocked" then
		updateStatus("plugin update required")
		updateConflict("1")
		local message = state.versionMessage or sessionSummary.syncBlockedReason or "Plugin update required before sync can continue."
		if state.lastSyncStatusMessage ~= message then
			appendLog(message)
			state.lastSyncStatusMessage = message
		end
	elseif state.syncState == "degraded" or sessionSummary.requiresManualResync == true then
		updateStatus("sync paused")
		updateConflict("1")
		local message = state.syncMessage or "Sync paused. Run a manual resync."
		if state.lastSyncStatusMessage ~= message then
			appendLog(message)
			state.lastSyncStatusMessage = message
		end
	else
		updateConflict("0")
		state.lastSyncStatusMessage = nil
	end
end

local function applyProjectSnapshot(projectSnapshot)
	if not projectSnapshot then
		return false, "Snapshot vazio"
	end

	state.isApplyingRemote = true
	state.suppressPushUntil = now() + REMOTE_PUSH_SUPPRESSION_SECONDS
	local correctedDuringApply = false
	local appliedSnapshot = nil

	local okApply, applyError = xpcall(function()
		ChangeHistoryService:SetWaypoint("Amarillo Sync Start")
		local openDocumentSources = collectOpenDocumentSources()

		for _, mount in ipairs(projectSnapshot.mounts or {}) do
			local container = resolveMountContainer(mount.segments or {})
			if container then
				local desiredChildren = {}
				for _, child in ipairs(mount.children or {}) do
					desiredChildren[child.name] = true
					if applyNode(container, child, openDocumentSources) then
						correctedDuringApply = true
					end
				end
				if mount.keepUnknowns ~= true then
					for _, child in ipairs(container:GetChildren()) do
						if not desiredChildren[child.Name] then
							-- Never destroy non-syncable instances (GUIs, Parts,
							-- Cameras, etc.) during mount cleanup. The daemon
							-- cannot represent these in the filesystem.
							if not isNonSyncableInstance(child) then
								destroyUnexpectedChild(child, "mount cleanup")
							end
						end
					end
				end
			else
				appendLog("Mount not found: " .. table.concat(mount.segments or {}, "."))
			end
		end

		ChangeHistoryService:SetWaypoint("Amarillo Sync End")
		
		appliedSnapshot = snapshotCurrentProject()
		if correctedDuringApply then
			appendLog("Studio classes preserved; sending corrected snapshot to daemon.")
		end

		state.treeCache = normalizeProjectSnapshotForCache(appliedSnapshot or projectSnapshot)
		if state.treeCache then
			state.lastSnapshotJson = HttpService:JSONEncode(state.treeCache)
		end
	end, function(err)
		return tostring(err)
	end)

	state.isApplyingRemote = false
	if not okApply then
		appendLog("Apply project snapshot failed: " .. tostring(applyError))
		return false, tostring(applyError)
	end

	return true, "Snapshot aplicado", appliedSnapshot
end

local function postCommandResult(commandId, okValue, payload)
	if not state.sessionId then
		return
	end
	if okValue ~= true and payload and payload.error then
		reportPluginError(payload.error, "PLUGIN-COMMAND", {
			commandId = commandId
		}, "error")
	end
	local body = {
		sessionId = state.sessionId,
		commandId = commandId,
		ok = okValue
	}
	addVersionPayload(body)
	for key, value in pairs(payload or {}) do
		body[key] = value
	end
	local ok, response = request("POST", "/studio/complete", body)
	if not ok then
		appendLog("Failed to confirm command with daemon: " .. tostring(response))
	end
	return ok, response
end

local function executeLuau(code)
	local loader = loadstring or load
	if not loader then
		return false, "loadstring is unavailable in this Studio."
	end

	local compiled, compileError = loader(code)
	if not compiled then
		return false, compileError
	end

	local ok, result = pcall(compiled)
	if not ok then
		return false, result
	end

	return true, result
end

local function getSelectionSummary()
	local selection = {}
	for _, instance in ipairs(Selection:Get()) do
		table.insert(selection, {
			name = instance.Name,
			className = instance.ClassName,
			fullName = instance:GetFullName()
		})
	end
	return selection
end

local function resolveInstanceByPath(pathString)
	if type(pathString) ~= "string" or pathString == "" then
		return nil
	end

	local segments = string.split(pathString, ".")
	if #segments == 0 then
		return nil
	end

	local startIndex = 1
	local current = game

	if string.lower(segments[1]) == "game" then
		startIndex = 2
	end

	for i = startIndex, #segments do
		local segment = segments[i]
		if i == startIndex then
			local ok, service = pcall(function()
				return game:GetService(segment)
			end)
			if ok and service then
				current = service
			else
				current = game:FindFirstChild(segment)
			end
		else
			current = current and current:FindFirstChild(segment)
		end
		if not current then
			return nil
		end
	end

	return current
end

local COMMON_PROPERTIES = {
	"Name", "ClassName", "Parent", "Archivable",
	-- BasePart
	"Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow",
	"Color", "Material", "Size", "Transparency", "Massless",
	"Shape", "BottomSurface", "TopSurface", "CFrame", "Position", "Orientation",
	"AssemblyLinearVelocity", "AssemblyAngularVelocity",
	-- MeshPart
	"MeshId", "TextureID", "RenderFidelity",
	-- Scripts
	"Source", "Enabled", "RunContext",
	-- GuiObject
	"AbsolutePosition", "AbsoluteSize", "AbsoluteRotation",
	"AnchorPoint", "BackgroundColor3", "BackgroundTransparency",
	"BorderColor3", "BorderSizePixel", "ClipsDescendants",
	"LayoutOrder", "Rotation", "SizeConstraint",
	"Visible", "ZIndex", "AutomaticSize",
	-- TextLabel/Button/Box
	"Text", "TextSize", "TextColor3", "TextTransparency",
	"TextWrapped", "TextXAlignment", "TextYAlignment",
	"Font", "FontFace", "RichText", "MaxVisibleGraphemes",
	-- ImageLabel/Button
	"Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter",
	-- ScreenGui
	"ResetOnSpawn", "IgnoreGuiInset", "DisplayOrder", "ZIndexBehavior",
	-- ScrollingFrame
	"CanvasSize", "CanvasPosition", "ScrollBarThickness",
	"ScrollingDirection", "ScrollingEnabled",
	-- UIStroke/UICorner/UIGradient/UIListLayout/UIPadding etc.
	"CornerRadius", "Thickness", "ApplyStrokeMode",
	"FillDirection", "HorizontalAlignment", "VerticalAlignment",
	"Padding", "PaddingLeft", "PaddingRight", "PaddingTop", "PaddingBottom",
	"SortOrder", "Wraps",
	-- Light
	"Brightness", "Range", "Shadows", "Angle", "Face",
	-- Sound
	"SoundId", "Volume", "PlaybackSpeed", "Looped", "Playing", "TimePosition", "TimeLength",
	-- ParticleEmitter / Beam
	"Rate", "Speed", "Lifetime", "Texture",
	-- Humanoid
	"Health", "MaxHealth", "WalkSpeed", "JumpPower", "JumpHeight",
	"HipHeight", "AutoRotate",
	-- Camera
	"CameraType", "FieldOfView", "CameraSubject",
	-- Folder / Model
	"PrimaryPart", "WorldPivot",
	-- Value objects
	"Value",
}

local function collectAllProperties(instance)
	local properties = {}

	for _, propName in ipairs(COMMON_PROPERTIES) do
		local ok, value = pcall(function()
			return instance[propName]
		end)
		if ok and value ~= nil then
			local serialized = serializeValue(value)
			if serialized ~= nil then
				properties[propName] = serialized
			elseif type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
				properties[propName] = value
			else
				properties[propName] = tostring(value)
			end
		end
	end

	-- Always include Parent path
	if instance.Parent then
		properties["_parentFullName"] = instance.Parent:GetFullName()
	end
	properties["_fullName"] = instance:GetFullName()

	-- Attributes
	local attributes, hasAttributes = syncableAttributes(instance:GetAttributes())
	if hasAttributes then
		properties["Attributes"] = attributes
	end

	-- Tags
	local tagsOk, tags = pcall(function()
		return instance:GetTags()
	end)
	if tagsOk and #tags > 0 then
		properties["_tags"] = tags
	end

	return properties
end

local function getDepthRelative(instance, root)
	local depth = 0
	local current = instance.Parent
	while current and current ~= root do
		depth = depth + 1
		current = current.Parent
	end
	return depth
end

local function handleCommand(command)
	if command.type == "apply_project_tree" then
		local isInitialPcSync = state.awaitingInitialSync and command.payload and command.payload.reason == "initial_pc_truth"
		local ok, message, appliedSnapshot = applyProjectSnapshot(command.payload.project)
		if ok and isInitialPcSync then
			state.awaitingInitialSync = false
			local watcherOk, watcherErr = pcall(startWatcher)
			if not watcherOk then
				appendLog("Failed to start watcher after initial PC sync: " .. tostring(watcherErr))
				reportPluginError(tostring(watcherErr), "WATCHER-START")
			end
			updateStatus("connected")
			appendLog("Initial PC sync completed.")
		end
		postCommandResult(command.id, ok, {
			result = message,
			snapshot = appliedSnapshot,
			error = ok and nil or message
		})
		appendLog(ok and "Local snapshot applied in Studio." or ("Apply failed: " .. tostring(message)))
		if not ok and isInitialPcSync then
			appendLog("Initial PC sync failed: " .. tostring(message))
			if resetSessionState then
				resetSessionState("initial sync failed")
			else
				state.awaitingInitialSync = false
				state.connected = false
				updateStatus("initial sync failed")
			end
		end
		return
	end

	if command.type == "apply_file_patch" then
		state.isApplyingRemote = true
		state.suppressPushUntil = now() + REMOTE_PUSH_SUPPRESSION_SECONDS
		local appliedSnapshot = nil
		
		local ok, err = pcall(function()
			local container = resolveMountContainer(command.payload.path)
			if container then
				local changed = updateScriptSourceIfChanged(container, command.payload.source, collectOpenDocumentSources())
				if changed then
					ChangeHistoryService:SetWaypoint("Amarillo Patch: " .. container.Name)
				end
				appliedSnapshot = snapshotCurrentProject()
			else
				error("Instance not found for path: " .. table.concat(command.payload.path, "."))
			end
		end)
		
		state.isApplyingRemote = false
		postCommandResult(command.id, ok, {
			result = ok and "Patch aplicado" or tostring(err),
			snapshot = appliedSnapshot,
			error = ok and nil or tostring(err)
		})
		return
	end

	if command.type == "run_code" then
		local ok, result = executeLuau(command.payload.code or "")
		postCommandResult(command.id, ok, {
			result = result,
			error = ok and nil or tostring(result)
		})
		appendLog(ok and "Luau executed through the daemon." or ("Luau failed: " .. tostring(result)))
		return
	end

	if command.type == "get_tree" then
		postCommandResult(command.id, true, {
			snapshot = snapshotCurrentProject()
		})
		appendLog("Current tree sent to the daemon.")
		return
	end

	if command.type == "get_selection" then
		postCommandResult(command.id, true, {
			selection = getSelectionSummary()
		})
		appendLog("Selection sent to the daemon.")
		return
	end

	if command.type == "playtest" then
		local ok, result = pcall(function()
			if command.payload.mode == "stop" then
				RunService:Stop()
				return "Playtest stopped"
			end
			RunService:Run()
			return "Playtest started"
		end)
		postCommandResult(command.id, ok, {
			result = result,
			error = ok and nil or tostring(result)
		})
		appendLog(ok and tostring(result) or ("Playtest failed: " .. tostring(result)))
		return
	end

	if command.type == "get_properties" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_properties falhou: caminho invalido.")
			return
		end
		local props = collectAllProperties(instance)
		postCommandResult(command.id, true, {
			path = command.payload.path,
			className = instance.ClassName,
			properties = props
		})
		appendLog("Properties sent to: " .. command.payload.path)
		return
	end

	if command.type == "get_descendants" then
		local root = resolveInstanceByPath(command.payload.path)
		if not root then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_descendants falhou: caminho invalido.")
			return
		end
		local maxDepth = command.payload.maxDepth or 10
		local classFilter = command.payload.classFilter
		local results = {}
		local MAX_RESULTS = 500

		local function walkDescendants(parent, currentDepth)
			if currentDepth > maxDepth or #results >= MAX_RESULTS then
				return
			end
			for _, child in ipairs(parent:GetChildren()) do
				if #results >= MAX_RESULTS then
					return
				end
				local matches = true
				if classFilter and classFilter ~= "" then
					matches = child:IsA(classFilter)
				end
				if matches then
					table.insert(results, {
						name = child.Name,
						className = child.ClassName,
						fullName = child:GetFullName(),
						depth = currentDepth,
						childCount = #child:GetChildren()
					})
				end
				walkDescendants(child, currentDepth + 1)
			end
		end

		walkDescendants(root, 1)
		postCommandResult(command.id, true, {
			path = command.payload.path,
			totalFound = #results,
			truncated = #results >= MAX_RESULTS,
			descendants = results
		})
		appendLog("Descendants enviados: " .. #results .. " de " .. command.payload.path)
		return
	end

	if command.type == "search_instances" then
		local query = string.lower(command.payload.query or "")
		local searchBy = command.payload.searchBy or "both"
		local scopeRoot = nil
		if command.payload.scope and command.payload.scope ~= "" then
			scopeRoot = resolveInstanceByPath(command.payload.scope)
		end
		if not scopeRoot then
			scopeRoot = game
		end

		local results = {}
		local MAX_RESULTS = 100

		local descendants = {}
		local ok = pcall(function()
			descendants = scopeRoot:GetDescendants()
		end)
		if not ok then
			descendants = scopeRoot:GetChildren()
		end

		for _, instance in ipairs(descendants) do
			if #results >= MAX_RESULTS then
				break
			end
			local nameMatch = searchBy ~= "className" and string.find(string.lower(instance.Name), query, 1, true)
			local classMatch = searchBy ~= "name" and string.find(string.lower(instance.ClassName), query, 1, true)
			if nameMatch or classMatch then
				table.insert(results, {
					name = instance.Name,
					className = instance.ClassName,
					fullName = instance:GetFullName(),
					parent = instance.Parent and instance.Parent:GetFullName() or "nil"
				})
			end
		end

		postCommandResult(command.id, true, {
			query = command.payload.query,
			totalFound = #results,
			truncated = #results >= MAX_RESULTS,
			results = results
		})
		appendLog("Busca concluida: " .. #results .. " resultados para '" .. command.payload.query .. "'")
		return
	end

	if command.type == "get_services" then
		local services = {}
		for _, child in ipairs(game:GetChildren()) do
			local childCountOk, childCount = pcall(function()
				return #child:GetChildren()
			end)
			table.insert(services, {
				name = child.Name,
				className = child.ClassName,
				childCount = childCountOk and childCount or 0
			})
		end
		table.sort(services, function(a, b)
			return a.name < b.name
		end)
		postCommandResult(command.id, true, {
			services = services,
			totalServices = #services
		})
		appendLog("Lista de services enviada: " .. #services .. " services.")
		return
	end

	if command.type == "get_instance_info" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path)
			})
			appendLog("get_instance_info falhou: caminho invalido.")
			return
		end

		local children = {}
		for _, child in ipairs(instance:GetChildren()) do
			table.insert(children, {
				name = child.Name,
				className = child.ClassName,
				childCount = #child:GetChildren()
			})
		end
		table.sort(children, function(a, b)
			return a.name < b.name
		end)

		local props = collectAllProperties(instance)

		postCommandResult(command.id, true, {
			path = command.payload.path,
			name = instance.Name,
			className = instance.ClassName,
			fullName = instance:GetFullName(),
			parent = instance.Parent and instance.Parent:GetFullName() or "nil",
			children = children,
			childCount = #children,
			properties = props
		})
		appendLog("Info de instancia enviada: " .. command.payload.path)
		return
	end

	if command.type == "get_output_log" then
		local count = command.payload.count or 50
		local entries = {}
		local ok, logHistory = pcall(function()
			return LogService:GetLogHistory()
		end)
		if ok and logHistory then
			local startIndex = math.max(1, #logHistory - count + 1)
			for i = startIndex, #logHistory do
				local entry = logHistory[i]
				table.insert(entries, {
					message = entry.message,
					messageType = tostring(entry.messageType),
					timestamp = entry.timestamp
				})
			end
		end
		postCommandResult(command.id, true, {
			entries = entries,
			totalEntries = #entries
		})
		appendLog("Output log enviado: " .. #entries .. " entradas.")
		return
	end

	if command.type == "modify_property" then
		local instance = resolveInstanceByPath(command.payload.path)
		if not instance then
			postCommandResult(command.id, false, {
				error = "Instance not found: " .. tostring(command.payload.path),
				blocked = false,
				declined = false,
				confirmed = false,
				reasonCode = "INSTANCE_NOT_FOUND"
			})
			appendLog("modify_property falhou: caminho invalido.")
			return
		end

		if state.confirmDestructiveActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another destructive action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("modify_property rejeitado: ja existe uma acao destrutiva aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end

		executeModifyProperty(command)
		return
	end

	if command.type == "create_instance" then
		if state.confirmDestructiveActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another destructive action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("create_instance rejeitado: ja existe uma acao destrutiva aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeCreateInstance(command)
		return
	end

	if command.type == "delete_instance" then
		if state.confirmDestructiveActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another destructive action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("delete_instance rejeitado: ja existe uma acao destrutiva aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeDeleteInstance(command)
		return
	end

	if command.type == "insert_model" then
		if state.confirmDestructiveActions then
			if state.pendingDestructiveCommand then
				postCommandResult(command.id, false, {
					error = "Another destructive action is already awaiting confirmation.",
					blocked = true,
					declined = false,
					confirmed = false,
					reasonCode = "CONFIRMATION_ALREADY_PENDING"
				})
				appendLog("insert_model rejeitado: ja existe uma acao destrutiva aguardando confirmacao.")
				return
			end
			showDestructiveConfirmation(command)
			return
		end
		executeInsertModel(command)
		return
	end

	postCommandResult(command.id, false, {
		error = "Comando desconhecido: " .. tostring(command.type)
	})
end

local function handleCommandSafely(command)
	local isInitialPcSync = command
		and command.type == "apply_project_tree"
		and command.payload
		and command.payload.reason == "initial_pc_truth"
		and state.awaitingInitialSync
	local ok, err = xpcall(function()
		handleCommand(command)
	end, function(errorValue)
		return tostring(errorValue)
	end)
	if ok then
		return
	end

	state.isApplyingRemote = false
	local commandId = command and command.id or nil
	local commandType = command and command.type or "unknown"
	appendLog("Command failed: " .. tostring(commandType) .. " -> " .. tostring(err))
	reportPluginError(err, "PLUGIN-COMMAND", {
		commandId = commandId,
		commandType = commandType
	}, "error")
	if commandId then
		postCommandResult(commandId, false, {
			error = tostring(err)
		})
	end
	if isInitialPcSync then
		appendLog("Initial PC sync failed: " .. tostring(err))
		if resetSessionState then
			resetSessionState("initial sync failed")
		else
			state.awaitingInitialSync = false
			state.connected = false
			updateStatus("initial sync failed")
		end
	end
end

local function syncSnapshot(reason)
	if not state.sessionId or not state.project or state.isApplyingRemote then
		return
	end
	if state.awaitingInitialSync and reason ~= "initial_accept" then
		return
	end
	if state.awaitingInitialStudioSync and reason ~= "initial_accept" then
		return
	end
	if now() < state.suppressPushUntil then
		return
	end
	if state.syncState == "degraded" and reason ~= "manual" and reason ~= "initial_accept" then
		return
	end
	if state.versionState == "blocked" then
		return
	end

	local snapshot = snapshotCurrentProject()
	if not snapshot then
		return false, "Snapshot unavailable."
	end
	-- OPT-005: Build the full body JSON once, reuse for comparison and HTTP send
	local bodyTable = {
		sessionId = state.sessionId,
		snapshot = snapshot,
		reason = reason or "auto"
	}
	addVersionPayload(bodyTable)
	local bodyJson = HttpService:JSONEncode(bodyTable)
	local snapshotJson = HttpService:JSONEncode(snapshot)
	if snapshotJson == state.lastSnapshotJson and reason ~= "manual" and reason ~= "initial_accept" then
		return
	end

	state.lastSnapshotJson = snapshotJson
	state.treeCache = snapshot
	local ok, response = requestRawBody("POST", "/studio/snapshot", bodyJson)
	appendLog(ok and ("Sending snapshot: " .. (reason or "auto")) or ("Failed to send snapshot: " .. tostring(response)))
	return ok, response
end

local function attemptInitialStudioSync(context, force)
	if not state.connected or not state.sessionId or not state.project or not state.awaitingInitialStudioSync then
		return false
	end

	local currentTime = now()
	if not force and currentTime - (state.lastInitialStudioSyncAttemptAt or 0) < INITIAL_STUDIO_SYNC_RETRY_SECONDS then
		return false
	end
	state.lastInitialStudioSyncAttemptAt = currentTime

	local callOk, ok, syncResponse = xpcall(function()
		return syncSnapshot("initial_accept")
	end, function(errorValue)
		return tostring(errorValue)
	end)
	if not callOk then
		syncResponse = ok
		ok = false
	end

	if ok then
		state.awaitingInitialStudioSync = false
		state.lastInitialStudioSyncErrorMessage = nil
		state.lastInitialStudioSyncErrorAt = 0
		appendLog("Roblox Studio set as the initial source of truth.")
		local watcherOk, watcherErr = pcall(startWatcher)
		if not watcherOk then
			appendLog("Failed to start watcher after Studio sync: " .. tostring(watcherErr))
			reportPluginError(tostring(watcherErr), "WATCHER-START")
		end
		updateStatus("connected")
		return true, syncResponse
	end

	local message = syncResponse or "Initial Studio snapshot was not sent."
	local shouldReport = state.lastInitialStudioSyncErrorMessage ~= message
		or currentTime - (state.lastInitialStudioSyncErrorAt or 0) >= INITIAL_STUDIO_SYNC_LOG_SECONDS
	if shouldReport then
		state.lastInitialStudioSyncErrorMessage = message
		state.lastInitialStudioSyncErrorAt = currentTime
		appendLog("Initial Studio sync still pending: " .. tostring(message))
		reportPluginError(message, "PLUGIN-INITIAL-SYNC", {
			route = "/studio/snapshot",
			sessionId = state.sessionId,
			projectId = state.project and state.project.id or state.selectedProjectId,
			truthSource = "studio",
			hasSessionToken = state.sessionToken ~= nil,
			context = context or "retry"
		}, "warning")
	end
	updateStatus("syncing from Studio")
	return false, message
end

local function refreshTreePreview()
	local snapshot = snapshotCurrentProject()
	state.treeCache = snapshot
	if state.ui.treeBox then
		local json = HttpService:JSONEncode(snapshot or {})
		if #json > 190000 then
			json = string.sub(json, 1, 190000) .. "\n... (truncado)"
		end
		state.ui.treeBox.Text = json
	end
end

function resetSessionState(statusText)
	state.connected = false
	state.awaitingInitialSync = false
	state.awaitingInitialStudioSync = false
	state.lastInitialStudioSyncAttemptAt = 0
	state.lastInitialStudioSyncErrorAt = 0
	state.lastInitialStudioSyncErrorMessage = nil
	state.sessionId = nil
	state.sessionToken = nil
	state.project = nil
	state.projectSelectionReason = nil
	state.projectSelectionMessage = nil
	state.pendingConnectionContext = nil
	state.pendingDestructiveCommand = nil
	state.lastSnapshotJson = nil
	state.syncState = "ready"
	state.syncMessage = nil
	state.versionState = "unknown"
	state.versionMessage = nil
	state.lastSyncStatusMessage = nil
	if statusText then
		updateStatus(statusText)
	end
	if state.ui.propertyConfirmOverlay then
		state.ui.propertyConfirmOverlay.Visible = false
	end
	updateProject(currentWorkspaceLabel())
	updateSession("-")
	updateQueue("-")
	updateConflict("0")
	updateProjectTargetSummary()
end

local function hideConnectionPrompt()
	if state.ui.connectionPromptOverlay then
		state.ui.connectionPromptOverlay.Visible = false
	end
	state.pendingConnectionContext = nil
end

-- ===== Destructive Action Confirmation System =====
local function formatValueForDisplay(value)
	if type(value) == "table" then
		local okEncode, encoded = pcall(function()
			return HttpService:JSONEncode(value)
		end)
		if okEncode then
			if #encoded > 80 then
				return string.sub(encoded, 1, 77) .. "..."
			end
			return encoded
		end
	end
	return tostring(value)
end

executeModifyProperty = function(command)
	local instance = resolveInstanceByPath(command.payload.path)
	if not instance then
		postCommandResult(command.id, false, {
			error = "Instance not found: " .. tostring(command.payload.path),
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "INSTANCE_NOT_FOUND"
		})
		appendLog("modify_property falhou: caminho invalido.")
		return
	end

	local propName = command.payload.property
	local rawValue = command.payload.value

	-- Verificacao: ler valor atual primeiro
	local currentValue = safeGetProperty(instance, propName)
	if currentValue == nil and propName ~= "Value" then
		-- Tenta verificar se eh atributo
		local attrValue = instance:GetAttribute(propName)
		if attrValue ~= nil then
			-- Eh um atributo, setar como atributo
			local ok, err = pcall(function()
				ChangeHistoryService:SetWaypoint("MCP modify attribute: " .. propName)
				instance:SetAttribute(propName, rawValue)
				ChangeHistoryService:SetWaypoint("MCP modify attribute done")
			end)
			postCommandResult(command.id, ok, {
				result = ok and "Attribute changed successfully" or nil,
				error = ok and nil or tostring(err),
				path = command.payload.path,
				property = propName,
				blocked = false,
				declined = false,
				confirmed = true,
				reasonCode = ok and nil or "MODIFY_FAILED"
			})
			appendLog(ok and ("Attribute " .. propName .. " changed at " .. command.payload.path) or ("modify_property failed: " .. tostring(err)))
			return
		end
	end

	local ok, err = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP modify property: " .. propName)
		setProperty(instance, propName, rawValue)
		ChangeHistoryService:SetWaypoint("MCP modify property done")
	end)
	postCommandResult(command.id, ok, {
		result = ok and "Property changed successfully" or nil,
		error = ok and nil or tostring(err),
		path = command.payload.path,
		property = propName,
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "MODIFY_FAILED"
	})
	appendLog(ok and ("Property " .. propName .. " changed at " .. command.payload.path) or ("modify_property failed: " .. tostring(err)))
end

executeCreateInstance = function(command)
	local parent = resolveInstanceByPath(command.payload.parentPath)
	if not parent then
		postCommandResult(command.id, false, {
			error = "Parent not found: " .. tostring(command.payload.parentPath),
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "PARENT_NOT_FOUND"
		})
		appendLog("create_instance falhou: parent invalido.")
		return
	end

	local className = command.payload.className
	local instanceName = command.payload.name or className
	local ok, result = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP create instance: " .. className)
		local newInstance = Instance.new(className)
		newInstance.Name = instanceName

		for propName, propValue in pairs(command.payload.properties or {}) do
			setProperty(newInstance, propName, propValue)
		end

		newInstance.Parent = parent
		ChangeHistoryService:SetWaypoint("MCP create instance done")
		return newInstance:GetFullName()
	end)

	postCommandResult(command.id, ok, {
		result = ok and "Instance created successfully" or nil,
		fullName = ok and result or nil,
		error = ok and nil or tostring(result),
		parentPath = command.payload.parentPath,
		className = className,
		name = instanceName,
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "CREATE_FAILED"
	})
	appendLog(ok and ("Instance " .. className .. " created at " .. command.payload.parentPath) or ("create_instance failed: " .. tostring(result)))
end

executeDeleteInstance = function(command)
	local instance = resolveInstanceByPath(command.payload.path)
	if not instance then
		postCommandResult(command.id, false, {
			error = "Instance not found: " .. tostring(command.payload.path),
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "INSTANCE_NOT_FOUND"
		})
		appendLog("delete_instance falhou: caminho invalido.")
		return
	end

	if instance.Parent == game then
		postCommandResult(command.id, false, {
			error = "Deleting game services directly is not allowed.",
			blocked = true,
			declined = false,
			confirmed = false,
			reasonCode = "DELETE_SERVICE_BLOCKED"
		})
		appendLog("delete_instance bloqueado: tentativa de deletar service.")
		return
	end
	if isProtectedSyncInstance(instance) then
		postCommandResult(command.id, false, {
			error = "Deleting protected instances such as Workspace.Terrain or player characters is not allowed.",
			blocked = true,
			declined = false,
			confirmed = false,
			reasonCode = "DELETE_PROTECTED_BLOCKED"
		})
		appendLog("delete_instance bloqueado: tentativa de deletar instancia protegida.")
		return
	end

	local fullName = instance:GetFullName()
	local ok, err = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP delete instance: " .. fullName)
		instance:Destroy()
		ChangeHistoryService:SetWaypoint("MCP delete instance done")
	end)

	postCommandResult(command.id, ok, {
		result = ok and "Instance deleted successfully" or nil,
		deletedPath = ok and fullName or nil,
		error = ok and nil or tostring(err),
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = ok and nil or "DELETE_FAILED"
	})
	appendLog(ok and ("Instance deleted: " .. fullName) or ("delete_instance failed: " .. tostring(err)))
end

executeInsertModel = function(command)
	local query = tostring(command.payload.query or "")
	if query == "" then
		postCommandResult(command.id, false, {
			error = "Model query is required.",
			blocked = false,
			declined = false,
			confirmed = false,
			reasonCode = "INVALID_QUERY"
		})
		appendLog("insert_model falhou: query vazia.")
		return
	end

	local okSearch, results = pcall(function()
		return InsertService:GetFreeModels(query, 0)
	end)
	if not okSearch then
		postCommandResult(command.id, false, {
			error = tostring(results),
			blocked = false,
			declined = false,
			confirmed = true,
			reasonCode = "INSERT_SEARCH_FAILED"
		})
		appendLog("insert_model falhou na busca: " .. tostring(results))
		return
	end
	if type(results) ~= "table" or #results == 0 then
		postCommandResult(command.id, false, {
			error = "No free models were found for query: " .. query,
			blocked = false,
			declined = false,
			confirmed = true,
			reasonCode = "NO_MODEL_FOUND"
		})
		appendLog("insert_model nao encontrou resultados para: " .. query)
		return
	end

	local assetId = results[1].AssetId
	local okInsert, insertResult = pcall(function()
		ChangeHistoryService:SetWaypoint("MCP insert model: " .. query)
		local model = InsertService:LoadAsset(assetId)
		local children = model:GetChildren()
		if #children == 0 then
			model:Destroy()
			error("Inserted asset did not return any children.")
		end
		local insertedName = children[1].Name
		for _, child in ipairs(children) do
			child.Parent = workspace
		end
		model:Destroy()
		ChangeHistoryService:SetWaypoint("MCP insert model done")
		return {
			insertedName = insertedName,
			insertedCount = #children,
			assetId = assetId
		}
	end)

	postCommandResult(command.id, okInsert, {
		result = okInsert and "Model inserted successfully" or nil,
		insertedName = okInsert and insertResult.insertedName or nil,
		insertedCount = okInsert and insertResult.insertedCount or nil,
		assetId = okInsert and insertResult.assetId or assetId,
		error = okInsert and nil or tostring(insertResult),
		blocked = false,
		declined = false,
		confirmed = true,
		reasonCode = okInsert and nil or "INSERT_FAILED"
	})
	appendLog(okInsert and ("Model inserted from query: " .. query) or ("insert_model failed: " .. tostring(insertResult)))
end

executeDestructiveCommand = function(command)
	if command.type == "modify_property" then
		executeModifyProperty(command)
		return
	end
	if command.type == "create_instance" then
		executeCreateInstance(command)
		return
	end
	if command.type == "delete_instance" then
		executeDeleteInstance(command)
		return
	end
	if command.type == "insert_model" then
		executeInsertModel(command)
	end
end

local function destructiveConfirmationContent(command)
	if command.type == "modify_property" then
		local propName = tostring(command.payload.property or "?")
		local instancePath = tostring(command.payload.path or "?")
		local valueDisplay = formatValueForDisplay(command.payload.value)
		return {
			title = "Confirm Property Change",
			body = "Instance: " .. instancePath,
			detail = "Property: " .. propName .. "\nNew value: " .. valueDisplay,
			logMessage = "Property change awaiting confirmation: " .. propName .. " at " .. instancePath
		}
	end
	if command.type == "create_instance" then
		local propertyCount = 0
		for _propName, _propValue in pairs(command.payload.properties or {}) do
			propertyCount = propertyCount + 1
		end
		return {
			title = "Confirm Instance Creation",
			body = "Parent: " .. tostring(command.payload.parentPath or "?"),
			detail = "Class: " .. tostring(command.payload.className or "?")
				.. "\nName: " .. tostring(command.payload.name or command.payload.className or "?")
				.. "\nInitial properties: " .. tostring(propertyCount),
			logMessage = "Instance creation awaiting confirmation at " .. tostring(command.payload.parentPath)
		}
	end
	if command.type == "delete_instance" then
		return {
			title = "Confirm Instance Deletion",
			body = "Target: " .. tostring(command.payload.path or "?"),
			detail = "This instance will be permanently destroyed in Roblox Studio.",
			logMessage = "Instance deletion awaiting confirmation: " .. tostring(command.payload.path)
		}
	end
	return {
		title = "Confirm Model Insert",
		body = "Marketplace query: " .. tostring(command.payload.query or "?"),
		detail = "The first free model match will be inserted into Workspace.",
		logMessage = "Model insert awaiting confirmation: " .. tostring(command.payload.query)
	}
end

showDestructiveConfirmation = function(command)
	state.pendingDestructiveCommand = command
	if state.ui.propertyConfirmOverlay then
		local content = destructiveConfirmationContent(command)
		setTextIfPresent(state.ui.propertyConfirmTitle, content.title)
		setTextIfPresent(state.ui.propertyConfirmBody, content.body)
		setTextIfPresent(state.ui.propertyConfirmDetail, content.detail)
		state.ui.propertyConfirmOverlay.Visible = true
		updateStatus("waiting for confirmation")
	end
	widget.Enabled = true
	appendLog(destructiveConfirmationContent(command).logMessage)
end

hideDestructiveConfirmation = function()
	if state.ui.propertyConfirmOverlay then
		state.ui.propertyConfirmOverlay.Visible = false
	end
	state.pendingDestructiveCommand = nil
end

acceptDestructiveAction = function()
	local command = state.pendingDestructiveCommand
	if not command then
		return
	end
	state.pendingDestructiveCommand = nil
	hideDestructiveConfirmation()
	executeDestructiveCommand(command)
end

declineDestructiveAction = function()
	local command = state.pendingDestructiveCommand
	if not command then
		return
	end
	state.pendingDestructiveCommand = nil
	hideDestructiveConfirmation()
	postCommandResult(command.id, false, {
		error = "Destructive action declined by user.",
		blocked = false,
		declined = true,
		confirmed = false,
		reasonCode = "DECLINED_BY_USER"
	})
	appendLog("Destructive action declined: " .. tostring(command.type))
end

local function openConnectionPrompt(context)
	state.pendingConnectionContext = context
	if context.offerId then
		state.seenOfferIds[context.offerId] = true
	end
	if state.ui.connectionPromptOverlay then
		local title = context.offerId and "New VS Code connection" or "Connect to workspace"
		local workspaceLabel = context.workspaceName or currentWorkspaceLabel()
		setTextIfPresent(state.ui.connectionPromptTitle, title)
		setTextIfPresent(state.ui.connectionPromptBody, "The plugin detected a connection request for " .. workspaceLabel .. ".")
		setTextIfPresent(state.ui.connectionPromptHint, "Accept to choose the initial source of truth.")
		state.ui.connectionPromptAccept.Visible = true
		state.ui.connectionPromptDecline.Visible = true
		state.ui.connectionPromptChoosePc.Visible = false
		state.ui.connectionPromptChooseStudio.Visible = false
		state.ui.connectionPromptOverlay.Visible = true
	end
	widget.Enabled = true
	updateStatus("waiting for confirmation")
	appendLog("Connection request received. Waiting for your confirmation.")
end

local function showTruthSourcePrompt()
	if not state.pendingConnectionContext or not state.ui.connectionPromptOverlay then
		return
	end
	setTextIfPresent(state.ui.connectionPromptTitle, "Choose the source of truth")
	setTextIfPresent(state.ui.connectionPromptBody, "Which side should win the first sync for this session?")
	setTextIfPresent(state.ui.connectionPromptHint, "PC sends everything to Studio. Roblox Studio writes everything to disk.")
	state.ui.connectionPromptAccept.Visible = false
	state.ui.connectionPromptDecline.Visible = false
	state.ui.connectionPromptChoosePc.Visible = true
	state.ui.connectionPromptChooseStudio.Visible = true
end

local function applyAcceptedSession(response, truthSource)
	state.sessionId = response.session and response.session.id or nil
	state.sessionToken = response.session and response.session.sessionToken or nil
	state.project = response.project
	state.projectSelectionReason = response.session and response.session.projectSelectionReason or nil
	state.projectSelectionMessage = response.session and response.session.projectSelectionMessage or nil
	state.connected = state.sessionId ~= nil
	state.awaitingInitialSync = truthSource == "pc"
	state.awaitingInitialStudioSync = truthSource == "studio"
	state.lastInitialStudioSyncAttemptAt = 0
	state.lastInitialStudioSyncErrorAt = 0
	state.lastInitialStudioSyncErrorMessage = nil
	state.connectionOffer = response.offer or nil
	state.syncState = "ready"
	state.syncMessage = nil
	state.versionState = response.session and response.session.versionState or "unknown"
	state.versionMessage = response.session and response.session.versionMessage or nil
	state.lastSyncStatusMessage = nil
	if state.project and state.selectedProjectId then
		state.selectedProjectName = state.project.name
	end
	saveSettings()
	fetchDaemonHealth()

	updateStatus(truthSource == "pc" and "syncing from PC" or "syncing from Studio")
	updateProject(currentWorkspaceLabel())
	updateSession(state.sessionId or "-")
	updateQueue("waiting")
	updateConflict("0")
	updateProjectTargetSummary()
	refreshTreePreview()
	if state.projectSelectionMessage then
		appendLog(state.projectSelectionMessage)
	end
	if response.session and response.session.requiresPluginUpdate == true then
		applySyncSummary(response.session)
		appendLog("Sync blocked until the Amarillo plugin is updated.")
		return
	end

	if truthSource == "studio" then
		attemptInitialStudioSync("accept", true)
	else
		appendLog("PC set as the initial source of truth. Waiting for the daemon's initial apply.")
	end
end

local function acceptPendingConnection(truthSource)
	local context = state.pendingConnectionContext
	if not context then
		return
	end
	local ok, response = request("POST", "/connection/accept", {
		offerId = context.offerId,
		studioInstanceId = state.studioInstanceId,
		placeId = game.PlaceId,
		projectId = state.selectedProjectId,
		truthSource = truthSource,
		pluginVersion = PLUGIN_VERSION,
		pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION
	})
	if not ok or not response or response.ok ~= true then
		if type(response) == "table" and response.offer and response.offer.status and response.offer.status ~= "pending" then
			hideConnectionPrompt()
		end
		updateStatus("connection error")
		appendLog("Connection failed: " .. tostring(response))
		return
	end

	hideConnectionPrompt()
	applyAcceptedSession(response, truthSource)
end

local function connectSession()
	if state.connected and state.sessionId then
		appendLog("A session is already connected. Use Disconnect before opening another one.")
		return
	end
	local parsedPort = normalizePort(state.port)
	if not parsedPort then
		updateStatus("invalid port")
		appendLog("Set a valid port in Settings before connecting.")
		return
	end
	state.port = parsedPort
	updateEndpointSummary()
	local healthOk, health = fetchDaemonHealth()
	if not healthOk then
		resetSessionState("daemon offline")
		appendLog("Connection failed: " .. tostring(health))
		return
	end
	if tonumber(health.projectCount or 0) == 0 then
		resetSessionState("workspace has no project")
		appendLog("The daemon's current folder (" .. currentWorkspaceLabel() .. ") does not contain any .project.json.")
		return
	end
	openConnectionPrompt({
		offerId = nil,
		workspaceName = workspaceNameFromRoot(health.workspaceRoot)
	})
end

local function declinePendingConnection()
	local context = state.pendingConnectionContext
	if not context then
		return
	end
	if context.offerId then
		local ok, response = request("POST", "/connection/decline", {
			offerId = context.offerId,
			studioInstanceId = state.studioInstanceId
		})
		appendLog(ok and "Connection declined in Roblox Studio." or ("Failed to decline connection: " .. tostring(response)))
	end
	state.connectionOffer = nil
	hideConnectionPrompt()
	updateStatus("disconnected")
end

local function confirmPendingConnection()
	showTruthSourcePrompt()
end

local function handleDiffConfirm(truthSource)
	if state.ui.diffOverlay then
		state.ui.diffOverlay.Visible = false
	end
	acceptPendingConnection(truthSource)
end

local function cancelDiff()
	if state.ui.diffOverlay then
		state.ui.diffOverlay.Visible = false
	end
	showTruthSourcePrompt()
end

local function showDiffOverlay(truthSource, changes)
	if state.ui.connectionPromptOverlay then
		state.ui.connectionPromptOverlay.Visible = false
	end
	if not state.ui.diffOverlay then
		return
	end
	
	for _, child in ipairs(state.ui.diffList:GetChildren()) do
		if not child:IsA("UIListLayout") and not child:IsA("UIPadding") then
			child:Destroy()
		end
	end

	for _, changeMsg in ipairs(changes or {}) do
		local label = makeTextLabel(state.ui.diffList, changeMsg, UDim2.new(1, -8, 0, 16), UDim2.new(0, 4, 0, 0), 12)
		if changeMsg:sub(1, 1) == "+" then
			label.TextColor3 = Color3.fromRGB(120, 214, 140)
		elseif changeMsg:sub(1, 1) == "-" then
			label.TextColor3 = Color3.fromRGB(214, 120, 120)
		elseif changeMsg:sub(1, 1) == "~" then
			label.TextColor3 = Color3.fromRGB(214, 183, 120)
		else
			label.TextColor3 = Color3.fromRGB(180, 186, 196)
		end
	end

	local layout = state.ui.diffList:FindFirstChildOfClass("UIListLayout")
	if layout then
		state.ui.diffListCanvas.CanvasSize = UDim2.new(0, 0, 0, layout.AbsoluteContentSize.Y + 8)
	end

	if state.ui.diffConfirmConnection then
		state.ui.diffConfirmConnection:Disconnect()
		state.ui.diffConfirmConnection = nil
	end

	if state.ui.diffConfirmBtn then
		state.ui.diffConfirmConnection = state.ui.diffConfirmBtn.MouseButton1Click:Connect(function()
			handleDiffConfirm(truthSource)
		end)
	end

	state.ui.diffOverlay.Visible = true
end

local function fetchAndShowDiff(truthSource)
	if state.ui.connectionPromptBody then
		state.ui.connectionPromptBody.Text = "Calculating changes..."
		state.ui.connectionPromptChoosePc.Visible = false
		state.ui.connectionPromptChooseStudio.Visible = false
	end

	local studioSnapshot = { mounts = {} }
	local okSnapshot, projectOrErr = pcall(snapshotCurrentProject)
	if okSnapshot and projectOrErr then
		studioSnapshot = projectOrErr
	end
	
	local ok, response = request("POST", "/connection/diff", {
		placeId = game.PlaceId,
		projectId = state.selectedProjectId,
		truthSource = truthSource,
		studioSnapshot = studioSnapshot
	})

	if ok and response and response.changes then
		showDiffOverlay(truthSource, response.changes)
	else
		appendLog("Failed to calculate diff. Proceeding without preview.")
		acceptPendingConnection(truthSource)
	end
end

local function choosePcTruth()
	acceptPendingConnection("pc")
end

local function chooseStudioTruth()
	acceptPendingConnection("studio")
end

local function pollConnectionOffer()
	local ok, response = request("GET", "/studio/poll?studioInstanceId=" .. state.studioInstanceId .. "&" .. pluginVersionQuery())
	if not ok then
		return false, response
	end
	local offer = response.offer
	state.connectionOffer = offer
	if offer and offer.offerId and not state.seenOfferIds[offer.offerId] and not state.pendingConnectionContext then
		openConnectionPrompt({
			offerId = offer.offerId,
			workspaceName = state.workspaceName or currentWorkspaceLabel()
		})
	end
	return true, response
end

local function disconnectSession()
	pcall(disconnectWatcher)
	hideConnectionPrompt()
	if state.sessionId then
		request("POST", "/session/close", {
			sessionId = state.sessionId
		})
	end
	resetSessionState("disconnected")
	saveSettings()
	appendLog("Session closed.")
end

local function manualPull()
	if not state.sessionId then
		appendLog("Connect the plugin before receiving from PC.")
		return
	end
	local ok, response = request("POST", "/session/" .. state.sessionId .. "/pull", {})
	appendLog(ok and "Receiving files from PC..." or ("Receive from PC failed: " .. tostring(response)))
end

local function manualPush()
	if not state.sessionId then
		appendLog("Connect the plugin before sending to PC.")
		return
	end
	local ok, response = syncSnapshot("manual")
	appendLog(ok and "Sending files to PC..." or ("Send to PC failed: " .. tostring(response)))
end

local function manualRunCode()
	if not state.sessionId then
		appendLog("Connect the plugin before executing code.")
		return
	end
	local code = state.ui.codeBox and state.ui.codeBox.Text or ""
	local ok, response = request("POST", "/session/" .. state.sessionId .. "/exec", {
		code = code
	})
	if ok then
		appendLog("Luau executed by the daemon.")
		if state.ui.treeBox then
			state.ui.treeBox.Text = HttpService:JSONEncode(response.result or {})
		end
	else
		appendLog("Failed to execute Luau: " .. tostring(response))
	end
end

local function manualSelection()
	if not state.sessionId then
		appendLog("Connect the plugin before requesting the selection.")
		return
	end
	local ok, response = request("GET", "/session/" .. state.sessionId .. "/selection")
	if ok and state.ui.treeBox then
		state.ui.treeBox.Text = HttpService:JSONEncode(response.selection or {})
		appendLog("Selection loaded into the inspection area.")
	else
		appendLog("Failed to load selection: " .. tostring(response))
	end
end

local function sendPlaytest(mode)
	if not state.sessionId then
		appendLog("Connect the plugin before controlling playtest.")
		return
	end
	local ok, response = request("POST", "/session/" .. state.sessionId .. "/playtest", {
		mode = mode
	})
	appendLog(ok and ("Playtest " .. mode .. " requested.") or ("Playtest failed: " .. tostring(response)))
end

local function pollCommands()
	if not state.sessionId then
		return
	end
	local ok, response = request("GET", "/studio/poll?sessionId=" .. state.sessionId .. "&" .. pluginVersionQuery())
	if not ok then
		updateStatus("daemon offline")
		appendLog("Polling failed: " .. tostring(response))
		return
	end
	updateStatus("connected")
	updateQueue(tostring(#(response.commands or {})))

	for _, command in ipairs(response.commands or {}) do
		handleCommand(command)
	end
end

local function makeTextLabel(parent, text, size, position, textSize)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.TextColor3 = Color3.fromRGB(230, 230, 235)
	label.Font = Enum.Font.Code
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Top
	label.TextSize = textSize or 14
	label.TextWrapped = true
	label.Text = text
	label.Size = size
	label.Position = position
	label.Parent = parent
	return label
end

local function addCorner(instance, radius)
	local corner = Instance.new("UICorner")
	corner.CornerRadius = radius or UDim.new(0, 8)
	corner.Parent = instance
end

local function makeButton(parent, text, size, position, callback)
	local button = Instance.new("TextButton")
	button.Text = text
	button.Font = Enum.Font.GothamSemibold
	button.TextSize = 13
	button.TextColor3 = Color3.fromRGB(250, 250, 250)
	button.BackgroundColor3 = Color3.fromRGB(39, 88, 123)
	button.BorderSizePixel = 0
	button.AutoButtonColor = true
	button.Size = size
	button.Position = position
	button.Parent = parent
	addCorner(button)
	button.MouseButton1Click:Connect(callback)
	return button
end

local function makeTextBox(parent, placeholder, size, position, multiline)
	local box = Instance.new("TextBox")
	box.Text = ""
	box.PlaceholderText = placeholder
	box.MultiLine = multiline or false
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.TextYAlignment = Enum.TextYAlignment.Top
	box.Font = Enum.Font.Code
	box.TextSize = 13
	box.TextColor3 = Color3.fromRGB(240, 240, 240)
	box.BackgroundColor3 = Color3.fromRGB(26, 29, 34)
	box.BorderSizePixel = 0
	box.Size = size
	box.Position = position
	box.Parent = parent
	addCorner(box)
	return box
end

local function makeCard(parent, size, position, color)
	local card = Instance.new("Frame")
	card.BackgroundColor3 = color or Color3.fromRGB(24, 27, 33)
	card.BorderSizePixel = 0
	card.Size = size
	card.Position = position
	card.Parent = parent
	addCorner(card, UDim.new(0, 12))
	return card
end

local function setButtonStyle(button, styleName)
	if styleName == "secondary" then
		button.BackgroundColor3 = Color3.fromRGB(34, 38, 46)
		button.TextColor3 = Color3.fromRGB(223, 226, 232)
	elseif styleName == "ghost" then
		button.BackgroundColor3 = Color3.fromRGB(22, 25, 30)
		button.TextColor3 = Color3.fromRGB(182, 188, 198)
	else
		button.BackgroundColor3 = Color3.fromRGB(39, 88, 123)
		button.TextColor3 = Color3.fromRGB(250, 250, 250)
	end
end

local function showView(viewName)
	state.currentView = viewName
	if state.ui.homePage then
		state.ui.homePage.Visible = viewName == "home"
	end
	if state.ui.settingsPage then
		state.ui.settingsPage.Visible = viewName == "settings"
	end
	if state.ui.advancedPage then
		state.ui.advancedPage.Visible = viewName == "advanced"
	end
end

local function renderProjectList()
	if not state.ui.projectList then
		return
	end

	for _, child in ipairs(state.ui.projectList:GetChildren()) do
		if not child:IsA("UIListLayout") and not child:IsA("UIPadding") then
			child:Destroy()
		end
	end

	local selectedId = state.settingsProjectId

	local autoButton = makeButton(state.ui.projectList, "Auto Detect", UDim2.new(1, -8, 0, 28), UDim2.new(0, 4, 0, 0), function()
		state.settingsProjectId = nil
		renderProjectList()
	end)
	if not selectedId then
		setButtonStyle(autoButton, "primary")
	else
		setButtonStyle(autoButton, "secondary")
	end

	for _, project in ipairs(state.availableProjects or {}) do
		local placeSuffix = (#(project.placeIds or {}) > 0) and (" [" .. table.concat(project.placeIds, ", ") .. "]") or " [sem placeId]"
		local button = makeButton(state.ui.projectList, project.name .. placeSuffix, UDim2.new(1, -8, 0, 28), UDim2.new(0, 4, 0, 0), function()
			state.settingsProjectId = project.id
			renderProjectList()
		end)
		button.TextSize = 11
		button.TextWrapped = true
		if selectedId == project.id then
			setButtonStyle(button, "primary")
		else
			setButtonStyle(button, "secondary")
		end
	end

	local layout = state.ui.projectList:FindFirstChildOfClass("UIListLayout")
	if layout and state.ui.projectListCanvas then
		state.ui.projectListCanvas.CanvasSize = UDim2.new(0, 0, 0, layout.AbsoluteContentSize.Y + 8)
	end
end

local function openHomeView()
	showView("home")
end

local function openAdvancedView()
	showView("advanced")
end

local function openSettingsView()
	if state.ui.settingsHostBox then
		state.ui.settingsHostBox.Text = state.host
	end
	if state.ui.settingsPortBox then
		state.ui.settingsPortBox.Text = tostring(state.port)
	end
	state.settingsProjectId = state.selectedProjectId
	setTextIfPresent(
		state.ui.settingsProjectsHint,
		state.projectSelectionMessage or "Auto uses placeId/default. Choose a project when the place is not mapped."
	)
	local ok, response = fetchProjectsCatalog()
	if ok then
		local selectedProject = state.settingsProjectId and findProjectById(state.settingsProjectId) or nil
		renderProjectList()
	else
		state.availableProjects = {}
		renderProjectList()
		appendLog("Failed to load projects: " .. tostring(response))
		setTextIfPresent(state.ui.settingsProjectsHint, "Could not load projects from the daemon.")
	end
	updateEndpointSummary()
	updateProjectTargetSummary()
	showView("settings")
end

local function saveSettingsFromView()
	local nextHost = state.ui.settingsHostBox and state.ui.settingsHostBox.Text or state.host
	nextHost = string.gsub(nextHost, "^%s+", "")
	nextHost = string.gsub(nextHost, "%s+$", "")
	if nextHost == "" then
		nextHost = DEFAULT_HOST
	end

	local nextPort = normalizePort(state.ui.settingsPortBox and state.ui.settingsPortBox.Text or state.port)
	if not nextPort then
		updateStatus("invalid port")
		appendLog("Invalid port. Use a value between 1 and 65535.")
		return
	end

	local previousBaseUrl = baseUrl()
	local previousSessionId = state.sessionId
	local nextProjectId = state.settingsProjectId
	local selectedProject = nextProjectId and findProjectById(nextProjectId) or nil
	local nextProjectName = selectedProject and selectedProject.name or nil
	local endpointChanged = nextHost ~= state.host or nextPort ~= state.port
	local projectChanged = nextProjectId ~= state.selectedProjectId

	state.host = nextHost
	state.port = nextPort
	state.portCustomized = true
	state.selectedProjectId = nextProjectId
	state.selectedProjectName = nextProjectName
	hideConnectionPrompt()
	saveSettings()
	updateEndpointSummary()
	updateProjectTargetSummary()
	if endpointChanged then
		state.workspaceRoot = nil
		state.workspaceName = nil
		pcall(fetchDaemonHealth)
		updateProject(currentWorkspaceLabel())
	end

	if (endpointChanged or projectChanged) and previousSessionId then
		requestWithBase(previousBaseUrl, "POST", "/session/close", {
			sessionId = previousSessionId
		})
		resetSessionState(projectChanged and "project updated" or "settings updated")
		saveSettings()
		appendLog("Settings saved. Reconnect to use the updated project/endpoint.")
	else
		appendLog("Settings saved for " .. baseUrl())
	end

	openHomeView()
end

-- Keep UI construction in a short-lived scope so Luau releases these locals
-- before the watcher loop below. Studio errors once a script chunk exceeds 200.
do
local toolbar = plugin:CreateToolbar("Amarillo")
local toolbarButton = toolbar:CreateButton("Amarillo", "Open the Roblox <-> workspace bridge", "rbxasset://textures/DeveloperFramework/PluginLogo.png")
toolbarButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	true,
	true,
	460,
	640,
	360,
	480
)
widget = plugin:CreateDockWidgetPluginGui("AmarilloDock", widgetInfo)
widget.Title = "Amarillo Bridge"

local root = Instance.new("Frame")
root.BackgroundColor3 = Color3.fromRGB(16, 18, 23)
root.BorderSizePixel = 0
root.Size = UDim2.fromScale(1, 1)
root.Parent = widget

state.ui.homePage = Instance.new("Frame")
state.ui.homePage.BackgroundTransparency = 1
state.ui.homePage.Size = UDim2.fromScale(1, 1)
state.ui.homePage.Parent = root

state.ui.settingsPage = Instance.new("Frame")
state.ui.settingsPage.BackgroundTransparency = 1
state.ui.settingsPage.Size = UDim2.fromScale(1, 1)
state.ui.settingsPage.Visible = false
state.ui.settingsPage.Parent = root

state.ui.advancedPage = Instance.new("Frame")
state.ui.advancedPage.BackgroundTransparency = 1
state.ui.advancedPage.Size = UDim2.fromScale(1, 1)
state.ui.advancedPage.Visible = false
state.ui.advancedPage.Parent = root

do
local homeHero = makeCard(state.ui.homePage, UDim2.new(1, -20, 0, 160), UDim2.fromOffset(10, 12), Color3.fromRGB(20, 24, 31))
local homeTitle = makeTextLabel(homeHero, "Amarillo", UDim2.new(1, -120, 0, 28), UDim2.fromOffset(16, 14), 24)
homeTitle.Font = Enum.Font.GothamBold
local homeSubtitle = makeTextLabel(homeHero, "Bridge Studio <-> Workspace", UDim2.new(1, -120, 0, 18), UDim2.fromOffset(16, 46), 13)
homeSubtitle.TextColor3 = Color3.fromRGB(166, 172, 184)
state.ui.endpointLabel = makeTextLabel(homeHero, "", UDim2.new(1, -32, 0, 20), UDim2.fromOffset(16, 82), 16)
state.ui.endpointLabel.Font = Enum.Font.Code
local settingsButton = makeButton(homeHero, "Settings", UDim2.fromOffset(92, 30), UDim2.fromOffset(336, 16), openSettingsView)
setButtonStyle(settingsButton, "secondary")
local advancedButton = makeButton(homeHero, "Advanced", UDim2.fromOffset(92, 30), UDim2.fromOffset(336, 54), openAdvancedView)
setButtonStyle(advancedButton, "ghost")
state.ui.statusLabel = makeTextLabel(homeHero, "Status: disconnected", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 116), 14)

local homeSummary = makeCard(state.ui.homePage, UDim2.new(1, -20, 0, 104), UDim2.fromOffset(10, 182), Color3.fromRGB(24, 27, 33))
state.ui.projectLabel = makeTextLabel(homeSummary, "Workspace: -", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 16), 14)
state.ui.sessionLabel = makeTextLabel(homeSummary, "Session: -", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 40), 14)
state.ui.queueLabel = makeTextLabel(homeSummary, "Queue: -", UDim2.new(0.5, -20, 0, 18), UDim2.fromOffset(16, 66), 14)
state.ui.conflictLabel = makeTextLabel(homeSummary, "Conflicts: 0", UDim2.new(0.5, -20, 0, 18), UDim2.fromOffset(210, 66), 14)
state.ui.targetProjectLabel = makeTextLabel(homeSummary, "Target project: Auto", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 86), 13)
state.ui.targetProjectLabel.TextColor3 = Color3.fromRGB(166, 172, 184)

local homeActions = makeCard(state.ui.homePage, UDim2.new(1, -20, 0, 144), UDim2.fromOffset(10, 300), Color3.fromRGB(24, 27, 33))
local connectButton = makeButton(homeActions, "Connect", UDim2.fromOffset(136, 36), UDim2.fromOffset(16, 18), connectSession)
local disconnectButton = makeButton(homeActions, "Disconnect", UDim2.fromOffset(136, 36), UDim2.fromOffset(160, 18), disconnectSession)
setButtonStyle(disconnectButton, "secondary")
local sendButton = makeButton(homeActions, "Receive from PC", UDim2.fromOffset(200, 36), UDim2.fromOffset(16, 72), manualPull)
local receiveButton = makeButton(homeActions, "Send to PC", UDim2.fromOffset(200, 36), UDim2.fromOffset(224, 72), manualPush)
setButtonStyle(receiveButton, "secondary")
local homeHint = makeTextLabel(homeActions, "Use Advanced for tree, selection, playtest, and Luau.", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 118), 12)
homeHint.TextColor3 = Color3.fromRGB(152, 158, 168)
end

do
local settingsHeader = makeCard(state.ui.settingsPage, UDim2.new(1, -20, 0, 68), UDim2.fromOffset(10, 12), Color3.fromRGB(20, 24, 31))
local settingsBackButton = makeButton(settingsHeader, "Back", UDim2.fromOffset(76, 30), UDim2.fromOffset(16, 18), openHomeView)
setButtonStyle(settingsBackButton, "secondary")
local settingsTitle = makeTextLabel(settingsHeader, "Settings", UDim2.new(1, -120, 0, 28), UDim2.fromOffset(110, 18), 22)
settingsTitle.Font = Enum.Font.GothamBold

local settingsCard = makeCard(state.ui.settingsPage, UDim2.new(1, -20, 0, 438), UDim2.fromOffset(10, 96), Color3.fromRGB(24, 27, 33))
state.ui.settingsEndpointLabel = makeTextLabel(settingsCard, "Current: -", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 16), 14)
state.ui.settingsEndpointLabel.TextColor3 = Color3.fromRGB(170, 176, 188)
local settingsHostTitle = makeTextLabel(settingsCard, "Host", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 50), 14)
settingsHostTitle.Font = Enum.Font.GothamSemibold
state.ui.settingsHostBox = makeTextBox(settingsCard, "127.0.0.1", UDim2.new(1, -32, 0, 34), UDim2.fromOffset(16, 74), false)
state.ui.settingsHostBox.TextYAlignment = Enum.TextYAlignment.Center
local settingsPortTitle = makeTextLabel(settingsCard, "Port", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 120), 14)
settingsPortTitle.Font = Enum.Font.GothamSemibold
state.ui.settingsPortBox = makeTextBox(settingsCard, "8323", UDim2.new(1, -32, 0, 34), UDim2.fromOffset(16, 144), false)
state.ui.settingsPortBox.TextYAlignment = Enum.TextYAlignment.Center
state.ui.settingsProjectLabel = makeTextLabel(settingsCard, "Target project: Auto", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 192), 14)
state.ui.settingsProjectLabel.TextColor3 = Color3.fromRGB(170, 176, 188)
local settingsProjectsTitle = makeTextLabel(settingsCard, "Project for this place", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 220), 14)
settingsProjectsTitle.Font = Enum.Font.GothamSemibold
state.ui.settingsProjectsHint = makeTextLabel(settingsCard, "Auto uses placeId/default. Choose a project when the place is not mapped.", UDim2.new(1, -32, 0, 28), UDim2.fromOffset(16, 244), 12)
state.ui.settingsProjectsHint.TextColor3 = Color3.fromRGB(156, 162, 172)
state.ui.projectListCanvas = Instance.new("ScrollingFrame")
state.ui.projectListCanvas.BackgroundColor3 = Color3.fromRGB(18, 20, 25)
state.ui.projectListCanvas.BorderSizePixel = 0
state.ui.projectListCanvas.ScrollBarThickness = 6
state.ui.projectListCanvas.AutomaticCanvasSize = Enum.AutomaticSize.None
state.ui.projectListCanvas.Size = UDim2.new(1, -32, 0, 118)
state.ui.projectListCanvas.Position = UDim2.fromOffset(16, 278)
state.ui.projectListCanvas.CanvasSize = UDim2.new(0, 0, 0, 0)
state.ui.projectListCanvas.Parent = settingsCard
addCorner(state.ui.projectListCanvas)
state.ui.projectList = Instance.new("Frame")
state.ui.projectList.BackgroundTransparency = 1
state.ui.projectList.Size = UDim2.new(1, -6, 0, 0)
state.ui.projectList.Position = UDim2.fromOffset(0, 0)
state.ui.projectList.Parent = state.ui.projectListCanvas
local projectListPadding = Instance.new("UIPadding")
projectListPadding.PaddingTop = UDim.new(0, 4)
projectListPadding.PaddingBottom = UDim.new(0, 4)
projectListPadding.PaddingLeft = UDim.new(0, 0)
projectListPadding.PaddingRight = UDim.new(0, 0)
projectListPadding.Parent = state.ui.projectList
local projectListLayout = Instance.new("UIListLayout")
projectListLayout.Padding = UDim.new(0, 4)
projectListLayout.Parent = state.ui.projectList
projectListLayout:GetPropertyChangedSignal("AbsoluteContentSize"):Connect(function()
	state.ui.projectList.Size = UDim2.new(1, -6, 0, projectListLayout.AbsoluteContentSize.Y + 8)
	state.ui.projectListCanvas.CanvasSize = UDim2.new(0, 0, 0, projectListLayout.AbsoluteContentSize.Y + 8)
end)
local saveSettingsButton = makeButton(settingsCard, "Save", UDim2.fromOffset(120, 34), UDim2.fromOffset(16, 402), saveSettingsFromView)

-- Confirm destructive actions toggle
local confirmPropTitle = makeTextLabel(state.ui.settingsPage, "Destructive action confirmation", UDim2.new(1, -20, 0, 18), UDim2.fromOffset(10, 546), 14)
confirmPropTitle.Font = Enum.Font.GothamSemibold
local confirmPropHint = makeTextLabel(state.ui.settingsPage, "When enabled, the plugin asks for confirmation before modify_property, create_instance, delete_instance, or insert_model via MCP/API.", UDim2.new(1, -20, 0, 32), UDim2.fromOffset(10, 568), 12)
confirmPropHint.TextColor3 = Color3.fromRGB(156, 162, 172)

state.ui.confirmPropToggle = makeButton(state.ui.settingsPage, state.confirmDestructiveActions and "Enabled" or "Disabled", UDim2.fromOffset(120, 30), UDim2.fromOffset(10, 606), function()
	state.confirmDestructiveActions = not state.confirmDestructiveActions
	state.ui.confirmPropToggle.Text = state.confirmDestructiveActions and "Enabled" or "Disabled"
	if state.confirmDestructiveActions then
		setButtonStyle(state.ui.confirmPropToggle, "primary")
	else
		setButtonStyle(state.ui.confirmPropToggle, "secondary")
	end
	saveSettings()
	appendLog("Destructive action confirmation " .. (state.confirmDestructiveActions and "enabled" or "disabled") .. ".")
end)
if state.confirmDestructiveActions then
	setButtonStyle(state.ui.confirmPropToggle, "primary")
else
	setButtonStyle(state.ui.confirmPropToggle, "secondary")
end

local settingsHint = makeTextLabel(state.ui.settingsPage, "Changing the endpoint or project requires reconnecting the plugin to the daemon.", UDim2.new(1, -20, 0, 18), UDim2.fromOffset(10, 648), 12)
settingsHint.TextColor3 = Color3.fromRGB(156, 162, 172)
end

do
local advancedHeader = makeCard(state.ui.advancedPage, UDim2.new(1, -20, 0, 72), UDim2.fromOffset(10, 12), Color3.fromRGB(20, 24, 31))
local advancedBackButton = makeButton(advancedHeader, "Back", UDim2.fromOffset(76, 30), UDim2.fromOffset(16, 20), openHomeView)
setButtonStyle(advancedBackButton, "secondary")
local advancedSettingsButton = makeButton(advancedHeader, "Settings", UDim2.fromOffset(86, 30), UDim2.fromOffset(354, 20), openSettingsView)
setButtonStyle(advancedSettingsButton, "ghost")
local advancedTitle = makeTextLabel(advancedHeader, "Advanced", UDim2.new(1, -200, 0, 26), UDim2.fromOffset(112, 12), 22)
advancedTitle.Font = Enum.Font.GothamBold
local advancedSubtitle = makeTextLabel(advancedHeader, "Inspection and playtest tools", UDim2.new(1, -200, 0, 16), UDim2.fromOffset(112, 40), 12)
advancedSubtitle.TextColor3 = Color3.fromRGB(166, 172, 184)

local advancedSummary = makeCard(state.ui.advancedPage, UDim2.new(1, -20, 0, 110), UDim2.fromOffset(10, 94), Color3.fromRGB(24, 27, 33))
state.ui.advancedStatusLabel = makeTextLabel(advancedSummary, "Status: disconnected", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 14), 13)
state.ui.advancedProjectLabel = makeTextLabel(advancedSummary, "Workspace: -", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 36), 13)
state.ui.advancedSessionLabel = makeTextLabel(advancedSummary, "Session: -", UDim2.new(1, -32, 0, 18), UDim2.fromOffset(16, 58), 13)
state.ui.advancedQueueLabel = makeTextLabel(advancedSummary, "Queue: -", UDim2.new(0.5, -20, 0, 18), UDim2.fromOffset(16, 80), 13)
state.ui.advancedConflictLabel = makeTextLabel(advancedSummary, "Conflicts: 0", UDim2.new(0.5, -20, 0, 18), UDim2.fromOffset(210, 80), 13)

local advancedActions = makeCard(state.ui.advancedPage, UDim2.new(1, -20, 0, 86), UDim2.fromOffset(10, 214), Color3.fromRGB(24, 27, 33))
local previewTreeButton = makeButton(advancedActions, "Preview Tree", UDim2.fromOffset(100, 30), UDim2.fromOffset(16, 16), refreshTreePreview)
local selectionButton = makeButton(advancedActions, "Selection", UDim2.fromOffset(92, 30), UDim2.fromOffset(124, 16), manualSelection)
setButtonStyle(selectionButton, "secondary")
local playStartButton = makeButton(advancedActions, "Play Start", UDim2.fromOffset(92, 30), UDim2.fromOffset(224, 16), function()
	sendPlaytest("start")
end)
local playStopButton = makeButton(advancedActions, "Play Stop", UDim2.fromOffset(92, 30), UDim2.fromOffset(324, 16), function()
	sendPlaytest("stop")
end)
setButtonStyle(playStopButton, "secondary")
local advancedSendButton = makeButton(advancedActions, "Receive from PC", UDim2.fromOffset(150, 30), UDim2.fromOffset(16, 50), manualPull)
local advancedReceiveButton = makeButton(advancedActions, "Send to PC", UDim2.fromOffset(150, 30), UDim2.fromOffset(176, 50), manualPush)
setButtonStyle(advancedReceiveButton, "secondary")

state.ui.codeBox = makeTextBox(state.ui.advancedPage, "Paste Luau here to execute in Studio...", UDim2.new(1, -20, 0, 112), UDim2.fromOffset(10, 312), true)
local runCodeButton = makeButton(state.ui.advancedPage, "Run Luau", UDim2.fromOffset(132, 30), UDim2.fromOffset(10, 432), manualRunCode)
state.ui.treeBox = makeTextBox(state.ui.advancedPage, "Tree preview / selection / results...", UDim2.new(1, -20, 0, 86), UDim2.fromOffset(10, 472), true)
state.ui.treeBox.TextEditable = false
state.ui.logBox = makeTextBox(state.ui.advancedPage, "Plugin log...", UDim2.new(1, -20, 0, 62), UDim2.fromOffset(10, 566), true)
state.ui.logBox.TextEditable = false
end

do
state.ui.connectionPromptOverlay = Instance.new("Frame")
state.ui.connectionPromptOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.connectionPromptOverlay.BackgroundTransparency = 0.28
state.ui.connectionPromptOverlay.BorderSizePixel = 0
state.ui.connectionPromptOverlay.Size = UDim2.fromScale(1, 1)
state.ui.connectionPromptOverlay.Visible = false
state.ui.connectionPromptOverlay.ZIndex = 20
state.ui.connectionPromptOverlay.Parent = root

local connectionPromptCard = makeCard(state.ui.connectionPromptOverlay, UDim2.new(1, -48, 0, 220), UDim2.fromOffset(24, 170), Color3.fromRGB(24, 27, 33))
connectionPromptCard.ZIndex = 21
state.ui.connectionPromptTitle = makeTextLabel(connectionPromptCard, "New VS Code connection", UDim2.new(1, -32, 0, 28), UDim2.fromOffset(16, 16), 22)
state.ui.connectionPromptTitle.Font = Enum.Font.GothamBold
state.ui.connectionPromptTitle.ZIndex = 22
state.ui.connectionPromptBody = makeTextLabel(connectionPromptCard, "The plugin detected a connection request.", UDim2.new(1, -32, 0, 42), UDim2.fromOffset(16, 54), 14)
state.ui.connectionPromptBody.ZIndex = 22
state.ui.connectionPromptHint = makeTextLabel(connectionPromptCard, "Accept to choose the initial source of truth.", UDim2.new(1, -32, 0, 36), UDim2.fromOffset(16, 98), 12)
state.ui.connectionPromptHint.TextColor3 = Color3.fromRGB(166, 172, 184)
state.ui.connectionPromptHint.ZIndex = 22

state.ui.connectionPromptAccept = makeButton(connectionPromptCard, "Accept", UDim2.fromOffset(132, 36), UDim2.fromOffset(16, 164), confirmPendingConnection)
state.ui.connectionPromptAccept.ZIndex = 22
state.ui.connectionPromptDecline = makeButton(connectionPromptCard, "Decline", UDim2.fromOffset(132, 36), UDim2.fromOffset(160, 164), declinePendingConnection)
setButtonStyle(state.ui.connectionPromptDecline, "secondary")
state.ui.connectionPromptDecline.ZIndex = 22
state.ui.connectionPromptChoosePc = makeButton(connectionPromptCard, "Keep PC files", UDim2.fromOffset(180, 36), UDim2.fromOffset(16, 164), choosePcTruth)
state.ui.connectionPromptChoosePc.Visible = false
state.ui.connectionPromptChoosePc.ZIndex = 22
state.ui.connectionPromptChooseStudio = makeButton(connectionPromptCard, "Keep Roblox Studio", UDim2.fromOffset(180, 36), UDim2.fromOffset(208, 164), chooseStudioTruth)
setButtonStyle(state.ui.connectionPromptChooseStudio, "secondary")
state.ui.connectionPromptChooseStudio.Visible = false
state.ui.connectionPromptChooseStudio.ZIndex = 22
end

-- ===== Destructive Action Confirmation Overlay =====
do
state.ui.propertyConfirmOverlay = Instance.new("Frame")
state.ui.propertyConfirmOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.propertyConfirmOverlay.BackgroundTransparency = 0.28
state.ui.propertyConfirmOverlay.BorderSizePixel = 0
state.ui.propertyConfirmOverlay.Size = UDim2.fromScale(1, 1)
state.ui.propertyConfirmOverlay.Visible = false
state.ui.propertyConfirmOverlay.ZIndex = 30
state.ui.propertyConfirmOverlay.Parent = root

local propertyConfirmCard = makeCard(state.ui.propertyConfirmOverlay, UDim2.new(1, -48, 0, 250), UDim2.fromOffset(24, 150), Color3.fromRGB(24, 27, 33))
propertyConfirmCard.ZIndex = 31

state.ui.propertyConfirmTitle = makeTextLabel(propertyConfirmCard, "Confirm Destructive Action", UDim2.new(1, -32, 0, 28), UDim2.fromOffset(16, 16), 20)
state.ui.propertyConfirmTitle.Font = Enum.Font.GothamBold
state.ui.propertyConfirmTitle.ZIndex = 32

local propertyConfirmIcon = makeTextLabel(propertyConfirmCard, "⚠", UDim2.fromOffset(28, 28), UDim2.new(1, -44, 0, 14), 20)
propertyConfirmIcon.TextXAlignment = Enum.TextXAlignment.Right
propertyConfirmIcon.TextColor3 = Color3.fromRGB(214, 183, 120)
propertyConfirmIcon.ZIndex = 32

state.ui.propertyConfirmBody = makeTextLabel(propertyConfirmCard, "Target: ?", UDim2.new(1, -32, 0, 42), UDim2.fromOffset(16, 54), 14)
state.ui.propertyConfirmBody.ZIndex = 32
state.ui.propertyConfirmBody.TextColor3 = Color3.fromRGB(200, 205, 215)

state.ui.propertyConfirmDetail = makeTextLabel(propertyConfirmCard, "Details: ?", UDim2.new(1, -32, 0, 60), UDim2.fromOffset(16, 100), 13)
state.ui.propertyConfirmDetail.ZIndex = 32
state.ui.propertyConfirmDetail.TextColor3 = Color3.fromRGB(166, 172, 184)
state.ui.propertyConfirmDetail.Font = Enum.Font.Code

local propertyConfirmHint = makeTextLabel(propertyConfirmCard, "Accept to apply the action or decline to cancel.", UDim2.new(1, -32, 0, 20), UDim2.fromOffset(16, 168), 11)
propertyConfirmHint.TextColor3 = Color3.fromRGB(140, 146, 156)
propertyConfirmHint.ZIndex = 32

local propertyAcceptBtn = makeButton(propertyConfirmCard, "Accept", UDim2.fromOffset(132, 36), UDim2.fromOffset(16, 198), acceptDestructiveAction)
propertyAcceptBtn.ZIndex = 32
local propertyDeclineBtn = makeButton(propertyConfirmCard, "Decline", UDim2.fromOffset(132, 36), UDim2.fromOffset(160, 198), declineDestructiveAction)
setButtonStyle(propertyDeclineBtn, "secondary")
propertyDeclineBtn.ZIndex = 32
end

-- ===== Diff Confirmation Overlay =====
do
state.ui.diffOverlay = Instance.new("Frame")
state.ui.diffOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.diffOverlay.BackgroundTransparency = 0.28
state.ui.diffOverlay.BorderSizePixel = 0
state.ui.diffOverlay.Size = UDim2.fromScale(1, 1)
state.ui.diffOverlay.Visible = false
state.ui.diffOverlay.ZIndex = 40
state.ui.diffOverlay.Parent = root

local diffCard = makeCard(state.ui.diffOverlay, UDim2.new(1, -48, 0, 400), UDim2.fromOffset(24, 80), Color3.fromRGB(24, 27, 33))
diffCard.ZIndex = 41

local diffTitle = makeTextLabel(diffCard, "Review Changes", UDim2.new(1, -32, 0, 28), UDim2.fromOffset(16, 16), 20)
diffTitle.Font = Enum.Font.GothamBold
diffTitle.ZIndex = 42

local diffHint = makeTextLabel(diffCard, "The following changes will occur after connecting:", UDim2.new(1, -32, 0, 20), UDim2.fromOffset(16, 44), 12)
diffHint.TextColor3 = Color3.fromRGB(156, 162, 172)
diffHint.ZIndex = 42

state.ui.diffListCanvas = Instance.new("ScrollingFrame")
state.ui.diffListCanvas.BackgroundColor3 = Color3.fromRGB(18, 20, 25)
state.ui.diffListCanvas.BorderSizePixel = 0
state.ui.diffListCanvas.ScrollBarThickness = 6
state.ui.diffListCanvas.Size = UDim2.new(1, -32, 0, 260)
state.ui.diffListCanvas.Position = UDim2.fromOffset(16, 72)
state.ui.diffListCanvas.ZIndex = 42
state.ui.diffListCanvas.Parent = diffCard
addCorner(state.ui.diffListCanvas)

state.ui.diffList = Instance.new("Frame")
state.ui.diffList.BackgroundTransparency = 1
state.ui.diffList.Size = UDim2.new(1, -6, 0, 0)
state.ui.diffList.ZIndex = 42
state.ui.diffList.Parent = state.ui.diffListCanvas

local diffListPadding = Instance.new("UIPadding")
diffListPadding.PaddingTop = UDim.new(0, 4)
diffListPadding.PaddingBottom = UDim.new(0, 4)
diffListPadding.Parent = state.ui.diffList

local diffListLayout = Instance.new("UIListLayout")
diffListLayout.Padding = UDim.new(0, 4)
diffListLayout.Parent = state.ui.diffList

state.ui.diffConfirmBtn = makeButton(diffCard, "Confirm", UDim2.fromOffset(132, 36), UDim2.fromOffset(16, 348), function() end) -- Connected later
state.ui.diffConfirmBtn.ZIndex = 42

local diffCancelBtn = makeButton(diffCard, "Cancel", UDim2.fromOffset(132, 36), UDim2.fromOffset(160, 348), cancelDiff)
setButtonStyle(diffCancelBtn, "secondary")
diffCancelBtn.ZIndex = 42
end

toolbarButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

widget.Enabled = true
loadSettings()
updateEndpointSummary()
appendLog("Amarillo loaded. Host " .. state.host .. ":" .. tostring(state.port))
pcall(fetchDaemonHealth)
updateStatus("waiting for daemon")
updateProject(currentWorkspaceLabel())
updateSession("-")
updateQueue("-")
updateConflict("0")
openHomeView()
end

-- ===== Event-driven Watcher (OPT-008: DescendantAdded/Removing) =====
local watcherConnections = {}
local watcherDirty = false

disconnectWatcher = function()
	for _, conns in pairs(watcherConnections) do
		for _, conn in ipairs(conns) do
			conn:Disconnect()
		end
	end
	watcherConnections = {}
	watcherDirty = false
	state.pendingScriptPatches = {}
	state.openDocumentCache = {}
end

local watcherDirtyAt = 0

local function markDirty()
	if state.isApplyingRemote or state.awaitingInitialSync then
		return
	end
	watcherDirty = true
	watcherDirtyAt = now()
	state.lastActivityAt = now()
end

local function sendScriptPatch(path, source)
	if not state.sessionId or state.isApplyingRemote or state.awaitingInitialSync then
		return false
	end
	local pathLabel = type(path) == "table" and table.concat(path, ".") or tostring(path)
	local callOk, requestOk, response = pcall(function()
		return request("POST", "/studio/patch-source", addVersionPayload({
			sessionId = state.sessionId,
			path = path,
			source = source
		}))
	end)
	if not callOk then
		appendLog("Error sending patch: " .. tostring(requestOk))
		reportPluginError(requestOk, "PLUGIN-PATCH", { path = pathLabel }, "warning")
		return false
	end
	if not requestOk then
		appendLog("Error sending patch: " .. tostring(response))
		reportPluginError(response, "PLUGIN-PATCH", { path = pathLabel }, "warning")
		return false
	end
	if not response or response.ok ~= true then
		appendLog("Fast patch rejected; using the full snapshot." .. (response and response.error and (" " .. tostring(response.error)) or ""))
		reportPluginError((response and response.error) or "Fast patch rejected", "PLUGIN-PATCH", { path = pathLabel }, "warning")
		return false
	end
	return true
end

local function scheduleScriptPatch(pathSegments, source)
	local key = table.concat(pathSegments, "\0")
	local current = state.pendingScriptPatches[key]
	local version = current and current.version + 1 or 1
	state.pendingScriptPatches[key] = {
		pathSegments = pathSegments,
		source = source,
		version = version
	}

	task.delay(SCRIPT_PATCH_DEBOUNCE_SECONDS, function()
		local pending = state.pendingScriptPatches[key]
		if not pending or pending.version ~= version then
			return
		end
		state.pendingScriptPatches[key] = nil
		if not sendScriptPatch(pending.pathSegments, pending.source) then
			markDirty()
		end
	end)
end

-- OPT-008: Use DescendantAdded/DescendantRemoving on mount containers
-- instead of recursively connecting to every instance.
-- This reduces connections from O(N*4) to O(containers*3).
local function connectMountWatcher(container)
	local conns = {}

	-- Listen for any descendant added (covers all new children recursively)
	table.insert(conns, container.DescendantAdded:Connect(function(descendant)
		if descendant == workspace.CurrentCamera then
			return
		end
		markDirty()
	end))

	-- Listen for any descendant being removed
	table.insert(conns, container.DescendantRemoving:Connect(function(descendant)
		markDirty()
	end))

	-- Listen for direct property changes on the container itself
	table.insert(conns, container.Changed:Connect(function(property)
		markDirty()
	end))

	-- For existing descendants, we only need Changed on scripts (where Source matters)
	-- and general property changes. Use a single ChildAdded connection on each descendant's
	-- Changed signal for property tracking.
	for _, descendant in ipairs(container:GetDescendants()) do
		if descendant ~= workspace.CurrentCamera then
			local descConns = {}
			pcall(function()
				table.insert(descConns, descendant.Changed:Connect(function(property)
					markDirty()
				end))
			end)
			-- Also connect Changed for new descendants going forward
			table.insert(conns, container.DescendantAdded:Connect(function(newDesc)
				if newDesc ~= workspace.CurrentCamera then
					pcall(function()
						local newConns = {}
						table.insert(newConns, newDesc.Changed:Connect(function(prop)
							markDirty()
						end))
						watcherConnections[newDesc] = newConns
					end)
				end
			end))
			-- Clean up on removal
			table.insert(conns, container.DescendantRemoving:Connect(function(removedDesc)
				if watcherConnections[removedDesc] then
					for _, c in ipairs(watcherConnections[removedDesc]) do
						c:Disconnect()
					end
					watcherConnections[removedDesc] = nil
				end
			end))
			if #descConns > 0 then
				watcherConnections[descendant] = descConns
			end
		end
	end

	watcherConnections[container] = conns
end

startWatcher = function()
	disconnectWatcher()
	if not state.project then
		return
	end

	-- OPT-003: Populate open document cache on watcher start
	refreshOpenDocumentCache()

	for _, mount in ipairs(state.project.mounts or {}) do
		local container = resolveMountContainer(string.split(mount.path, "."))
		if container then
			connectMountWatcher(container)
		end
	end
	
	if okScriptEditor and ScriptEditorService then
		local conns = watcherConnections[ScriptEditorService] or {}
		pcall(function()
			table.insert(conns, ScriptEditorService.TextDocumentDidChange:Connect(function(doc, changes)
				if state.isApplyingRemote then
					return
				end
				local okScript, scriptInst = pcall(function() return doc:GetScript() end)
				if okScript and scriptInst then
					local text = ""
					pcall(function() text = doc:GetText() end)
					
					-- OPT-003: Update the open document cache in real-time
					state.openDocumentCache[scriptInst] = text

					local pathSegments = getInstancePathSegments(scriptInst)
					scheduleScriptPatch(pathSegments, text)
				else
					appendLog("TextDocumentDidChange: could not get the script from the document.")
				end
			end))
			table.insert(conns, ScriptEditorService.TextDocumentDidClose:Connect(function(doc)
				-- OPT-003: Remove closed document from cache
				pcall(function()
					local scriptInst = doc:GetScript()
					if scriptInst then
						state.openDocumentCache[scriptInst] = nil
					end
				end)
				markDirty()
			end))
		end)
		watcherConnections[ScriptEditorService] = conns
	else
		appendLog("ScriptEditorService unavailable!")
	end

	appendLog("Optimized watcher started (DescendantAdded/Removing).")
end

-- ===== Offer poll loop while disconnected =====
local consecutiveOfferFailures = 0
local currentOfferPollInterval = OFFER_IDLE_POLL_INTERVAL

task.spawn(function()
	while true do
		if not state.connected then
			local healthOk = pcall(fetchDaemonHealth)
			if healthOk then
				consecutiveOfferFailures = 0
				local reqOk, reqResponse = pollConnectionOffer()
				if reqOk then
					if reqResponse and reqResponse.offer and not state.pendingConnectionContext then
						updateStatus("waiting for confirmation")
						currentOfferPollInterval = OFFER_ACTIVE_POLL_INTERVAL
					else
						currentOfferPollInterval = OFFER_IDLE_POLL_INTERVAL
					end
					task.wait(currentOfferPollInterval)
				else
					currentOfferPollInterval = OFFER_RETRY_POLL_INTERVAL
					task.wait(currentOfferPollInterval)
				end
			else
				consecutiveOfferFailures = consecutiveOfferFailures + 1
				updateStatus("daemon offline")
				-- Back off gradually: 1s, 2s, 3s, max 5s
				task.wait(math.min(consecutiveOfferFailures, 5))
			end
		else
			task.wait(1)
		end
	end
end)

-- ===== Long-poll loop for receiving commands from daemon =====
local consecutivePollFailures = 0
local currentPollInterval = POLL_MIN_INTERVAL

task.spawn(function()
	while true do
		if state.connected and state.sessionId then
			local reqOk, reqResponse = request("GET", "/studio/poll?sessionId=" .. state.sessionId .. "&" .. pluginVersionQuery())
			if reqOk then
				consecutivePollFailures = 0
				applySyncSummary(reqResponse.session)
				if state.syncState ~= "degraded" then
					if state.awaitingInitialSync then
						updateStatus("syncing from PC")
					elseif state.awaitingInitialStudioSync then
						updateStatus("syncing from Studio")
					else
						updateStatus("connected")
					end
				end
				local commands = reqResponse.commands or {}
				updateQueue(tostring(#commands))

				if #commands > 0 then
					state.lastActivityAt = now()
					currentPollInterval = POLL_MIN_INTERVAL
				else
					local idleTime = now() - state.lastActivityAt
					if idleTime > POLL_IDLE_THRESHOLD_2 then
						currentPollInterval = POLL_MAX_INTERVAL
					elseif idleTime > POLL_IDLE_THRESHOLD_1 then
						currentPollInterval = 0.5
					else
						currentPollInterval = POLL_MIN_INTERVAL
					end
				end

				for _, command in ipairs(commands) do
					task.spawn(handleCommandSafely, command)
				end
				task.wait(currentPollInterval)
			else
				consecutivePollFailures = consecutivePollFailures + 1
				updateStatus("reconnecting (" .. consecutivePollFailures .. ")")
				appendLog("Connection lost, attempting to reconnect... (" .. consecutivePollFailures .. ")")

				-- After 15 consecutive failures (~30s), give up and disconnect
				if consecutivePollFailures >= 15 then
					appendLog("Too many failed reconnect attempts. Disconnecting.")
					pcall(disconnectWatcher)
					resetSessionState("disconnected (timeout)")
					consecutivePollFailures = 0
				else
					task.wait(2)
				end
			end
		else
			task.wait(currentPollInterval)
		end
	end
end)

-- ===== Initial Studio truth retry loop =====
task.spawn(function()
	while true do
		task.wait(0.5)

		if state.connected and state.sessionId and state.awaitingInitialStudioSync then
			attemptInitialStudioSync("retry", false)
		end
	end
end)

-- ===== Event-driven snapshot loop (Studio -> daemon) =====
task.spawn(function()
	while true do
		task.wait(0.15)

		if state.connected and state.sessionId and watcherDirty then
			if now() - watcherDirtyAt >= 0.5 then
				watcherDirty = false
				local snapOk, snapErr = pcall(function()
					syncSnapshot("auto")
				end)
				if not snapOk then
					appendLog("Auto snapshot sync failed: " .. tostring(snapErr))
				end
			end
		end
	end
end)
