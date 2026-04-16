import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as infra from "../src/core/infra";

// Use a separate test directory to avoid interfering with actual data
const TEST_HOME = join(tmpdir(), `autopilot-test-${Date.now()}`);

// Mock AUTOPILOT_HOME for testing
function setTestHome() {
  process.env.AUTOPILOT_HOME = TEST_HOME;
  if (!existsSync(TEST_HOME)) {
    mkdirSync(TEST_HOME, { recursive: true });
  }
}

function cleanTestHome() {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
}

describe("infra", () => {
  beforeEach(() => {
    setTestHome();
  });

  afterEach(() => {
    // Clean up any locks
    for (const [taskId] of Array.from((infra as any).activeLocks || new Map())) {
      infra.releaseLock(taskId);
    }
    cleanTestHome();
  });

  describe("getTaskDir", () => {
    test("creates and returns task directory", () => {
      const taskId = "test-task";
      const taskDir = infra.getTaskDir(taskId);

      expect(existsSync(taskDir)).toBe(true);
      expect(taskDir.endsWith(join("runtime", "tasks", taskId))).toBe(true);
    });

    test("returns same path if directory already exists", () => {
      const taskId = "existing-task";
      const taskDir1 = infra.getTaskDir(taskId);
      const taskDir2 = infra.getTaskDir(taskId);

      expect(taskDir1).toBe(taskDir2);
      expect(existsSync(taskDir1)).toBe(true);
    });

    test("rejects path traversal attempts", () => {
      expect(() => infra.getTaskDir("../etc/passwd")).toThrow();
      expect(() => infra.getTaskDir("..\\windows\\system32")).toThrow();
    });

    test("rejects task IDs with spaces", () => {
      expect(() => infra.getTaskDir("task with spaces")).toThrow();
    });

    test("rejects task IDs with special characters", () => {
      expect(() => infra.getTaskDir("task;rm -rf")).toThrow();
      expect(() => infra.getTaskDir("task&other")).toThrow();
      expect(() => infra.getTaskDir("task|pipe")).toThrow();
    });

    test("accepts valid task IDs with dots and dashes", () => {
      const taskDir1 = infra.getTaskDir("task.v1");
      const taskDir2 = infra.getTaskDir("my-task-123");

      expect(existsSync(taskDir1)).toBe(true);
      expect(existsSync(taskDir2)).toBe(true);
    });
  });

  describe("acquireLock", () => {
    test("successfully acquires lock on first call", () => {
      const result = infra.acquireLock("task-1");
      expect(result).toBe(true);
      expect(infra.isLocked("task-1")).toBe(true);
    });

    test("returns false when trying to acquire same lock twice", () => {
      infra.acquireLock("task-2");
      const secondAttempt = infra.acquireLock("task-2");
      expect(secondAttempt).toBe(false);
    });

    test("allows different tasks to acquire different locks", () => {
      const result1 = infra.acquireLock("task-a");
      const result2 = infra.acquireLock("task-b");

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(infra.isLocked("task-a")).toBe(true);
      expect(infra.isLocked("task-b")).toBe(true);
    });

    test("rejects invalid task IDs", () => {
      expect(() => infra.acquireLock("../etc")).toThrow();
      expect(() => infra.acquireLock("task with spaces")).toThrow();
    });
  });

  describe("releaseLock", () => {
    test("removes lock after release", () => {
      const taskId = "task-3";
      infra.acquireLock(taskId);
      expect(infra.isLocked(taskId)).toBe(true);

      infra.releaseLock(taskId);
      expect(infra.isLocked(taskId)).toBe(false);
    });

    test("allows re-acquiring lock after release", () => {
      const taskId = "task-4";

      // First acquisition and release
      const acq1 = infra.acquireLock(taskId);
      expect(acq1).toBe(true);
      infra.releaseLock(taskId);

      // Second acquisition should succeed
      const acq2 = infra.acquireLock(taskId);
      expect(acq2).toBe(true);
      expect(infra.isLocked(taskId)).toBe(true);

      infra.releaseLock(taskId);
    });

    test("handles release of non-existent lock gracefully", () => {
      // Should not throw
      expect(() => infra.releaseLock("non-existent")).not.toThrow();
      expect(infra.isLocked("non-existent")).toBe(false);
    });
  });

  describe("isLocked", () => {
    test("returns false for tasks without locks", () => {
      expect(infra.isLocked("unlocked-task")).toBe(false);
    });

    test("returns true for locked tasks", () => {
      infra.acquireLock("locked-task");
      expect(infra.isLocked("locked-task")).toBe(true);
    });

    test("returns false after lock is released", () => {
      const taskId = "temp-lock";
      infra.acquireLock(taskId);
      infra.releaseLock(taskId);
      expect(infra.isLocked(taskId)).toBe(false);
    });
  });

  describe("integration scenarios", () => {
    test("complete lock lifecycle", () => {
      const taskId = "lifecycle-task";

      // Initial state: unlocked
      expect(infra.isLocked(taskId)).toBe(false);

      // Acquire lock
      expect(infra.acquireLock(taskId)).toBe(true);
      expect(infra.isLocked(taskId)).toBe(true);

      // Cannot re-acquire
      expect(infra.acquireLock(taskId)).toBe(false);

      // Release lock
      infra.releaseLock(taskId);
      expect(infra.isLocked(taskId)).toBe(false);

      // Can acquire again
      expect(infra.acquireLock(taskId)).toBe(true);
      expect(infra.isLocked(taskId)).toBe(true);

      // Cleanup
      infra.releaseLock(taskId);
    });

    test("multiple independent locks", () => {
      const tasks = ["task-x", "task-y", "task-z"];

      // Acquire all locks
      for (const taskId of tasks) {
        expect(infra.acquireLock(taskId)).toBe(true);
      }

      // All should be locked
      for (const taskId of tasks) {
        expect(infra.isLocked(taskId)).toBe(true);
      }

      // Release in different order
      infra.releaseLock("task-y");
      expect(infra.isLocked("task-y")).toBe(false);
      expect(infra.isLocked("task-x")).toBe(true);
      expect(infra.isLocked("task-z")).toBe(true);

      // Cleanup
      infra.releaseLock("task-x");
      infra.releaseLock("task-z");
    });

    test("task directory and locks are independent", () => {
      const taskId = "combo-task";

      // Create directory
      const taskDir = infra.getTaskDir(taskId);
      expect(existsSync(taskDir)).toBe(true);

      // Acquire lock (separate from directory)
      expect(infra.acquireLock(taskId)).toBe(true);

      // Directory should still exist after locking
      expect(existsSync(taskDir)).toBe(true);

      // Release lock
      infra.releaseLock(taskId);

      // Directory should still exist after unlocking
      expect(existsSync(taskDir)).toBe(true);
    });
  });
});
