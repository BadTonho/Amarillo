"use strict";

class SyncCoordinator {
  app: any;

  constructor(app) {
    this.app = app;
  }

  enqueueCommand(...args) {
    return this.app.enqueueCommand(...args);
  }

  scheduleProjectTreeApply(...args) {
    return this.app.scheduleProjectTreeApply(...args);
  }

  scheduleStudioSnapshotWrite(...args) {
    return this.app.scheduleStudioSnapshotWrite(...args);
  }
}

module.exports = {
  SyncCoordinator
};
