"use strict";

class SessionRegistry {
  app: any;

  constructor(app) {
    this.app = app;
  }

  list() {
    return Array.from(this.app.sessions.values());
  }

  get(sessionId) {
    return this.app.sessions.get(sessionId) || null;
  }

  close(sessionId) {
    return this.app.closeSession(sessionId);
  }
}

module.exports = {
  SessionRegistry
};
