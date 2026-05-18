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
		local okSource = safeSetProperty(instance, "Source", desiredSource, "script source update")
		sourceUpdated = okSource == true
	end
	return sourceUpdated
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

local function mountPathLabel(segments)
	if type(segments) ~= "table" or #segments == 0 then
		return "<empty>"
	end
	return table.concat(segments, ".")
end

local function resolveMountRoot(segment)
	local ok, service = pcall(function()
		return game:GetService(segment)
	end)
	if ok and service then
		return service, "service"
	end

	local child = game:FindFirstChild(segment)
	if child then
		return child, "child"
	end

	return nil, "missing"
end

local function validateMountContainerRecovery(segments)
	if type(segments) ~= "table" or #segments == 0 then
		return {
			ok = true,
			ignored = true,
			reason = "empty mount path"
		}
	end

	for index, segment in ipairs(segments) do
		if type(segment) ~= "string" or segment == "" then
			return {
				ok = false,
				reason = "invalid empty segment at index " .. tostring(index)
			}
		end
	end

	local root = resolveMountRoot(segments[1])
	if not root then
		return {
			ok = false,
			reason = "missing Roblox service/root '" .. tostring(segments[1]) .. "'"
		}
	end

	local current = root
	for index = 2, #segments do
		local child = current:FindFirstChild(segments[index])
		if child then
			current = child
		else
			if isProtectedSyncInstance(current) then
				return {
					ok = false,
					reason = "cannot recreate below protected instance " .. describeInstanceForLog(current)
				}
			end
			return {
				ok = true,
				needsRecovery = true,
				missingStartIndex = index
			}
		end
	end

	return {
		ok = true,
		needsRecovery = false
	}
end

local function ensureRecoverableMountContainer(segments)
	if type(segments) ~= "table" or #segments == 0 then
		appendLog("Mount integrity ignored: <empty> (empty mount path)")
		return nil, true, "ignored"
	end

	local current, rootKind = resolveMountRoot(segments[1])
	if not current then
		return nil, false, "missing Roblox service/root '" .. tostring(segments[1]) .. "'"
	end
	appendLog("Mount integrity found: " .. tostring(segments[1]) .. " (" .. tostring(rootKind) .. ")")

	local currentPath = tostring(segments[1])
	for index = 2, #segments do
		local segment = segments[index]
		local child = current:FindFirstChild(segment)
		currentPath = currentPath .. "." .. tostring(segment)
		if child then
			appendLog("Mount integrity found: " .. currentPath)
			current = child
		else
			if isProtectedSyncInstance(current) then
				return nil, false, "cannot recreate " .. currentPath .. " below protected instance " .. describeInstanceForLog(current)
			end

			local folder = Instance.new("Folder")
			local okName, nameErr = safeSetProperty(folder, "Name", segment, "mount recovery name")
			local okParent, parentErr = false, nil
			if okName then
				okParent, parentErr = safeSetParent(folder, current, "mount recovery parent")
			end
			if not okName or not okParent then
				destroyUnexpectedChild(folder, "failed mount recovery cleanup")
				return nil, false, "failed to recreate " .. currentPath .. ": " .. tostring(nameErr or parentErr)
			end

			appendLog("Mount integrity recreated: " .. currentPath .. " (Folder)")
			current = folder
		end
	end

	return current, true, nil
end

local function preflightProjectMounts(projectSnapshot)
	local checks = {}
	local blocked = {}

	for _, mount in ipairs(projectSnapshot.mounts or {}) do
		local segments = mount.segments or {}
		local pathLabel = mountPathLabel(segments)
		local check = validateMountContainerRecovery(segments)
		table.insert(checks, {
			mount = mount,
			segments = segments,
			pathLabel = pathLabel,
			check = check
		})

		if not check.ok then
			local detail = pathLabel .. " (" .. tostring(check.reason) .. ")"
			table.insert(blocked, detail)
			appendLog("Mount integrity blocked: " .. detail)
		elseif check.ignored then
			appendLog("Mount integrity ignored: " .. pathLabel .. " (" .. tostring(check.reason) .. ")")
		end
	end

	if #blocked > 0 then
		return false, "Sync blocked: unsafe or missing mount base(s): " .. table.concat(blocked, "; "), nil
	end

	local containers = {}
	for _, entry in ipairs(checks) do
		if not entry.check.ignored then
			local container, ok, err = ensureRecoverableMountContainer(entry.segments)
			if not ok then
				local detail = entry.pathLabel .. " (" .. tostring(err) .. ")"
				appendLog("Mount integrity blocked: " .. detail)
				return false, "Sync blocked: unsafe or missing mount base(s): " .. detail, nil
			end
			containers[entry.mount] = container
		end
	end

	return true, nil, containers
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
		local okAttributes, currentAttributes = pcall(function()
			return instance:GetAttributes()
		end)
		if not okAttributes then
			appendLog("setProperty failed (Attributes read): " .. tostring(currentAttributes))
			return false, tostring(currentAttributes)
		end
		local desiredAttributes = syncableAttributes(rawValue)
		local currentSyncableAttributes = syncableAttributes(currentAttributes)
		if valuesEqual(currentSyncableAttributes, desiredAttributes) then
			return true
		end
		for attributeName in pairs(currentAttributes) do
			if not isReservedAttributeName(attributeName) and desiredAttributes[attributeName] == nil then
				local okAttribute, attributeErr = safeSetAttribute(instance, attributeName, nil, "sync remove attribute")
				if not okAttribute then
					return false, tostring(attributeErr)
				end
			end
		end
		for attributeName, attributeValue in pairs(desiredAttributes) do
			if not valuesEqual(currentAttributes[attributeName], attributeValue) then
				local okAttribute, attributeErr = safeSetAttribute(instance, attributeName, attributeValue, "sync set attribute")
				if not okAttribute then
					return false, tostring(attributeErr)
				end
			end
		end
		return true
	end

	local currentValue = safeGetProperty(instance, propertyName)
	local currentSerialized = serializeValue(currentValue)
	if currentSerialized ~= nil and valuesEqual(currentSerialized, rawValue) then
		return true
	end
	local converted = convertIncomingValue(currentValue, rawValue)
	if currentValue == converted then
		return true
	end
	local ok, err = safeSetProperty(instance, propertyName, converted, "sync property")
	return ok, err
end

local function applyProperties(instance, properties)
	for propertyName, value in pairs(properties or {}) do
		local ok, err = setProperty(instance, propertyName, value)
		if not ok then
			return false, err
		end
	end
	return true
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
		local okNew, newInstance = pcall(function()
			return Instance.new(desiredNode.className)
		end)
		if not okNew then
			appendLog("Failed to create during sync: " .. tostring(desiredNode.className) .. " " .. tostring(desiredNode.name) .. " -> " .. tostring(newInstance))
			return nil, true
		end
		existing = newInstance
		local okName = safeSetProperty(existing, "Name", desiredNode.name, "sync create name")
		local okParent = okName and safeSetParent(existing, parent, "sync create parent")
		if not okName or not okParent then
			destroyUnexpectedChild(existing, "failed sync create cleanup")
			return nil, true
		end
	end

	if existing.Name ~= desiredNode.name then
		local okRename, renameErr = safeSetProperty(existing, "Name", desiredNode.name, "sync rename")
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
	local okProperties = applyProperties(instance, desiredNode.properties)
	if not okProperties then
		corrected = true
	end

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

local function applyProjectSnapshot(projectSnapshot, command)
	if not projectSnapshot then
		return false, "Snapshot vazio"
	end

	state.isApplyingRemote = true
	state.suppressPushUntil = now() + REMOTE_PUSH_SUPPRESSION_SECONDS
	local correctedDuringApply = false
	local appliedSnapshot = nil
	local safeSetCycle = beginSafeSetFailureAggregation(command)

	local okApply, applyError = xpcall(function()
		ChangeHistoryService:SetWaypoint("Amarillo Sync Start")
		local preflightOk, preflightError, mountContainers = preflightProjectMounts(projectSnapshot)
		if not preflightOk then
			error(preflightError)
		end

		local openDocumentSources = collectOpenDocumentSources()

		for _, mount in ipairs(projectSnapshot.mounts or {}) do
			local container = mountContainers[mount]
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
			end
		end

		ChangeHistoryService:SetWaypoint("Amarillo Sync End")
		
		appliedSnapshot = snapshotCurrentProject()
		if correctedDuringApply then
			appendLog("Studio classes preserved; sending corrected snapshot to daemon.")
		end

		state.treeCache = normalizeProjectSnapshotForCache(appliedSnapshot or projectSnapshot)
		state.lastSnapshotBodyJson = nil
	end, function(err)
		return tostring(err)
	end)

	state.isApplyingRemote = false
	finishSafeSetFailureAggregation(safeSetCycle)
	if not okApply then
		appendLog("Apply project snapshot failed: " .. tostring(applyError))
		return false, tostring(applyError)
	end

	return true, "Snapshot aplicado", appliedSnapshot, correctedDuringApply
end
