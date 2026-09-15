"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  diffSnapshots,
  normalizeSnapshot,
  snapshotsMatch
} = require("../src/daemon/lib/snapshot-hash");

function proximityPromptSnapshot(properties) {
  return {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["Workspace"],
        children: [
          {
            name: "ProximityPrompt",
            className: "ProximityPrompt",
            properties,
            children: []
          }
        ]
      }
    ]
  };
}

const proximityPromptDefaults = {
  ActionText: "Interact",
  AutoLocalize: true,
  ClickablePrompt: false,
  Enabled: true,
  Exclusivity: "OnePerButton",
  GamepadKeyCode: "ButtonX",
  HoldDuration: 0,
  KeyboardKeyCode: "E",
  MaxActivationDistance: 10,
  MaxIndicatorDistance: 0,
  ObjectText: "",
  RequiresLineOfSight: true,
  Style: "Default",
  UIOffset: { __type: "Vector2", x: 0, y: 0 }
};

test("snapshot-hash normalizes properties with Roblox defaults", () => {
  const localSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "MainFrame",
            className: "Frame",
            properties: {
              BackgroundColor3: [1, 1, 1]
            },
            children: []
          }
        ]
      }
    ]
  };

  const normalized = normalizeSnapshot(localSnapshot);
  const frameNode = normalized.mounts[0].children[0];

  // Verify that class default properties are successfully injected during normalization
  assert.equal(frameNode.properties.ZIndex, 1);
  assert.equal(frameNode.properties.Active, false);
  assert.equal(frameNode.properties.Visible, true);
  assert.deepEqual(frameNode.properties.Size, { __type: "UDim2", xScale: 0, xOffset: 100, yScale: 0, yOffset: 100 });
});

test("snapshot-hash preserves explicit property overrides", () => {
  const localSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "MainFrame",
            className: "Frame",
            properties: {
              ZIndex: 3,
              Active: true,
              BackgroundColor3: [0.5, 0.5, 0.5]
            },
            children: []
          }
        ]
      }
    ]
  };

  const normalized = normalizeSnapshot(localSnapshot);
  const frameNode = normalized.mounts[0].children[0];

  // Explicit values should NOT be overwritten by defaults
  assert.equal(frameNode.properties.ZIndex, 3);
  assert.equal(frameNode.properties.Active, true);
  assert.deepEqual(frameNode.properties.BackgroundColor3, [0.5, 0.5, 0.5]);
});

test("snapshotsMatch returns true when expected is missing defaults but observed has them", () => {
  const expectedSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "TextLabelInstance",
            className: "TextLabel",
            properties: {
              Text: "Custom"
            },
            children: []
          }
        ]
      }
    ]
  };

  const observedSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "TextLabelInstance",
            className: "TextLabel",
            properties: {
              Text: "Custom",
              ZIndex: 1,
              Active: false,
              Visible: true,
              TextSize: 8,
              TextTransparency: 0,
              TextColor3: [0, 0, 0]
            },
            children: []
          }
        ]
      }
    ]
  };

  assert.ok(snapshotsMatch(expectedSnapshot, observedSnapshot));
});

test("snapshotsMatch detects real mismatches in non-default values", () => {
  const expectedSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "TextLabelInstance",
            className: "TextLabel",
            properties: {
              Text: "Custom"
            },
            children: []
          }
        ]
      }
    ]
  };

  const observedSnapshot = {
    projectId: "test-project",
    mounts: [
      {
        id: "mount-1",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "TextLabelInstance",
            className: "TextLabel",
            properties: {
              Text: "DifferentText"
            },
            children: []
          }
        ]
      }
    ]
  };

  assert.equal(snapshotsMatch(expectedSnapshot, observedSnapshot), false);
});

test("ProximityPrompt defaults do not mismatch explicit local metadata", () => {
  const local = proximityPromptSnapshot({
    ActionText: "Abrir Star",
    ObjectText: "Star",
    MaxActivationDistance: 12,
    RequiresLineOfSight: false,
    HoldDuration: 0
  });

  const studio = proximityPromptSnapshot({
    ...proximityPromptDefaults,
    ActionText: "Abrir Star",
    ObjectText: "Star",
    MaxActivationDistance: 12,
    RequiresLineOfSight: false,
    HoldDuration: 0
  });

  assert.equal(snapshotsMatch(local, studio), true);
});

test("ProximityPrompt property changes produce semantic diffs", () => {
  const base = proximityPromptSnapshot({ ...proximityPromptDefaults });
  const changes: Array<[string, unknown]> = [
    ["ActionText", "Outra acao"],
    ["ObjectText", "Outro objeto"],
    ["MaxActivationDistance", 13],
    ["HoldDuration", 1],
    ["Exclusivity", "AlwaysShow"],
    ["KeyboardKeyCode", "F"],
    ["UIOffset", { __type: "Vector2", x: 4, y: -2 }]
  ];

  for (const [propertyName, value] of changes) {
    const changed = proximityPromptSnapshot({
      ...proximityPromptDefaults,
      [propertyName]: value
    });

    assert.equal(
      snapshotsMatch(base, changed),
      false,
      `${propertyName} should produce a diff`
    );
  }
});
