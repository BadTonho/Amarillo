"use strict";

// ===== Bridge State Machine =====
// Replaces scattered global boolean variables with an explicit state machine
// for the daemon lifecycle and sidebar handshake cycle.

// ----- Daemon lifecycle states -----

type DaemonState = "stopped" | "starting" | "running" | "error";

// ----- Handshake sub-state -----

interface HandshakeState {
  cycleKey: string | null;
  startPromptShown: boolean;
  offerRequested: boolean;
  offerRequestInFlight: boolean;
}

// ----- Bridge State Machine -----

class BridgeStateMachine {
  // Core daemon state
  private _daemonState: DaemonState = "stopped";
  private _daemonProcess: any = null;

  // Bridge token
  private _bridgeToken: string | null = null;

  // Sidebar refresh coordination
  private _sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _sidebarRefreshInFlight: Promise<void> | null = null;

  // Handshake state (was 4 separate booleans)
  private _handshake: HandshakeState = {
    cycleKey: null,
    startPromptShown: false,
    offerRequested: false,
    offerRequestInFlight: false
  };

  // Degraded session tracking
  private _lastDegradedNotifiedSessionId: string | null = null;

  // ----- Daemon State -----

  get daemonState(): DaemonState {
    return this._daemonState;
  }

  get isRunning(): boolean {
    return this._daemonState === "running" || this._daemonState === "starting";
  }

  get isStopped(): boolean {
    return this._daemonState === "stopped" || this._daemonState === "error";
  }

  get daemonProcess(): any {
    return this._daemonProcess;
  }

  get hasLiveProcess(): boolean {
    return this._daemonProcess !== null && !this._daemonProcess.killed;
  }

  transitionTo(state: DaemonState, process: any = undefined) {
    this._daemonState = state;
    if (process !== undefined) {
      this._daemonProcess = process;
    }
    if (state === "stopped" || state === "error") {
      this._daemonProcess = null;
    }
  }

  attachProcess(proc: any) {
    this._daemonProcess = proc;
    if (proc) {
      this._daemonState = "running";
    }
  }

  markProcessClosed(state: DaemonState = "stopped") {
    this._daemonProcess = null;
    this._daemonState = state;
  }

  killProcess() {
    if (!this.hasLiveProcess) {
      this.markProcessClosed("stopped");
      return false;
    }
    this._daemonProcess.kill();
    this.markProcessClosed("stopped");
    return true;
  }

  setDaemonProcess(proc: any) {
    this.attachProcess(proc);
  }

  clearDaemonProcess() {
    this.markProcessClosed("stopped");
  }

  // ----- Bridge Token -----

  get bridgeToken(): string | null {
    return this._bridgeToken;
  }

  set bridgeToken(value: string | null) {
    this._bridgeToken = value;
  }

  // ----- Handshake Cycle -----

  get handshake(): Readonly<HandshakeState> {
    return this._handshake;
  }

  get startPromptShown(): boolean {
    return this._handshake.startPromptShown;
  }

  set startPromptShown(value: boolean) {
    this._handshake.startPromptShown = value;
  }

  get offerRequested(): boolean {
    return this._handshake.offerRequested;
  }

  set offerRequested(value: boolean) {
    this._handshake.offerRequested = value;
  }

  get offerRequestInFlight(): boolean {
    return this._handshake.offerRequestInFlight;
  }

  set offerRequestInFlight(value: boolean) {
    this._handshake.offerRequestInFlight = value;
  }

  resetHandshakeCycle() {
    this._handshake.startPromptShown = false;
    this._handshake.offerRequested = false;
    this._handshake.offerRequestInFlight = false;
  }

  /**
   * Begin a new handshake cycle if the workspace/host/port key changed.
   * Returns true if the cycle was reset (new key).
   */
  beginHandshakeCycle(cycleKey: string | null): boolean {
    if (cycleKey === this._handshake.cycleKey) {
      return false;
    }
    this._handshake.cycleKey = cycleKey;
    this.resetHandshakeCycle();
    return true;
  }

  // ----- Sidebar Refresh Coordination -----

  get sidebarRefreshTimer(): ReturnType<typeof setTimeout> | null {
    return this._sidebarRefreshTimer;
  }

  set sidebarRefreshTimer(value: ReturnType<typeof setTimeout> | null) {
    this._sidebarRefreshTimer = value;
  }

  get sidebarRefreshInFlight(): Promise<void> | null {
    return this._sidebarRefreshInFlight;
  }

  set sidebarRefreshInFlight(value: Promise<void> | null) {
    this._sidebarRefreshInFlight = value;
  }

  clearSidebarRefreshTimer() {
    if (this._sidebarRefreshTimer) {
      clearTimeout(this._sidebarRefreshTimer);
      this._sidebarRefreshTimer = null;
    }
  }

  // ----- Degraded Session Tracking -----

  get lastDegradedNotifiedSessionId(): string | null {
    return this._lastDegradedNotifiedSessionId;
  }

  set lastDegradedNotifiedSessionId(value: string | null) {
    this._lastDegradedNotifiedSessionId = value;
  }

  // ----- Status summary (for status bar) -----

  statusBarInfo(sessionCount = 0) {
    if (this.hasLiveProcess) {
      return {
        text: sessionCount > 0
          ? `$(sync) Amarillo (${sessionCount})`
          : "$(radio-tower) Amarillo",
        tooltip: sessionCount > 0
          ? `${sessionCount} active session(s) - Click to open menu`
          : "Bridge online - Click to open menu"
      };
    }
    return {
      text: "$(debug-disconnect) Amarillo",
      tooltip: "Bridge offline - Click to open menu"
    };
  }

  // ----- Dispose -----

  dispose() {
    this.clearSidebarRefreshTimer();
    this.killProcess();
    this._bridgeToken = null;
    this.resetHandshakeCycle();
  }
}

// ----- Singleton instance -----
const bridgeState = new BridgeStateMachine();

module.exports = {
  BridgeStateMachine,
  bridgeState
};
