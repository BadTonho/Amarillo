"use strict";

const { performance } = require("node:perf_hooks");
const { writeStudioProjectStateAsync } = require("../project");

class StudioSnapshotWriter {
  pendingWrites: Map<string, any>;
  app: any;
  logSync: (event: string, details?: Record<string, unknown>) => void;
  initialStudioSyncReason: string;

  constructor(options: { app: any; logSync: (event: string, details?: Record<string, unknown>) => void; initialStudioSyncReason: string }) {
    this.app = options.app;
    this.logSync = options.logSync;
    this.initialStudioSyncReason = options.initialStudioSyncReason;
    this.pendingWrites = new Map();
  }

  schedule(session, reason, writeNow) {
    const sessionId = session.id;
    const delayMs = writeNow ? 0 : 300;
    const existing = this.pendingWrites.get(sessionId);

    if (existing) {
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      existing.reason = reason;
      existing.snapshotHash = session.lastStudioHash || null;
      existing.updatedAt = Date.now();
      existing.timer = setTimeout(() => {
        void this.flush(sessionId);
      }, delayMs);
      if (typeof existing.timer.unref === "function") {
        existing.timer.unref();
      }
      this.logSync("disk_write_coalesced", {
        sessionId,
        reason,
        snapshotHash: existing.snapshotHash,
        delayMs
      });
      return existing.promise;
    }

    let resolveWrite: () => void = () => {};
    const job: any = {
      sessionId,
      reason,
      snapshotHash: session.lastStudioHash || null,
      queuedAt: Date.now(),
      updatedAt: Date.now(),
      timer: null,
      running: false,
      promise: new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
      resolve: resolveWrite
    };

    job.timer = setTimeout(() => {
      void this.flush(sessionId);
    }, delayMs);
    if (typeof job.timer.unref === "function") {
      job.timer.unref();
    }
    this.pendingWrites.set(sessionId, job);
    this.logSync("disk_write_scheduled", {
      sessionId,
      reason,
      snapshotHash: job.snapshotHash,
      delayMs
    });
    return job.promise;
  }

  async flush(sessionId) {
    const job = this.pendingWrites.get(sessionId);
    if (!job) {
      return Promise.resolve();
    }
    if (job.running) {
      return job.promise;
    }
    job.running = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    const session = this.app.sessions.get(sessionId);
    const reason = job.reason;
    let didStartDiskWrite = false;
    try {
      const project = session ? this.app.getProjectById(session.projectId) : null;
      if (!session || !project || !session.lastStudioSnapshot) {
        this.logSync("disk_write_skipped", {
          sessionId,
          reason: !session ? "no_session" : (project ? "no_snapshot" : "no_project"),
          requestedReason: reason
        });
        return job.promise;
      }

      const startedAt = Date.now();
      const perfStartedAt = performance.now();
      this.logSync("disk_write_start", {
        sessionId,
        reason,
        snapshotHash: session.lastStudioHash
      });
      this.app.lastDiskWriteTime = Date.now();
      didStartDiskWrite = true;
      let changes = [];
      try {
        changes = await writeStudioProjectStateAsync(project, session.lastStudioSnapshot, {
          onFileChange: (change) => {
            this.app.recordActivity(change, {
              direction: "studio_to_pc",
              source: "studio_snapshot",
              reason,
              sessionId
            });
          }
        });
      } catch (error) {
        if (typeof this.app.recordPerformance === "function") {
          this.app.recordPerformance("studio_snapshot.write.duration", performance.now() - perfStartedAt);
        }
        this.app.markSyncDegraded(session, `Failed to write Studio snapshot to disk: ${error.message}`, {
          code: "DISK-WRITE",
          observedHash: session.lastStudioHash || null
        });
        this.app.recordError({
          component: "daemon",
          severity: "error",
          code: "DISK-WRITE",
          message: error.message,
          sessionId,
          projectId: project.id,
          context: { reason },
          stack: error.stack
        });
        return job.promise;
      }

      session.lastAppliedAt = new Date().toISOString();
      if (reason === "manual" || reason === this.initialStudioSyncReason) {
        this.app.markSyncVerified(session, session.lastStudioHash);
      }
      if (reason === this.initialStudioSyncReason || (session.connectionState !== "ready" && session.truthSource === "studio")) {
        this.app.markSessionReady(session, reason);
      }
      this.logSync("disk_write_complete", {
        sessionId,
        timestamp: session.lastAppliedAt,
        durationMs: Date.now() - startedAt,
        changedFiles: changes.length
      });
      if (typeof this.app.recordPerformance === "function") {
        this.app.recordPerformance("studio_snapshot.write.duration", performance.now() - perfStartedAt);
      }
    } finally {
      if (didStartDiskWrite) {
        this.app.lastDiskWriteTime = Date.now();
      }
      if (this.pendingWrites.get(sessionId) === job) {
        this.pendingWrites.delete(sessionId);
      }
      job.resolve();
    }

    return job.promise;
  }

  async drain(timeoutMs = 5000) {
    const jobs = Array.from(this.pendingWrites.values());
    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      void this.flush(job.sessionId);
    }

    await Promise.race([
      Promise.all(jobs.map((job) => job.promise)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }
}

module.exports = {
  StudioSnapshotWriter
};
