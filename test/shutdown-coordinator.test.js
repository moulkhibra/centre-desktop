const test = require("node:test");
const assert = require("node:assert/strict");
const { createSaveQueue } = require("../save-queue");
const { createShutdownCoordinator } = require("../shutdown-coordinator");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controlledFlush() {
  let release;
  let calls = 0;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {
    get calls() { return calls; },
    request() {
      calls += 1;
      return promise;
    },
    release,
  };
}

test("shutdown flushes the renderer before closing the save queue", async () => {
  const events = [];
  let release;
  const queue = {
    startClosing() { events.push("closing"); },
    drainUntilIdle() {
      events.push("drain");
      return Promise.resolve({ ok: true });
    },
  };
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush() {
      events.push("flush");
      return new Promise((resolve) => { release = resolve; });
    },
    timeoutMs: 1000,
  });

  const shutdown = coordinator.start();
  assert.deepEqual(events, ["flush"]);
  release();
  const result = await shutdown;

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["flush", "closing", "drain"]);
});

test("a save accepted just before close finishes before the queue starts closing", async () => {
  const applied = [];
  const queue = createSaveQueue(async (value) => {
    await delay(5);
    applied.push(value);
    return { ok: true, value: value };
  });
  const flush = controlledFlush();
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: flush.request,
    timeoutMs: 1000,
  });

  const first = queue.enqueue("before-close");
  const shutdown = coordinator.start();
  await delay(1);
  assert.equal(queue.isClosing(), false);

  const duringFlush = queue.enqueue("renderer-flush");
  flush.release();
  const results = await Promise.all([first, duringFlush, shutdown]);

  assert.deepEqual(applied, ["before-close", "renderer-flush"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
  assert.equal(queue.isClosing(), true);
  assert.equal(queue.isIdle(), true);
});

test("repeated close requests share one shutdown and one renderer flush", async () => {
  const queue = createSaveQueue(async () => ({ ok: true }));
  const flush = controlledFlush();
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: flush.request,
    timeoutMs: 1000,
  });

  const first = coordinator.start();
  const second = coordinator.start();
  const third = coordinator.start();
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(flush.calls, 1);

  flush.release();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assert.equal(flush.calls, 1);
  assert.equal(coordinator.start(), first);
});

test("a delayed renderer action can still submit its save during the flush", async () => {
  const saved = [];
  const queue = createSaveQueue(async (value) => {
    saved.push(value);
    return { ok: true, value: value };
  });
  const flush = controlledFlush();
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: flush.request,
    timeoutMs: 1000,
  });

  const shutdown = coordinator.start();
  await delay(5);
  assert.equal(queue.isClosing(), false);

  const delayedSave = queue.enqueue("delayed-action");
  await delay(5);
  assert.equal(queue.isClosing(), false);
  assert.deepEqual(saved, ["delayed-action"]);

  flush.release();
  const result = await shutdown;
  const saveResult = await delayedSave;
  assert.equal(result.ok, true);
  assert.equal(saveResult.ok, true);
  assert.deepEqual(saved, ["delayed-action"]);
});

test("a save failure during shutdown is returned and does not drop later accepted saves", async () => {
  const message = "تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.";
  const queue = createSaveQueue(async (value) => {
    if (value === "bad") return { ok: false, code: "WRITE_FAILED", error: message };
    return { ok: true, value: value };
  });
  const flush = controlledFlush();
  const failures = [];
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: flush.request,
    timeoutMs: 1000,
    onFailure(result) { failures.push(result); },
  });

  const shutdown = coordinator.start();
  const failed = queue.enqueue("bad");
  const good = queue.enqueue("good");
  flush.release();

  const [failedResult, goodResult, shutdownResult] = await Promise.all([failed, good, shutdown]);
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.code, "WRITE_FAILED");
  assert.match(failedResult.error, /تعذر حفظ المعطيات/);
  assert.equal(goodResult.ok, true);
  assert.equal(shutdownResult.ok, true);
  assert.equal(failures.length, 0);
  assert.equal(queue.isIdle(), true);
});

test("shutdown reports a drain timeout and does not hang", async () => {
  const queue = createSaveQueue(() => new Promise(() => {}));
  const failures = [];
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: () => Promise.resolve(),
    timeoutMs: 25,
    onFailure(result) { failures.push(result); },
  });

  queue.enqueue("stuck");
  const started = Date.now();
  const result = await coordinator.start();

  assert.equal(result.ok, false);
  assert.equal(result.code, "DRAIN_TIMEOUT");
  assert.match(result.error, /مهلة/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DRAIN_TIMEOUT");
  assert.equal(queue.isClosing(), true);
  assert.ok(Date.now() - started >= 15);
});

test("a renderer flush error still allows accepted saves to drain", async () => {
  const queue = createSaveQueue(async () => ({ ok: true }));
  const coordinator = createShutdownCoordinator({
    queue: queue,
    requestRendererFlush: () => Promise.reject(new Error("renderer gone")),
    timeoutMs: 1000,
  });

  const save = queue.enqueue("accepted");
  const result = await coordinator.start();
  assert.equal(result.ok, true);
  assert.equal((await save).ok, true);
  assert.equal(queue.isIdle(), true);
});
