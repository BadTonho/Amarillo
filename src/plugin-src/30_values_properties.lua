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

local function safeInstanceLabel(target)
	local label = target and target.Name or "?"
	pcall(function()
		label = target:GetFullName()
	end)
	return label
end

local safeSetFailureCycle = nil
local safeSetFailureDedupe = {}

local function safeSetFailureKey(operation, instanceLabel, fieldName, err, reason)
	return tostring(operation) .. "\n" .. tostring(instanceLabel) .. "\n" .. tostring(fieldName) .. "\n" .. tostring(err) .. "\n" .. tostring(reason or "")
end

local function beginSafeSetFailureAggregation(command)
	local payload = command and command.payload or nil
	local cycle = {
		previous = safeSetFailureCycle,
		commandId = command and command.id or nil,
		commandType = command and command.type or "apply_project_tree",
		reason = payload and payload.reason or nil,
		totalFailures = 0,
		failures = {},
		failuresByKey = {}
	}
	safeSetFailureCycle = cycle
	return cycle
end

local function recordSafeSetFailure(operation, target, fieldName, err, contextLabel, extraContext)
	local cycle = safeSetFailureCycle
	if not cycle then
		return
	end
	local instanceLabel = safeInstanceLabel(target)
	local errorText = tostring(err)
	local key = safeSetFailureKey(operation, instanceLabel, fieldName, errorText, cycle.reason)
	local entry = cycle.failuresByKey[key]
	cycle.totalFailures = cycle.totalFailures + 1
	if entry then
		entry.count = entry.count + 1
		return
	end
	entry = {
		operation = operation,
		instance = instanceLabel,
		contextLabel = contextLabel and tostring(contextLabel) or nil,
		error = errorText,
		count = 1,
		commandType = cycle.commandType,
		commandId = cycle.commandId,
		reason = cycle.reason
	}
	if operation == "attribute" then
		entry.attribute = tostring(fieldName)
	else
		entry.property = tostring(fieldName)
	end
	if extraContext then
		for keyName, value in pairs(extraContext) do
			entry[keyName] = value
		end
	end
	cycle.failuresByKey[key] = entry
	table.insert(cycle.failures, entry)
end

local function finishSafeSetFailureAggregation(cycle)
	if safeSetFailureCycle ~= cycle then
		return
	end
	safeSetFailureCycle = cycle.previous
	local timestamp = now()
	local failures = {}
	local totalFailures = 0
	local suppressedFailures = 0
	for _, failure in ipairs(cycle.failures) do
		local fieldName = failure.attribute or failure.property or "?"
		local key = safeSetFailureKey(failure.operation, failure.instance, fieldName, failure.error, cycle.reason)
		local lastReportedAt = safeSetFailureDedupe[key]
		if lastReportedAt and (timestamp - lastReportedAt) < SAFE_SET_ERROR_DEDUPE_SECONDS then
			suppressedFailures = suppressedFailures + failure.count
		else
			safeSetFailureDedupe[key] = timestamp
			totalFailures = totalFailures + failure.count
			table.insert(failures, failure)
		end
	end
	if #failures == 0 then
		return
	end
	local limitedFailures = {}
	for index, failure in ipairs(failures) do
		if index > SAFE_SET_FAILURE_REPORT_LIMIT then
			break
		end
		table.insert(limitedFailures, failure)
	end
	local message = "Safe-set failed during apply_project_tree: "
		.. tostring(totalFailures)
		.. " failure(s) across "
		.. tostring(#failures)
		.. " unique target/property/error combination(s)."
	reportPluginError(message, "PLUGIN-SAFE-SET", {
		commandId = cycle.commandId,
		commandType = cycle.commandType,
		reason = cycle.reason,
		totalFailures = totalFailures,
		uniqueFailures = #failures,
		suppressedFailures = suppressedFailures,
		failures = limitedFailures
	}, "warning")
end

local function safeSetProperty(target, propertyName, value, contextLabel)
	local ok, err = pcall(function()
		target[propertyName] = value
	end)
	if not ok then
		appendLog("safeSetProperty failed (" .. tostring(contextLabel or propertyName) .. " on " .. safeInstanceLabel(target) .. "): " .. tostring(err))
		recordSafeSetFailure("property", target, propertyName, err, contextLabel)
	end
	return ok, err
end

local function safeSetAttribute(target, attributeName, value, contextLabel)
	local ok, err = pcall(function()
		target:SetAttribute(attributeName, value)
	end)
	if not ok then
		appendLog("safeSetAttribute failed (" .. tostring(contextLabel or attributeName) .. " on " .. safeInstanceLabel(target) .. "): " .. tostring(err))
		recordSafeSetFailure("attribute", target, attributeName, err, contextLabel)
	end
	return ok, err
end

local function safeSetParent(target, newParent, contextLabel)
	local ok, err = pcall(function()
		target.Parent = newParent
	end)
	if not ok then
		appendLog("safeSetParent failed (" .. tostring(contextLabel or safeInstanceLabel(target)) .. " -> " .. safeInstanceLabel(newParent) .. "): " .. tostring(err))
		recordSafeSetFailure("parent", target, "Parent", err, contextLabel, {
			parent = safeInstanceLabel(newParent)
		})
	end
	return ok, err
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

-- OPT-003: Event-driven open document cache instead of polling script documents.
