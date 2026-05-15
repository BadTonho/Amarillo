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
	if bodyJson == state.lastSnapshotBodyJson and reason ~= "manual" and reason ~= "initial_accept" then
		return
	end

	state.lastSnapshotBodyJson = bodyJson
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
	state.pendingDestructiveSinceAt = nil
	state.lastSnapshotBodyJson = nil
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
