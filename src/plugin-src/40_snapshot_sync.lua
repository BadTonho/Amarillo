local function collectOpenDocumentSources()
	return state.openDocumentCache
end

-- Full refresh (used on watcher start / reconnect only)
local function refreshOpenDocumentCache()
	local sources = {}
	if okScriptEditor and ScriptEditorService then
		local okEditor, openDocs = pcall(function()
			return ScriptEditorService:GetScriptDocuments()
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
	if okScriptEditor and ScriptEditorService then
		local okEditorSource, editorSource = pcall(function()
			return ScriptEditorService:GetEditorSource(instance)
		end)
		if okEditorSource and editorSource ~= nil then
			return editorSource
		end
	end
	local ok, source = pcall(function()
		return instance.Source
	end)
	if ok then
		return source
	end
	return nil
end

local function updateScriptSourceIfChanged(instance, desiredSource, openDocumentSources, force)
	desiredSource = desiredSource or ""
	local currentSource = readScriptSource(instance, openDocumentSources)
	if not force and currentSource == desiredSource then
		return false, true, nil
	end

	local sourceUpdated = false
	local updateErr = nil
	if okScriptEditor and ScriptEditorService then
		local okUpdate, result = pcall(function()
			return ScriptEditorService:UpdateSourceAsync(instance, function()
				return desiredSource
			end)
		end)
		if okUpdate and result ~= false then
			sourceUpdated = true
		elseif not okUpdate then
			updateErr = result
		end
	end

	if not sourceUpdated then
		local okSource, sourceErr = safeSetProperty(instance, "Source", desiredSource, "script source update")
		sourceUpdated = okSource == true
		if not okSource then
			updateErr = sourceErr
		end
	end
	if sourceUpdated then
		return true, true, nil
	end
	return false, false, updateErr or "source update failed"
end

local function indexDesiredChildren(children)
	local indexed = { _byId = {} }
	for _, child in ipairs(children or {}) do
		local childName = child.name or child.robloxName or ""
		local bucket = indexed[childName]
		if bucket then
			table.insert(bucket, child)
		else
			indexed[childName] = { child }
		end
		if type(child.amarilloId) == "string" and child.amarilloId ~= "" then
			indexed._byId[child.amarilloId] = child
		end
	end
	return indexed
end

local function desiredNodeName(desiredNode)
	return desiredNode and (desiredNode.name or desiredNode.robloxName) or nil
end

local function getAmarilloId(instance)
	if not instance then
		return nil
	end
	local ok, value = pcall(function()
		return instance:GetAttribute("AmarilloId")
	end)
	if ok and type(value) == "string" and value ~= "" then
		return value
	end
	return nil
end

local function setAmarilloId(instance, amarilloId, contextLabel)
	if not instance or type(amarilloId) ~= "string" or amarilloId == "" then
		return false
	end
	if getAmarilloId(instance) == amarilloId then
		return true
	end
	local ok = safeSetAttribute(instance, "AmarilloId", amarilloId, contextLabel or "amarillo identity")
	return ok == true
end

local function ensureAmarilloId(instance)
	local existing = getAmarilloId(instance)
	if existing then
		return existing
	end
	local generated = HttpService:GenerateGUID(false)
	if setAmarilloId(instance, generated, "snapshot duplicate identity") then
		return generated
	end
	return nil
end

local function reserveSnapshotAmarilloId(instance, options)
	local amarilloId = getAmarilloId(instance)
	if not amarilloId then
		return nil
	end
	if type(options) ~= "table" then
		return amarilloId
	end

	options.seenAmarilloIds = options.seenAmarilloIds or {}
	local seenInstance = options.seenAmarilloIds[amarilloId]
	if not seenInstance or seenInstance == instance then
		options.seenAmarilloIds[amarilloId] = instance
		return amarilloId
	end

	for _ = 1, 8 do
		local generated = HttpService:GenerateGUID(false)
		if generated ~= amarilloId and not options.seenAmarilloIds[generated] then
			if setAmarilloId(instance, generated, "snapshot duplicate identity") then
				options.seenAmarilloIds[generated] = instance
				options.duplicateAmarilloIdsCorrected = true
				appendLog("Regenerated duplicated AmarilloId during snapshot for " .. tostring(instance.Name))
				return generated
			end
		end
	end

	options.duplicateAmarilloIdsCorrected = true
	appendLog("Failed to regenerate duplicated AmarilloId during snapshot for " .. tostring(instance.Name))
	return amarilloId
end

local function childNameCounts(parent)
	local counts = {}
	for _, child in ipairs(parent:GetChildren()) do
		counts[child.Name] = (counts[child.Name] or 0) + 1
	end
	return counts
end

local function mountKeyFromSegments(segments)
	return table.concat(segments or {}, "\0")
end

local function buildNestedMountChildIndex(mounts)
	local indexed = {}
	for _, mount in ipairs(mounts or {}) do
		local segments = mount.segments
		if (not segments or #segments == 0) and type(mount.path) == "string" then
			segments = string.split(mount.path, ".")
		end
		if type(segments) == "table" then
			local parentSegments = {}
			for index = 1, #segments - 1 do
				table.insert(parentSegments, segments[index])
				local key = mountKeyFromSegments(parentSegments)
				if not indexed[key] then
					indexed[key] = {}
				end
				indexed[key][segments[index + 1]] = true
			end
		end
	end
	return indexed
end

local function isNestedMountChild(indexed, parentSegments, childName)
	local bucket = indexed and indexed[mountKeyFromSegments(parentSegments)]
	return bucket and bucket[childName] == true
end

local function duplicateMountRootIssueForSnapshot(projectSnapshot)
	for _, mount in ipairs(projectSnapshot and projectSnapshot.mounts or {}) do
		local segments = mount.segments
		if (not segments or #segments == 0) and type(mount.path) == "string" then
			segments = string.split(mount.path, ".")
		end
		if type(segments) == "table" and #segments > 1 then
			local duplicateName = segments[#segments]
			for _, child in ipairs(mount.children or {}) do
				if child and child.name == duplicateName then
					local expectedMountPath = instancePathLabelFromSegments(segments)
					return {
						reasonCode = "DUPLICATE_MOUNT_ROOT",
						targetPath = expectedMountPath .. "." .. duplicateName,
						expectedMountPath = expectedMountPath,
						duplicateName = duplicateName
					}
				end
			end
		end
	end
	return nil
end

local function duplicateMountRootSnapshotMessage(issue)
	return "Project tree contains duplicate mount root '" .. tostring(issue.duplicateName) .. "' at '" .. tostring(issue.targetPath) .. "'. Put children directly under '" .. tostring(issue.expectedMountPath) .. "' instead."
end

local function findDesiredChildForInstance(instance, desiredChildIndex)
	local instanceId = getAmarilloId(instance)
	if instanceId and desiredChildIndex and desiredChildIndex._byId and desiredChildIndex._byId[instanceId] then
		return desiredChildIndex._byId[instanceId]
	end
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

local function isOpaqueModelInstance(instance)
	return instance and instance:IsA("Model")
end

local shouldDestroyUnexpectedChild = nil

local function shouldPreserveUnknownChildDuringApply(child, parentDesiredNode)
	if parentDesiredNode and parentDesiredNode.keepUnknowns == true then
		return true
	end
	if shouldDestroyUnexpectedChild then
		return not shouldDestroyUnexpectedChild(child, parentDesiredNode)
	end
	return isProtectedSyncInstance(child)
end

local function shouldIncludeSnapshotChild(instance, desiredChildIndex, desiredChild, parentDesiredNode, options)
	if isPlayerControlledInstance(instance) then
		return false
	end
	if isOpaqueModelInstance(instance) then
		return false
	end
	if desiredChild then
		return true
	end
	if options and options.omitPreservedUnknowns == true and shouldPreserveUnknownChildDuringApply(instance, parentDesiredNode) then
		return false
	end
	if not isProtectedSyncInstance(instance) then
		return true
	end
	return hasDesiredChildNamed(desiredChildIndex, instance.Name)
end

local function scriptFileKind(instance)
	if instance:IsA("LocalScript") then
		return "client"
	elseif instance:IsA("ModuleScript") then
		return "module"
	elseif instance:IsA("Script") then
		local okRunContext, runContext = pcall(function()
			return instance.RunContext
		end)
		if okRunContext and runContext == Enum.RunContext.Client then
			return "client"
		end
		return "server"
	end
	return nil
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

local function snapshotNode(instance, openDocumentSources, desiredNode, options)
	if isOpaqueModelInstance(instance) then
		return nil
	end
	local amarilloId = reserveSnapshotAmarilloId(instance, options)
	local node = {
		name = instance.Name,
		className = instance.ClassName,
		classNameSource = "studio",
		properties = collectProperties(instance),
		children = {}
	}
	if amarilloId then
		node.amarilloId = amarilloId
	end

	node.fileKind = scriptFileKind(instance)

	if node.fileKind then
		node.source = readScriptSource(instance, openDocumentSources) or ""
	end

	local desiredChildIndex = indexDesiredChildren(desiredNode and desiredNode.children or nil)
	local nameCounts = childNameCounts(instance)
	for _, child in ipairs(instance:GetChildren()) do
		if (nameCounts[child.Name] or 0) > 1 then
			ensureAmarilloId(child)
		end
		local desiredChild = findDesiredChildForInstance(child, desiredChildIndex)
		if shouldIncludeSnapshotChild(child, desiredChildIndex, desiredChild, desiredNode, options) then
			local childSnapshot = snapshotNode(child, openDocumentSources, desiredChild, options)
			if childSnapshot then
				table.insert(node.children, childSnapshot)
			end
		end
	end
	table.sort(node.children, function(left, right)
		local leftKey = tostring(left.name or "") .. "\0" .. tostring(left.className or "") .. "\0" .. tostring(left.amarilloId or "")
		local rightKey = tostring(right.name or "") .. "\0" .. tostring(right.className or "") .. "\0" .. tostring(right.amarilloId or "")
		return leftKey < rightKey
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
		local segment = segments[index]
		local child = current:FindFirstChild(segment)
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

local function snapshotCurrentProject(options)
	if not state.project then
		return nil
	end
	options = options or {}
	options.seenAmarilloIds = {}
	options.duplicateAmarilloIdsCorrected = false
	local openDocumentSources = collectOpenDocumentSources()
	local mounts = {}
	local cachedMounts = {}
	local referenceSnapshot = options.desiredSnapshot or state.treeCache
	local nestedMountChildIndex = buildNestedMountChildIndex(state.project.mounts or {})
	for _, mount in ipairs(referenceSnapshot and referenceSnapshot.mounts or {}) do
		cachedMounts[mount.id] = mount
	end
	local containerGroups = {}
	local containerOrder = {}
	for _, mount in ipairs(state.project.mounts or {}) do
		if not isMountSyncEnabled(mount) then
			continue
		end
		local mountSegments = string.split(mount.path, ".")
		local container = resolveMountContainer(mountSegments)
		if container then
			if not containerGroups[container] then
				containerGroups[container] = {}
				table.insert(containerOrder, container)
			end
			table.insert(containerGroups[container], { mount = mount, mountSegments = mountSegments })
		end
	end

	for _, container in ipairs(containerOrder) do
		local group = containerGroups[container]
		local combinedMountOptions = {}
		local mountResults = {}

		for _, item in ipairs(group) do
			local mount = item.mount
			local desiredMount = cachedMounts[mount.id]
			local desiredChildIndex = indexDesiredChildren(desiredMount and desiredMount.children or nil)
			
			combinedMountOptions[mount.id] = {
				desiredMount = desiredMount or mount,
				desiredChildIndex = desiredChildIndex,
				mountSegments = item.mountSegments
			}
			mountResults[mount.id] = {}
		end

		local nameCounts = childNameCounts(container)
		for _, child in ipairs(container:GetChildren()) do
			if (nameCounts[child.Name] or 0) > 1 then
				ensureAmarilloId(child)
			end
			local matchedMountId = nil
			local childSnapshot = nil
			local bestDesiredChild = nil
			
			-- Pass 1: Find if any mount explicitly claims this child
			for _, item in ipairs(group) do
				local mount = item.mount
				local mOpts = combinedMountOptions[mount.id]
				local desiredChild = findDesiredChildForInstance(child, mOpts.desiredChildIndex)
				if desiredChild and not isNestedMountChild(nestedMountChildIndex, mOpts.mountSegments, child.Name) then
					if shouldIncludeSnapshotChild(child, mOpts.desiredChildIndex, desiredChild, mOpts.desiredMount, options) then
						matchedMountId = mount.id
						bestDesiredChild = desiredChild
						break
					end
				end
			end

			-- Pass 2: If no mount claimed it, find the first mount that accepts unknown children
			if not matchedMountId then
				for _, item in ipairs(group) do
					local mount = item.mount
					local mOpts = combinedMountOptions[mount.id]
					if not isNestedMountChild(nestedMountChildIndex, mOpts.mountSegments, child.Name) and shouldIncludeSnapshotChild(child, mOpts.desiredChildIndex, nil, mOpts.desiredMount, options) then
						matchedMountId = mount.id
						bestDesiredChild = nil
						break
					end
				end
			end

			if matchedMountId then
				childSnapshot = snapshotNode(child, openDocumentSources, bestDesiredChild, options)
				if childSnapshot then
					table.insert(mountResults[matchedMountId], childSnapshot)
				end
			end
		end

		for _, item in ipairs(group) do
			local mount = item.mount
			local children = mountResults[mount.id]
			table.sort(children, function(left, right)
				local leftKey = tostring(left.name or "") .. "\0" .. tostring(left.className or "") .. "\0" .. tostring(left.amarilloId or "")
				local rightKey = tostring(right.name or "") .. "\0" .. tostring(right.className or "") .. "\0" .. tostring(right.amarilloId or "")
				return leftKey < rightKey
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
	if desiredNode and desiredNode.keepUnknowns == true then
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
	if desiredNode and desiredNode.classNameSource == "studio" then
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

shouldDestroyUnexpectedChild = function(child, desiredNode)
	if isProtectedSyncInstance(child) or isNonSyncableInstance(child) then
		return false
	end
	if mayContainStudioOnlyChildren(desiredNode) and hasNonSyncableDescendant(child) then
		return false
	end
	return true
end

local function findExistingChildForDesired(parent, desiredNode, claimedChildren)
	if type(desiredNode.amarilloId) == "string" and desiredNode.amarilloId ~= "" then
		for _, child in ipairs(parent:GetChildren()) do
			if not (claimedChildren and claimedChildren[child]) and getAmarilloId(child) == desiredNode.amarilloId then
				return child
			end
		end
	end
	local targetName = desiredNodeName(desiredNode)
	local sameName = nil
	for _, child in ipairs(parent:GetChildren()) do
		if not (claimedChildren and claimedChildren[child]) and child.Name == targetName then
			if child.ClassName == desiredNode.className then
				return child
			end
			sameName = sameName or child
		end
	end
	return sameName
end

local function ensureInstance(parent, desiredNode, claimedChildren)
	local targetName = desiredNodeName(desiredNode)
	local existing = findExistingChildForDesired(parent, desiredNode, claimedChildren)
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
			appendLog("Failed to create during sync: " .. tostring(desiredNode.className) .. " " .. tostring(targetName) .. " -> " .. tostring(newInstance))
			return nil, true
		end
		existing = newInstance
		local okName = safeSetProperty(existing, "Name", targetName, "sync create name")
		local okParent = okName and safeSetParent(existing, parent, "sync create parent")
		if not okName or not okParent then
			destroyUnexpectedChild(existing, "failed sync create cleanup")
			return nil, true
		end
	end

	if existing.Name ~= targetName then
		local okRename, renameErr = safeSetProperty(existing, "Name", targetName, "sync rename")
		if not okRename then
			appendLog("Failed to rename during sync: " .. describeInstanceForLog(existing) .. " -> " .. tostring(renameErr))
			return nil, true
		end
	end
	if type(desiredNode.amarilloId) == "string" and desiredNode.amarilloId ~= "" then
		setAmarilloId(existing, desiredNode.amarilloId, "sync identity")
	end
	if claimedChildren then
		claimedChildren[existing] = true
	end
	return existing, corrected
end

local function applyNode(parent, desiredNode, openDocumentSources, claimedSiblings)
	local instance, corrected = ensureInstance(parent, desiredNode, claimedSiblings)
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

	local appliedChildren = {}
	for _, child in ipairs(desiredNode.children or {}) do
		if applyNode(instance, child, openDocumentSources, appliedChildren) then
			corrected = true
		end
	end

	if desiredNode.keepUnknowns ~= true then
		for _, child in ipairs(instance:GetChildren()) do
			if not appliedChildren[child] then
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
	projectSnapshot = filterSnapshotForSync(projectSnapshot)
	local duplicateIssue = duplicateMountRootIssueForSnapshot(projectSnapshot)
	if duplicateIssue then
		return false, duplicateMountRootSnapshotMessage(duplicateIssue)
	end

	state.isApplyingRemote = true
	state.suppressPushUntil = now() + REMOTE_PUSH_SUPPRESSION_SECONDS
	local correctedDuringApply = false
	local appliedSnapshot = nil
	local safeSetCycle = beginSafeSetFailureAggregation(command)
	local nestedMountChildIndex = buildNestedMountChildIndex(projectSnapshot.mounts or {})

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
				local appliedChildren = {}
				for _, child in ipairs(mount.children or {}) do
					if applyNode(container, child, openDocumentSources, appliedChildren) then
						correctedDuringApply = true
					end
				end
				if mount.keepUnknowns ~= true then
					for _, child in ipairs(container:GetChildren()) do
						if not appliedChildren[child] then
							-- Never destroy non-syncable instances (GUIs, Parts,
							-- Cameras, etc.) during mount cleanup. The daemon
							-- cannot represent these in the filesystem.
							if not isNestedMountChild(nestedMountChildIndex, mount.segments or {}, child.Name) and not isNonSyncableInstance(child) then
								destroyUnexpectedChild(child, "mount cleanup")
							end
						end
					end
				end
			end
		end

		ChangeHistoryService:SetWaypoint("Amarillo Sync End")
		
		appliedSnapshot = snapshotCurrentProject({
			desiredSnapshot = projectSnapshot,
			omitPreservedUnknowns = true
		})
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
