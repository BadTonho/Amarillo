"use strict";

const crypto = require("node:crypto");

const VALID_FILE_KINDS = new Set(["server", "client", "module"]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeScriptSourceForSync(source) {
  return String(source ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "");
}

function inferredFileKindForClass(className) {
  if (className === "Script") {
    return "server";
  }
  if (className === "LocalScript") {
    return "client";
  }
  if (className === "ModuleScript") {
    return "module";
  }
  return null;
}

function normalizeFileKind(node) {
  const explicit = typeof node?.fileKind === "string" ? node.fileKind : null;
  if (explicit && VALID_FILE_KINDS.has(explicit)) {
    return explicit;
  }
  return inferredFileKindForClass(node?.className);
}

function classNameForFileKind(fileKind) {
  if (fileKind === "server") {
    return "Script";
  }
  if (fileKind === "client") {
    return "LocalScript";
  }
  if (fileKind === "module") {
    return "ModuleScript";
  }
  return "Folder";
}

function normalizeClassName(node, fileKind) {
  if (typeof node?.className === "string" && node.className.length > 0) {
    return node.className;
  }
  return classNameForFileKind(fileKind);
}

function normalizeSemanticValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSemanticValue(item));
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((next, key) => {
        const item = value[key];
        if (item !== undefined) {
          next[key] = normalizeSemanticValue(item);
        }
        return next;
      }, {});
  }
  return value;
}

function isScriptLikeClassName(className) {
  return className === "Script" || className === "LocalScript" || className === "ModuleScript";
}

const INHERITANCE_MAP: Record<string, string[]> = {
  // GUI Objects
  "Frame": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "TextLabel": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "ImageLabel": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "TextButton": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "ImageButton": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "ScrollingFrame": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  "TextBox": ["GuiObject", "GuiBase2d", "GuiBase", "Instance"],
  
  // GUI Base / ScreenGui
  "ScreenGui": ["LayerCollector", "GuiBase", "Instance"],
  
  // UI Constraints & Components
  "UIGridLayout": ["UIGridStyleLayout", "UIConstraint", "Instance"],
  "UIListLayout": ["UIGridStyleLayout", "UIConstraint", "Instance"],
  "UICorner": ["UIComponent", "Instance"],
  "UIStroke": ["UIComponent", "Instance"],
  "UIGradient": ["UIComponent", "Instance"],
  "UIPadding": ["UIComponent", "Instance"],
  "UIAspectRatioConstraint": ["UIConstraint", "Instance"],
  "UISizeConstraint": ["UIConstraint", "Instance"],
  "UITextSizeConstraint": ["UIConstraint", "Instance"],
  
  // Parts
  "Part": ["BasePart", "PVInstance", "Instance"],
  "MeshPart": ["BasePart", "PVInstance", "Instance"]
};

function isA(className: string, targetClass: string): boolean {
  if (className === targetClass) return true;
  const chain = INHERITANCE_MAP[className];
  if (!chain) return false;
  return chain.includes(targetClass);
}

function deepClone(value: any): any {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map(deepClone);
    }
    const copy: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      copy[k] = deepClone(value[k]);
    }
    return copy;
  }
  return value;
}

function getDefaultPropertiesForClass(className: string): Record<string, any> {
  const defaults: Record<string, any> = {};

  if (isA(className, "ScreenGui")) {
    defaults.ResetOnSpawn = true;
    defaults.IgnoreGuiInset = false;
    defaults.DisplayOrder = 0;
    defaults.Enabled = true;
    defaults.ZIndexBehavior = "Sibling";
  }
  
  if (isA(className, "GuiObject")) {
    defaults.Position = { __type: "UDim2", xScale: 0, xOffset: 0, yScale: 0, yOffset: 0 };
    defaults.Size = { __type: "UDim2", xScale: 0, xOffset: 100, yScale: 0, yOffset: 100 };
    defaults.AnchorPoint = { __type: "Vector2", x: 0, y: 0 };
    defaults.BackgroundTransparency = 0;
    defaults.Visible = true;
    defaults.ZIndex = 1;
    defaults.BackgroundColor3 = [1, 1, 1];
    defaults.BorderColor3 = [0, 0, 0];
    defaults.BorderSizePixel = 0;
    defaults.ClipsDescendants = false;
    defaults.LayoutOrder = 0;
    defaults.Rotation = 0;
    defaults.SizeConstraint = "RelativeXY";
    defaults.AutomaticSize = "None";
    
    if (isA(className, "ImageButton") || isA(className, "TextButton") || isA(className, "TextBox")) {
      defaults.Active = true;
      defaults.Selectable = true;
    } else {
      defaults.Active = false;
      defaults.Selectable = false;
    }
    defaults.SelectionOrder = 0;
  }
  
  if (isA(className, "ImageLabel") || isA(className, "ImageButton")) {
    defaults.Image = "";
    defaults.ImageColor3 = [1, 1, 1];
    defaults.ImageTransparency = 0;
    defaults.ImageRectOffset = { __type: "Vector2", x: 0, y: 0 };
    defaults.ImageRectSize = { __type: "Vector2", x: 0, y: 0 };
    defaults.ScaleType = "Stretch";
    defaults.SliceCenter = { __type: "Rect", minX: 0, minY: 0, maxX: 0, maxY: 0 };
    defaults.SliceScale = 1;
    defaults.TileSize = { __type: "UDim2", xScale: 1, xOffset: 0, yScale: 1, yOffset: 0 };
    defaults.ResampleMode = "Default";
  }
  
  if (isA(className, "ImageButton")) {
    defaults.HoverImage = "";
    defaults.PressedImage = "";
    defaults.AutoButtonColor = true;
    defaults.Modal = false;
    defaults.Selected = false;
    defaults.Style = "Custom";
  }
  
  if (isA(className, "ScrollingFrame")) {
    defaults.CanvasSize = { __type: "UDim2", xScale: 0, xOffset: 0, yScale: 2, yOffset: 0 };
    defaults.AutomaticCanvasSize = "None";
    defaults.ScrollBarThickness = 12;
    defaults.ScrollingDirection = "XY";
    defaults.ScrollingEnabled = true;
    defaults.ScrollBarImageColor3 = [0, 0, 0];
    defaults.ScrollBarImageTransparency = 0;
    defaults.VerticalScrollBarInset = "None";
    defaults.HorizontalScrollBarInset = "None";
    defaults.ElasticBehavior = "WhenScrollable";
    defaults.TopImage = "rbxasset://textures/ui/Scroll/scroll-top.png";
    defaults.MidImage = "rbxasset://textures/ui/Scroll/scroll-mid.png";
    defaults.BottomImage = "rbxasset://textures/ui/Scroll/scroll-bottom.png";
  }
  
  if (isA(className, "TextLabel") || isA(className, "TextButton") || isA(className, "TextBox")) {
    defaults.Text = isA(className, "TextLabel") ? "Label" : (isA(className, "TextButton") ? "Button" : "");
    defaults.TextSize = 8;
    defaults.TextTransparency = 0;
    defaults.TextColor3 = [0, 0, 0];
    defaults.TextScaled = false;
    defaults.TextWrapped = false;
    defaults.TextXAlignment = "Center";
    defaults.TextYAlignment = "Center";
    defaults.Font = "Legacy";
    defaults.FontFace = { __type: "Font", family: "rbxasset://fonts/families/LegacySansSerif.json", weight: "Regular", style: "Normal" };
    defaults.RichText = false;
    defaults.LineHeight = 1;
    defaults.MaxVisibleGraphemes = -1;
    defaults.TextStrokeColor3 = [0, 0, 0];
    defaults.TextStrokeTransparency = 1;
  }
  
  if (isA(className, "UIGridLayout")) {
    defaults.CellPadding = { __type: "UDim2", xScale: 0, xOffset: 5, yScale: 0, yOffset: 5 };
    defaults.CellSize = { __type: "UDim2", xScale: 0, xOffset: 100, yScale: 0, yOffset: 100 };
    defaults.FillDirection = "Horizontal";
    defaults.FillDirectionMaxCells = 0;
    defaults.HorizontalAlignment = "Left";
    defaults.SortOrder = "LayoutOrder";
    defaults.StartCorner = "TopLeft";
    defaults.VerticalAlignment = "Top";
  }
  
  if (isA(className, "UIListLayout")) {
    defaults.FillDirection = "Vertical";
    defaults.HorizontalAlignment = "Left";
    defaults.VerticalAlignment = "Top";
    defaults.Padding = { __type: "UDim", scale: 0, offset: 0 };
    defaults.SortOrder = "LayoutOrder";
    defaults.Wraps = false;
  }
  
  if (isA(className, "UICorner")) {
    defaults.CornerRadius = { __type: "UDim", scale: 0, offset: 8 };
  }
  
  if (isA(className, "UIStroke")) {
    defaults.Thickness = 1;
    defaults.Color = [0, 0, 0];
    defaults.Transparency = 0;
    defaults.ApplyStrokeMode = "Contextual";
    defaults.LineJoinMode = "Round";
  }
  
  if (isA(className, "UIGradient")) {
    defaults.Color = {
      __type: "ColorSequence",
      keypoints: [
        { time: 0, value: [1, 1, 1] },
        { time: 1, value: [1, 1, 1] }
      ]
    };
    defaults.Transparency = {
      __type: "NumberSequence",
      keypoints: [
        { time: 0, value: 0, envelope: 0 },
        { time: 1, value: 0, envelope: 0 }
      ]
    };
    defaults.Rotation = 0;
    defaults.Offset = { __type: "Vector2", x: 0, y: 0 };
  }
  
  if (isA(className, "UIPadding")) {
    defaults.PaddingLeft = { __type: "UDim", scale: 0, offset: 0 };
    defaults.PaddingRight = { __type: "UDim", scale: 0, offset: 0 };
    defaults.PaddingTop = { __type: "UDim", scale: 0, offset: 0 };
    defaults.PaddingBottom = { __type: "UDim", scale: 0, offset: 0 };
  }
  
  if (isA(className, "UIAspectRatioConstraint")) {
    defaults.AspectRatio = 1;
    defaults.AspectType = "FitWithinMaxSize";
    defaults.DominantAxis = "Width";
  }
  
  if (isA(className, "UISizeConstraint")) {
    defaults.MaxSize = { __type: "Vector2", x: Infinity, y: Infinity };
    defaults.MinSize = { __type: "Vector2", x: 0, y: 0 };
  }
  
  if (isA(className, "UITextSizeConstraint")) {
    defaults.MaxTextSize = 100;
    defaults.MinTextSize = 1;
  }
  
  if (isA(className, "BasePart")) {
    defaults.Anchored = false;
    defaults.CanCollide = true;
    defaults.CanQuery = true;
    defaults.CanTouch = true;
    defaults.CastShadow = true;
    defaults.Color = [0.6392156, 0.6352941, 0.6470588];
    defaults.Material = "Plastic";
    defaults.Size = [4, 1.2, 2];
    defaults.Transparency = 0;
    defaults.Massless = false;
    defaults.Shape = "Block";
    defaults.BottomSurface = "Smooth";
    defaults.TopSurface = "Smooth";
  }
  
  if (isA(className, "MeshPart")) {
    defaults.MeshId = "";
    defaults.TextureID = "";
    defaults.RenderFidelity = "File";
  }

  if (className === "ProximityPrompt") {
    defaults.ActionText = "Interact";
    defaults.AutoLocalize = true;
    defaults.ClickablePrompt = true;
    defaults.Enabled = true;
    defaults.Exclusivity = "OnePerButton";
    defaults.GamepadKeyCode = "ButtonX";
    defaults.HoldDuration = 0;
    defaults.KeyboardKeyCode = "E";
    defaults.MaxActivationDistance = 10;
    defaults.MaxIndicatorDistance = 0;
    defaults.ObjectText = "";
    defaults.RequiresLineOfSight = true;
    defaults.Style = "Default";
    defaults.UIOffset = { __type: "Vector2", x: 0, y: 0 };
  }

  return defaults;
}

function normalizeScriptProperties(properties) {
  const normalized = normalizeSemanticValue(properties);
  let disabled = typeof normalized.Disabled === "boolean" ? normalized.Disabled : undefined;
  if (typeof normalized.Enabled === "boolean") {
    disabled = !normalized.Enabled;
  }
  delete normalized.Enabled;
  delete normalized.Disabled;
  if (disabled === true) {
    normalized.Disabled = true;
  }
  return normalized;
}

function normalizeProperties(properties, node = null) {
  const props = isPlainObject(properties) ? { ...properties } : {};
  const className = node?.className;
  if (className) {
    const defaults = getDefaultPropertiesForClass(className);
    for (const key of Object.keys(defaults)) {
      if (props[key] === undefined) {
        props[key] = deepClone(defaults[key]);
      }
    }
  }

  if (node && isScriptLikeClassName(node.className)) {
    return normalizeScriptProperties(props);
  }
  return normalizeSemanticValue(props);
}

function normalizeModelDescriptorData(modelData) {
  if (!isPlainObject(modelData)) {
    return null;
  }
  const normalized: any = {};
  if (Number.isInteger(modelData.descriptorVersion) && modelData.descriptorVersion > 0) {
    normalized.descriptorVersion = modelData.descriptorVersion;
  }
  if (typeof modelData.fullName === "string") {
    normalized.fullName = modelData.fullName;
  }
  if (Number.isInteger(modelData.childCount) && modelData.childCount >= 0) {
    normalized.childCount = modelData.childCount;
  }
  if (Number.isInteger(modelData.descendantCount) && modelData.descendantCount >= 0) {
    normalized.descendantCount = modelData.descendantCount;
  }
  if (typeof modelData.primaryPart === "string") {
    normalized.primaryPart = modelData.primaryPart;
  }
  if (Array.isArray(modelData.children)) {
    normalized.children = modelData.children
      .filter((child) => isPlainObject(child))
      .map((child) => {
        const summary: any = {};
        if (typeof child.name === "string") {
          summary.name = child.name;
        }
        if (typeof child.className === "string") {
          summary.className = child.className;
        }
        if (Number.isInteger(child.childCount) && child.childCount >= 0) {
          summary.childCount = child.childCount;
        }
        return summary;
      })
      .filter((child) => child.name !== undefined || child.className !== undefined)
      .sort((left, right) => `${left.name || ""}\u0000${left.className || ""}`.localeCompare(`${right.name || ""}\u0000${right.className || ""}`));
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isModelDescriptorNode(node, className = null) {
  return (className || normalizeClassName(node, normalizeFileKind(node))) === "Model"
    && node?.modelDescriptor === true;
}

function isOpaqueModelNode(node, fileKind = null) {
  return normalizeClassName(node, fileKind ?? normalizeFileKind(node)) === "Model"
    && node?.modelDescriptor !== true;
}

function canonicalNodeSortKey(node) {
  return [
    node.name || "",
    node.className || "",
    node.fileKind || "",
    node.source || ""
  ].join("\u0000");
}

function normalizeNode(node, context: any = {}) {
  const value = isPlainObject(node) ? node : {};
  const fileKind = normalizeFileKind(value);
  const className = normalizeClassName(value, fileKind);
  if (isOpaqueModelNode(value, fileKind)) {
    return null;
  }
  if (isModelDescriptorNode(value, className)) {
    const normalized: any = {
      name: typeof value.name === "string" ? value.name : "",
      className,
      properties: normalizeProperties(value.properties, { className, fileKind }),
      children: [],
      modelDescriptor: true
    };
    const modelData = normalizeModelDescriptorData(value.modelData);
    if (modelData) {
      normalized.modelData = modelData;
    }
    return normalized;
  }
  const insideModel = context.insideModel === true;
  const isModel = className === "Model";
  const scriptLike = Boolean(fileKind) || isScriptLikeClassName(className);
  const children = normalizeChildren(value.children, { insideModel: insideModel || isModel });
  if (insideModel && !scriptLike && children.length === 0) {
    return null;
  }
  const normalized = {
    name: typeof value.name === "string" ? value.name : "",
    className,
    properties: insideModel && !scriptLike ? {} : normalizeProperties(value.properties, { className, fileKind }),
    children
  } as any;

  if (fileKind) {
    normalized.fileKind = fileKind;
  }
  if (fileKind || value.source !== undefined) {
    normalized.source = normalizeScriptSourceForSync(value.source);
  }
  return normalized;
}

function normalizeChildren(children, context: any = {}) {
  return (Array.isArray(children) ? children : [])
    .map((child) => normalizeNode(child, context))
    .filter(Boolean)
    .sort((left, right) => canonicalNodeSortKey(left).localeCompare(canonicalNodeSortKey(right)));
}

function normalizeSegments(mount) {
  if (Array.isArray(mount?.segments)) {
    return mount.segments.filter((segment) => typeof segment === "string");
  }
  if (typeof mount?.id === "string" && mount.id.length > 0) {
    return mount.id.split(".");
  }
  return [];
}

function normalizeSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    projectId: typeof value.projectId === "string" ? value.projectId : null,
    mounts: (Array.isArray(value.mounts) ? value.mounts : [])
      .map((mount) => ({
        id: typeof mount?.id === "string" ? mount.id : "",
        segments: normalizeSegments(mount),
        children: normalizeChildren(mount?.children)
      }))
      .sort((left, right) => [
        left.id,
        left.segments.join(".")
      ].join("\u0000").localeCompare([
        right.id,
        right.segments.join(".")
      ].join("\u0000")))
  };
}

function stringifySorted(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Array.isArray(item)) {
      return item;
    }
    if (item && typeof item === "object") {
      return Object.keys(item)
        .sort()
        .reduce((next, key) => {
          next[key] = item[key];
          return next;
        }, {});
    }
    return item;
  });
}

function normalizeAndHashSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const json = stringifySorted(normalized);
  return {
    normalized,
    hash: crypto.createHash("sha1").update(json).digest("hex"),
    byteLength: Buffer.byteLength(json, "utf8")
  };
}

function hashSnapshot(snapshot) {
  return normalizeAndHashSnapshot(snapshot).hash;
}

function rawChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function rawMounts(snapshot) {
  return Array.isArray(snapshot?.mounts) ? snapshot.mounts : [];
}

function indexByName(items, context: any = {}) {
  const indexed = new Map();
  for (const item of items || []) {
    if (!normalizeNode(item, context)) {
      continue;
    }
    const name = typeof item?.name === "string" ? item.name : "";
    if (!indexed.has(name)) {
      indexed.set(name, []);
    }
    indexed.get(name).push(item);
  }
  for (const bucket of indexed.values()) {
    bucket.sort((left, right) => canonicalNodeSortKey(normalizeNode(left, context) || {}).localeCompare(canonicalNodeSortKey(normalizeNode(right, context) || {})));
  }
  return indexed;
}

function compactValue(value) {
  const json = stringifySorted(value);
  return json.length > 140 ? `${json.slice(0, 137)}...` : json;
}

function isAllowedCorrectedStudioClass(expectedNode, observedNode, options) {
  if (options?.allowCorrectedStudioClasses !== true) {
    return false;
  }
  return expectedNode?.className === "Folder"
    && expectedNode?.classNameSource === "defaultFolder"
    && observedNode?.classNameSource === "studio"
    && !normalizeFileKind(expectedNode)
    && !normalizeFileKind(observedNode);
}

function diffSnapshots(expectedSnapshot, observedSnapshot, options: any = {}) {
  const maxChanges = Number.isFinite(options.maxChanges) ? Math.max(1, options.maxChanges) : 20;
  const changes = [];
  let changeCount = 0;

  function addChange(change) {
    changeCount++;
    if (changes.length < maxChanges) {
      changes.push(change);
    }
  }

  function compareNodes(pathLabel, expectedNode, observedNode, context: any = {}) {
    if (!expectedNode && observedNode) {
      addChange({ path: pathLabel, type: "unexpected_in_studio", observedClassName: observedNode.className || null });
      return;
    }
    if (expectedNode && !observedNode) {
      addChange({ path: pathLabel, type: "missing_in_studio", expectedClassName: expectedNode.className || null });
      return;
    }

    const expectedNormalized = normalizeNode(expectedNode, context);
    const observedNormalized = normalizeNode(observedNode, context);
    if (!expectedNormalized && !observedNormalized) {
      return;
    }
    if (!expectedNormalized && observedNormalized) {
      addChange({ path: pathLabel, type: "unexpected_in_studio", observedClassName: observedNormalized.className || null });
      return;
    }
    if (expectedNormalized && !observedNormalized) {
      addChange({ path: pathLabel, type: "missing_in_studio", expectedClassName: expectedNormalized.className || null });
      return;
    }
    const classCorrectionAllowed = isAllowedCorrectedStudioClass(expectedNode, observedNode, options);

    if (!classCorrectionAllowed && expectedNormalized.className !== observedNormalized.className) {
      addChange({
        path: pathLabel,
        type: "className",
        expected: expectedNormalized.className,
        observed: observedNormalized.className
      });
    }
    if ((expectedNormalized.fileKind || null) !== (observedNormalized.fileKind || null)) {
      addChange({
        path: pathLabel,
        type: "fileKind",
        expected: expectedNormalized.fileKind || null,
        observed: observedNormalized.fileKind || null
      });
    }
    if ((expectedNormalized.source || "") !== (observedNormalized.source || "")) {
      addChange({ path: pathLabel, type: "source" });
    }

    let propertiesMismatch = false;
    if (classCorrectionAllowed) {
      // If class correction is allowed, only compare properties that are explicitly defined on the expected side
      for (const key of Object.keys(expectedNormalized.properties || {})) {
        if (stringifySorted(expectedNormalized.properties[key]) !== stringifySorted(observedNormalized.properties[key])) {
          propertiesMismatch = true;
          break;
        }
      }
    } else {
      propertiesMismatch = stringifySorted(expectedNormalized.properties || {}) !== stringifySorted(observedNormalized.properties || {});
    }

    if (propertiesMismatch) {
      addChange({
        path: pathLabel,
        type: "properties",
        expected: compactValue(expectedNormalized.properties || {}),
        observed: compactValue(observedNormalized.properties || {})
      });
    }

    if ((expectedNormalized.modelDescriptor === true || observedNormalized.modelDescriptor === true)
      && stringifySorted(expectedNormalized.modelData || {}) !== stringifySorted(observedNormalized.modelData || {})) {
      addChange({
        path: pathLabel,
        type: "model_descriptor",
        expected: compactValue(expectedNormalized.modelData || {}),
        observed: compactValue(observedNormalized.modelData || {})
      });
    }

    const childContext = {
      insideModel: context.insideModel === true || expectedNormalized.className === "Model" || observedNormalized.className === "Model"
    };
    compareChildren(pathLabel, rawChildren(expectedNode), rawChildren(observedNode), childContext);
  }

  function compareChildren(parentPath, expectedChildren, observedChildren, context: any = {}) {
    const expectedByName = indexByName(expectedChildren, context);
    const observedByName = indexByName(observedChildren, context);
    const names = new Set([...expectedByName.keys(), ...observedByName.keys()]);
    for (const name of Array.from(names).sort()) {
      const expectedItems = expectedByName.get(name) || [];
      const observedItems = observedByName.get(name) || [];
      const maxLength = Math.max(expectedItems.length, observedItems.length);
      if (expectedItems.length !== observedItems.length && (expectedItems.length > 1 || observedItems.length > 1)) {
        addChange({
          path: parentPath ? `${parentPath}/${name}` : name,
          type: "duplicate_name",
          expectedCount: expectedItems.length,
          observedCount: observedItems.length
        });
      }
      for (let index = 0; index < maxLength; index++) {
        const suffix = maxLength > 1 ? `#${index + 1}` : "";
        compareNodes(parentPath ? `${parentPath}/${name}${suffix}` : `${name}${suffix}`, expectedItems[index], observedItems[index], context);
      }
    }
  }

  const expectedProjectId = typeof expectedSnapshot?.projectId === "string" ? expectedSnapshot.projectId : null;
  const observedProjectId = typeof observedSnapshot?.projectId === "string" ? observedSnapshot.projectId : null;
  if (expectedProjectId !== observedProjectId) {
    addChange({ path: "$", type: "projectId", expected: expectedProjectId, observed: observedProjectId });
  }

  const expectedMounts = new Map(rawMounts(expectedSnapshot).map((mount) => [mount.id, mount]));
  const observedMounts = new Map(rawMounts(observedSnapshot).map((mount) => [mount.id, mount]));
  const mountIds = new Set([...expectedMounts.keys(), ...observedMounts.keys()]);
  for (const mountId of Array.from(mountIds).sort()) {
    const expectedMount = expectedMounts.get(mountId);
    const observedMount = observedMounts.get(mountId);
    if (!expectedMount && observedMount) {
      addChange({ path: `[${mountId}]`, type: "unexpected_mount" });
      continue;
    }
    if (expectedMount && !observedMount) {
      addChange({ path: `[${mountId}]`, type: "missing_mount" });
      continue;
    }

    const expectedSegments = normalizeSegments(expectedMount).join(".");
    const observedSegments = normalizeSegments(observedMount).join(".");
    if (expectedSegments !== observedSegments) {
      addChange({
        path: `[${mountId}]`,
        type: "segments",
        expected: expectedSegments,
        observed: observedSegments
      });
    }
    compareChildren(String(mountId), rawChildren(expectedMount), rawChildren(observedMount));
  }

  return {
    changes,
    changeCount,
    truncated: changeCount > changes.length
  };
}

function snapshotsMatch(expectedSnapshot, observedSnapshot, options: any = {}) {
  return diffSnapshots(expectedSnapshot, observedSnapshot, { ...options, maxChanges: 1 }).changeCount === 0;
}

module.exports = {
  diffSnapshots,
  hashSnapshot,
  normalizeAndHashSnapshot,
  normalizeSnapshot,
  normalizeScriptSourceForSync,
  snapshotsMatch,
  stringifySorted
};
