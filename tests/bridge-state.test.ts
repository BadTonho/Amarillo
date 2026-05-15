"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BridgeStateMachine } = require("../vscode-extension/bridge-state");

function fakeProcess() {
  return {
    killed: false,
    killCount: 0,
    kill() {
      this.killed = true;
      this.killCount += 1;
    }
  };
}

test("BridgeStateMachine owns daemon process lifecycle", () => {
  const state = new BridgeStateMachine();
  const proc = fakeProcess();

  state.transitionTo("starting");
  state.attachProcess(proc);

  assert.equal(state.daemonState, "running");
  assert.equal(state.hasLiveProcess, true);
  assert.equal(state.daemonProcess, proc);

  assert.equal(state.killProcess(), true);
  assert.equal(proc.killCount, 1);
  assert.equal(state.daemonState, "stopped");
  assert.equal(state.daemonProcess, null);
});

test("BridgeStateMachine marks spawn errors and close events without killing", () => {
  const state = new BridgeStateMachine();
  const proc = fakeProcess();

  state.attachProcess(proc);
  state.markProcessClosed("error");

  assert.equal(proc.killCount, 0);
  assert.equal(state.daemonState, "error");
  assert.equal(state.hasLiveProcess, false);

  state.attachProcess(proc);
  state.markProcessClosed("stopped");

  assert.equal(state.daemonState, "stopped");
  assert.equal(state.daemonProcess, null);
});

test("BridgeStateMachine dispose clears process, token, timers, and handshake state", () => {
  const state = new BridgeStateMachine();
  const proc = fakeProcess();
  state.attachProcess(proc);
  state.bridgeToken = "token";
  state.startPromptShown = true;
  state.offerRequested = true;
  state.offerRequestInFlight = true;

  state.dispose();

  assert.equal(proc.killCount, 1);
  assert.equal(state.bridgeToken, null);
  assert.equal(state.daemonState, "stopped");
  assert.equal(state.startPromptShown, false);
  assert.equal(state.offerRequested, false);
  assert.equal(state.offerRequestInFlight, false);
});
