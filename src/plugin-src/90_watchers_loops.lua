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
