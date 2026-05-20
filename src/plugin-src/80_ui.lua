local function initializeUiModule()
state.uiActions = state.uiActions or {}

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
	showPluginWidget()
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
		placeName = currentPlaceName(),
		projectId = state.selectedProjectId,
		truthSource = truthSource,
		pluginVersion = PLUGIN_VERSION,
		pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION,
		privilegedActionConfirmationEnabled = state.confirmPrivilegedActions == true
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
		placeName = currentPlaceName(),
		projectId = state.selectedProjectId,
		truthSource = truthSource,
		studioSnapshot = studioSnapshot
	})

	if ok and response and response.changes then
		showDiffOverlay(truthSource, response.changes)
	elseif type(response) == "string" and string.find(response, "PLACE_SETUP_REQUIRED", 1, true) then
		updateStatus("place setup required")
		appendLog("Create the place project in the VS Code sidebar before syncing this place.")
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

state.uiActions.pollConnectionOffer = function()
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
	safeSetParent(label, parent, "UI TextLabel parent")
	return label
end

local function addCorner(instance, radius)
	local corner = Instance.new("UICorner")
	corner.CornerRadius = radius or UDim.new(0, 8)
	safeSetParent(corner, instance, "UI corner parent")
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
	safeSetParent(button, parent, "UI button parent")
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
	safeSetParent(box, parent, "UI text box parent")
	addCorner(box)
	return box
end

local function makeCard(parent, size, position, color)
	local card = Instance.new("Frame")
	card.BackgroundColor3 = color or Color3.fromRGB(24, 27, 33)
	card.BorderSizePixel = 0
	card.Size = size
	card.Position = position
	safeSetParent(card, parent, "UI card parent")
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

updatePrivilegedActionConfirmationUi = function()
	local label = state.confirmPrivilegedActions and "Enabled" or "Disabled"
	for _, button in ipairs({ state.ui.homeConfirmPropToggle, state.ui.confirmPropToggle }) do
		if button then
			button.Text = label
			setButtonStyle(button, state.confirmPrivilegedActions and "primary" or "secondary")
		end
	end
end

setPrivilegedActionConfirmation = function(enabled, source)
	state.confirmPrivilegedActions = enabled == true
	updatePrivilegedActionConfirmationUi()
	saveSettings()
	if source then
		appendLog("Privileged action confirmation " .. (state.confirmPrivilegedActions and "enabled" or "disabled") .. " by " .. tostring(source) .. ".")
	else
		appendLog("Privileged action confirmation " .. (state.confirmPrivilegedActions and "enabled" or "disabled") .. ".")
	end
end

local function togglePrivilegedActionConfirmation()
	setPrivilegedActionConfirmation(not state.confirmPrivilegedActions, "Studio")
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

local toolbarButton = nil

local function buildPluginShell()
	local toolbar = plugin:CreateToolbar("Amarillo")
	toolbarButton = toolbar:CreateButton("Amarillo", "Open the Roblox <-> workspace bridge", "")
	toolbarButton.ClickableWhenViewportHidden = true

	local widgetInfo = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Right,
		false,
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
	safeSetParent(root, widget, "UI root parent")

	state.ui.homePage = Instance.new("Frame")
	state.ui.homePage.BackgroundTransparency = 1
	state.ui.homePage.Size = UDim2.fromScale(1, 1)
	safeSetParent(state.ui.homePage, root, "UI home page parent")

	state.ui.settingsPage = Instance.new("Frame")
	state.ui.settingsPage.BackgroundTransparency = 1
	state.ui.settingsPage.Size = UDim2.fromScale(1, 1)
	state.ui.settingsPage.Visible = false
	safeSetParent(state.ui.settingsPage, root, "UI settings page parent")

	state.ui.advancedPage = Instance.new("Frame")
	state.ui.advancedPage.BackgroundTransparency = 1
	state.ui.advancedPage.Size = UDim2.fromScale(1, 1)
	state.ui.advancedPage.Visible = false
	safeSetParent(state.ui.advancedPage, root, "UI advanced page parent")

	return root
end

local function buildHomePage()
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

local homeSafety = makeCard(state.ui.homePage, UDim2.new(1, -20, 0, 74), UDim2.fromOffset(10, 456), Color3.fromRGB(24, 27, 33))
local homeConfirmTitle = makeTextLabel(homeSafety, "Privileged action confirmation", UDim2.new(1, -170, 0, 18), UDim2.fromOffset(16, 12), 14)
homeConfirmTitle.Font = Enum.Font.GothamSemibold
local homeConfirmHint = makeTextLabel(homeSafety, "Prompts before run_code and destructive API actions.", UDim2.new(1, -170, 0, 32), UDim2.fromOffset(16, 36), 12)
homeConfirmHint.TextColor3 = Color3.fromRGB(152, 158, 168)
state.ui.homeConfirmPropToggle = makeButton(homeSafety, state.confirmPrivilegedActions and "Enabled" or "Disabled", UDim2.fromOffset(132, 32), UDim2.new(1, -148, 0, 20), togglePrivilegedActionConfirmation)
end

local function buildSettingsPage()
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
safeSetParent(state.ui.projectListCanvas, settingsCard, "UI project list canvas parent")
addCorner(state.ui.projectListCanvas)
state.ui.projectList = Instance.new("Frame")
state.ui.projectList.BackgroundTransparency = 1
state.ui.projectList.Size = UDim2.new(1, -6, 0, 0)
state.ui.projectList.Position = UDim2.fromOffset(0, 0)
safeSetParent(state.ui.projectList, state.ui.projectListCanvas, "UI project list parent")
local projectListPadding = Instance.new("UIPadding")
projectListPadding.PaddingTop = UDim.new(0, 4)
projectListPadding.PaddingBottom = UDim.new(0, 4)
projectListPadding.PaddingLeft = UDim.new(0, 0)
projectListPadding.PaddingRight = UDim.new(0, 0)
safeSetParent(projectListPadding, state.ui.projectList, "UI project list padding parent")
local projectListLayout = Instance.new("UIListLayout")
projectListLayout.Padding = UDim.new(0, 4)
safeSetParent(projectListLayout, state.ui.projectList, "UI project list layout parent")
projectListLayout:GetPropertyChangedSignal("AbsoluteContentSize"):Connect(function()
	state.ui.projectList.Size = UDim2.new(1, -6, 0, projectListLayout.AbsoluteContentSize.Y + 8)
	state.ui.projectListCanvas.CanvasSize = UDim2.new(0, 0, 0, projectListLayout.AbsoluteContentSize.Y + 8)
end)
local saveSettingsButton = makeButton(settingsCard, "Save", UDim2.fromOffset(120, 34), UDim2.fromOffset(16, 402), saveSettingsFromView)

-- Confirm privileged actions toggle
local confirmPropTitle = makeTextLabel(state.ui.settingsPage, "Privileged action confirmation", UDim2.new(1, -20, 0, 18), UDim2.fromOffset(10, 546), 14)
confirmPropTitle.Font = Enum.Font.GothamSemibold
local confirmPropHint = makeTextLabel(state.ui.settingsPage, "When enabled, the plugin asks for confirmation before run_code, modify_property, create_instance, delete_instance, or insert_model via MCP/API.", UDim2.new(1, -20, 0, 32), UDim2.fromOffset(10, 568), 12)
confirmPropHint.TextColor3 = Color3.fromRGB(156, 162, 172)

state.ui.confirmPropToggle = makeButton(state.ui.settingsPage, state.confirmPrivilegedActions and "Enabled" or "Disabled", UDim2.fromOffset(120, 30), UDim2.fromOffset(10, 606), togglePrivilegedActionConfirmation)

local settingsHint = makeTextLabel(state.ui.settingsPage, "Changing the endpoint or project requires reconnecting the plugin to the daemon.", UDim2.new(1, -20, 0, 18), UDim2.fromOffset(10, 648), 12)
settingsHint.TextColor3 = Color3.fromRGB(156, 162, 172)
end

local function buildAdvancedPage()
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

local function buildConnectionPromptOverlay(root)
state.ui.connectionPromptOverlay = Instance.new("Frame")
state.ui.connectionPromptOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.connectionPromptOverlay.BackgroundTransparency = 0.28
state.ui.connectionPromptOverlay.BorderSizePixel = 0
state.ui.connectionPromptOverlay.Size = UDim2.fromScale(1, 1)
state.ui.connectionPromptOverlay.Visible = false
state.ui.connectionPromptOverlay.ZIndex = 20
safeSetParent(state.ui.connectionPromptOverlay, root, "UI connection prompt parent")

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

-- ===== Privileged Action Confirmation Overlay =====
local function buildPrivilegedActionConfirmationOverlay(root)
state.ui.propertyConfirmOverlay = Instance.new("Frame")
state.ui.propertyConfirmOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.propertyConfirmOverlay.BackgroundTransparency = 0.28
state.ui.propertyConfirmOverlay.BorderSizePixel = 0
state.ui.propertyConfirmOverlay.Size = UDim2.fromScale(1, 1)
state.ui.propertyConfirmOverlay.Visible = false
state.ui.propertyConfirmOverlay.ZIndex = 30
safeSetParent(state.ui.propertyConfirmOverlay, root, "UI property confirm parent")

local propertyConfirmCard = makeCard(state.ui.propertyConfirmOverlay, UDim2.new(1, -48, 0, 250), UDim2.fromOffset(24, 150), Color3.fromRGB(24, 27, 33))
propertyConfirmCard.ZIndex = 31

state.ui.propertyConfirmTitle = makeTextLabel(propertyConfirmCard, "Confirm Privileged Action", UDim2.new(1, -32, 0, 28), UDim2.fromOffset(16, 16), 20)
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
local function buildDiffOverlay(root)
state.ui.diffOverlay = Instance.new("Frame")
state.ui.diffOverlay.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
state.ui.diffOverlay.BackgroundTransparency = 0.28
state.ui.diffOverlay.BorderSizePixel = 0
state.ui.diffOverlay.Size = UDim2.fromScale(1, 1)
state.ui.diffOverlay.Visible = false
state.ui.diffOverlay.ZIndex = 40
safeSetParent(state.ui.diffOverlay, root, "UI diff overlay parent")

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
safeSetParent(state.ui.diffListCanvas, diffCard, "UI diff list canvas parent")
addCorner(state.ui.diffListCanvas)

state.ui.diffList = Instance.new("Frame")
state.ui.diffList.BackgroundTransparency = 1
state.ui.diffList.Size = UDim2.new(1, -6, 0, 0)
state.ui.diffList.ZIndex = 42
safeSetParent(state.ui.diffList, state.ui.diffListCanvas, "UI diff list parent")

local diffListPadding = Instance.new("UIPadding")
diffListPadding.PaddingTop = UDim.new(0, 4)
diffListPadding.PaddingBottom = UDim.new(0, 4)
safeSetParent(diffListPadding, state.ui.diffList, "UI diff list padding parent")

local diffListLayout = Instance.new("UIListLayout")
diffListLayout.Padding = UDim.new(0, 4)
safeSetParent(diffListLayout, state.ui.diffList, "UI diff list layout parent")

state.ui.diffConfirmBtn = makeButton(diffCard, "Confirm", UDim2.fromOffset(132, 36), UDim2.fromOffset(16, 348), function() end) -- Connected later
state.ui.diffConfirmBtn.ZIndex = 42

local diffCancelBtn = makeButton(diffCard, "Cancel", UDim2.fromOffset(132, 36), UDim2.fromOffset(160, 348), cancelDiff)
setButtonStyle(diffCancelBtn, "secondary")
diffCancelBtn.ZIndex = 42
end

local function startWidgetAutoHide()
	task.spawn(function()
		while true do
			task.wait(0.25)
			if isExperienceRunning() and widget and widget.Enabled then
				hidePluginWidget()
			end
		end
	end)
end

local function createPluginUi()
	local root = buildPluginShell()
	buildHomePage()
	buildSettingsPage()
	buildAdvancedPage()
	buildConnectionPromptOverlay(root)
	buildPrivilegedActionConfirmationOverlay(root)
	buildDiffOverlay(root)

	toolbarButton.Click:Connect(function()
		togglePluginWidget()
	end)

	hidePluginWidget()
	startWidgetAutoHide()
	loadSettings()
	updatePrivilegedActionConfirmationUi()
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

createPluginUi()
end

initializeUiModule()
