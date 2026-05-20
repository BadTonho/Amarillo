-- ===== Event-driven Watcher (OPT-008: DescendantAdded/Removing) =====
state.watchers = state.watchers or {}
state.watcherConnections = state.watcherConnections or {}
state.watcherDirty = false
state.watcherDirtyAt = 0
state.watchers.consecutiveOfferFailures = 0
state.watchers.currentOfferPollInterval = OFFER_IDLE_POLL_INTERVAL
state.watchers.consecutivePollFailures = 0
state.watchers.currentPollInterval = POLL_MIN_INTERVAL

disconnectWatcher = function()
	for _, conns in pairs(state.watcherConnections) do
		for _, conn in ipairs(conns) do
			pcall(function() conn:Disconnect() end)
		end
	end
	state.watcherConnections = {}
	state.watcherDirty = false
	state.watcherDirtyAt = 0
	state.pendingScriptPatches = {}
	state.openDocumentCache = {}
end

state.watchers.markDirty = function()
	if state.isApplyingRemote or state.awaitingInitialSync then
		return
	end
	state.watcherDirty = true
	state.watcherDirtyAt = now()
	state.lastActivityAt = now()
end

state.watchers.sendScriptPatch = function(path, source)
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

state.watchers.scheduleScriptPatch = function(pathSegments, source)
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
		if not state.watchers.sendScriptPatch(pending.pathSegments, pending.source) then
			state.watchers.markDirty()
		end
	end)
end

state.watchers.connectToPropertyChanges = function(instance)
	if instance == workspace.CurrentCamera then
		return
	end
	pcall(function()
		if not state.watcherConnections[instance] then
			state.watcherConnections[instance] = {}
		end
		table.insert(state.watcherConnections[instance], instance.Changed:Connect(function()
			state.watchers.markDirty()
		end))
	end)
end

state.watchers.disconnectFromInstance = function(instance)
	if state.watcherConnections[instance] then
		for _, conn in ipairs(state.watcherConnections[instance]) do
			pcall(function() conn:Disconnect() end)
		end
		state.watcherConnections[instance] = nil
	end
end

state.watchers.connectDescendants = function(container)
	for _, descendant in ipairs(container:GetDescendants()) do
		state.watchers.connectToPropertyChanges(descendant)
	end
end

-- OPT-008: Use DescendantAdded/DescendantRemoving on mount containers
-- instead of recursively connecting to every instance.
-- FIXED: No longer duplicate listeners inside loop - connect once at container level
state.watchers.connectMountWatcher = function(container)
	local conns = {}

	-- Listen for any descendant added (covers all new children recursively)
	table.insert(conns, container.DescendantAdded:Connect(function(descendant)
		state.watchers.connectToPropertyChanges(descendant)
		state.watchers.markDirty()
	end))

	-- Listen for any descendant being removed
	table.insert(conns, container.DescendantRemoving:Connect(function(descendant)
		state.watchers.disconnectFromInstance(descendant)
		state.watchers.markDirty()
	end))

	-- Listen for direct property changes on the container itself
	table.insert(conns, container.Changed:Connect(function()
		state.watchers.markDirty()
	end))

	-- For EXISTING descendants, connect their Changed events (only once, outside the DescendantAdded loop)
	state.watchers.connectDescendants(container)

	state.watcherConnections[container] = conns
end

state.watchers.connectScriptEditorWatcher = function()
	local conns = state.watcherConnections[ScriptEditorService] or {}
	if not state.watcherConnections[ScriptEditorService] then
		state.watcherConnections[ScriptEditorService] = conns
	end

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
				state.watchers.scheduleScriptPatch(pathSegments, text)
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
			state.watchers.markDirty()
		end))
	end)
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
			state.watchers.connectMountWatcher(container)
		end
	end

	if okScriptEditor and ScriptEditorService then
		state.watchers.connectScriptEditorWatcher()
	else
		appendLog("ScriptEditorService unavailable!")
	end

	appendLog("Optimized watcher started (DescendantAdded/Removing).")
end

-- ===== Offer poll loop while disconnected =====
task.spawn(function()
	while true do
		if not state.connected then
			local healthOk = pcall(fetchDaemonHealth)
			if healthOk then
				state.watchers.consecutiveOfferFailures = 0
				local reqOk, reqResponse = state.uiActions.pollConnectionOffer()
				if reqOk then
					if reqResponse and reqResponse.offer and not state.pendingConnectionContext then
						updateStatus("waiting for confirmation")
						state.watchers.currentOfferPollInterval = OFFER_ACTIVE_POLL_INTERVAL
					else
						state.watchers.currentOfferPollInterval = OFFER_IDLE_POLL_INTERVAL
					end
					task.wait(state.watchers.currentOfferPollInterval)
				else
					state.watchers.currentOfferPollInterval = OFFER_RETRY_POLL_INTERVAL
					task.wait(state.watchers.currentOfferPollInterval)
				end
			else
				state.watchers.consecutiveOfferFailures = state.watchers.consecutiveOfferFailures + 1
				updateStatus("daemon offline")
				-- Back off gradually: 1s, 2s, 3s, max 5s
				task.wait(math.min(state.watchers.consecutiveOfferFailures, 5))
			end
		else
			task.wait(1)
		end
	end
end)

state.watchers.isSyncApplyCommand = function(command)
	return command
		and (command.type == "apply_project_tree" or command.type == "apply_file_patch")
end

-- ===== Long-poll loop for receiving commands from daemon =====
task.spawn(function()
	while true do
		if state.connected and state.sessionId then
			local reqOk, reqResponse = request("GET", "/studio/poll?sessionId=" .. state.sessionId .. "&" .. pluginVersionQuery())
			if reqOk then
				state.watchers.consecutivePollFailures = 0
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
					state.watchers.currentPollInterval = POLL_MIN_INTERVAL
				else
					local idleTime = now() - state.lastActivityAt
					if idleTime > POLL_IDLE_THRESHOLD_2 then
						state.watchers.currentPollInterval = POLL_MAX_INTERVAL
					elseif idleTime > POLL_IDLE_THRESHOLD_1 then
						state.watchers.currentPollInterval = 0.5
					else
						state.watchers.currentPollInterval = POLL_MIN_INTERVAL
					end
				end

				for _, command in ipairs(commands) do
					if state.watchers.isSyncApplyCommand(command) then
						handleCommandSafely(command)
					else
						task.spawn(handleCommandSafely, command)
					end
				end
				task.wait(state.watchers.currentPollInterval)
			else
				state.watchers.consecutivePollFailures = state.watchers.consecutivePollFailures + 1
				updateStatus("reconnecting (" .. state.watchers.consecutivePollFailures .. ")")
				appendLog("Connection lost, attempting to reconnect... (" .. state.watchers.consecutivePollFailures .. ")")

				-- After 15 consecutive failures (~30s), give up and disconnect
				if state.watchers.consecutivePollFailures >= 15 then
					appendLog("Too many failed reconnect attempts. Disconnecting.")
					pcall(disconnectWatcher)
					resetSessionState("disconnected (timeout)")
					state.watchers.consecutivePollFailures = 0
				else
					task.wait(2)
				end
			end
		else
			task.wait(state.watchers.currentPollInterval)
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

		if state.connected and state.sessionId and state.watcherDirty then
			if now() - state.watcherDirtyAt >= 0.5 then
				state.watcherDirty = false
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
