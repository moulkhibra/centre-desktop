const test = require("node:test");
const assert = require("node:assert/strict");
const { createSaveQueue } = require("../save-queue");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("three quick saves run in order and the last one wins", async () => {
  const applied = [];
  let current = null;

  const queue = createSaveQueue(async (value) => {
    await delay(value.delay);
    applied.push(value.id);
    current = value.id;
    return { ok: true, id: value.id };
  });

  const first = queue.enqueue({ id: "one", delay: 30 });
  const second = queue.enqueue({ id: "two", delay: 1 });
  const third = queue.enqueue({ id: "three", delay: 10 });

  assert.equal(queue.isIdle(), false);
  const results = await Promise.all([first, second, third]);

  assert.deepEqual(applied, ["one", "two", "three"]);
  assert.equal(current, "three");
  assert.deepEqual(results.map((result) => result.id), ["one", "two", "three"]);
  assert.equal(queue.isIdle(), true);
});

test("a failed save does not stop later saves and returns the Arabic error", async () => {
  const applied = [];
  let count = 0;

  const queue = createSaveQueue(async (value) => {
    count += 1;
    if (count === 1) return { ok: false, code: "INVALID_JSON", error: "ملف المعطيات الحالي غير صالح." };
    if (count === 2) throw new Error("disk exploded");
    applied.push(value);
    return { ok: true, value: value };
  });

  const first = await queue.enqueue("one");
  const second = await queue.enqueue("two");
  const third = await queue.enqueue("three");

  assert.equal(first.ok, false);
  assert.equal(first.code, "INVALID_JSON");
  assert.match(first.error, /غير صالح/);
  assert.equal(second.ok, false);
  assert.equal(second.code, "SAVE_FAILED");
  assert.match(second.error, /تعذر حفظ المعطيات/);
  assert.equal(third.ok, true);
  assert.deepEqual(applied, ["three"]);
  assert.equal(queue.isIdle(), true);
});

test("closing waits for in-flight saves to drain", async () => {
  let finished = 0;
  const queue = createSaveQueue(async (value) => {
    await delay(10);
    finished += 1;
    return { ok: true, value: value };
  });

  queue.enqueue("one");
  queue.enqueue("two");
  queue.enqueue("three");

  const draining = queue.drain();
  assert.equal(queue.isIdle(), false);
  assert.equal(finished, 0);

  await draining;
  assert.equal(finished, 3);
  assert.equal(queue.isIdle(), true);
});

test("draining an idle queue resolves immediately", async () => {
  const queue = createSaveQueue(async () => ({ ok: true }));
  await queue.drain();
  assert.equal(queue.isIdle(), true);
});

function savedData(name) {
  return {
    students: [{ id: "s1", name: name, phone: "", lvl: "", note: "", date: "2026-01-01" }],
    regs: [],
    att: {},
    pays: [],
    prices: {},
    cfg: { name: "المركز", logo: "" },
  };
}

test("a queued restore waits for an in-flight save and runs in order", async () => {
  const order = [];
  let release = null;
  const queue = createSaveQueue(async (payload) => {
    order.push("save-start");
    await new Promise((resolve) => { release = resolve; });
    order.push("save-end");
    return { ok: true, payload };
  });

  const save = queue.enqueue("data");
  const restore = queue.run(async () => {
    order.push("restore");
    return { ok: true };
  });

  await delay(5);
  assert.deepEqual(order, ["save-start"]);
  release();
  await save;
  await restore;
  assert.deepEqual(order, ["save-start", "save-end", "restore"]);
});

test("once closing starts new saves and tasks are rejected in Arabic", async () => {
  let calls = 0;
  const queue = createSaveQueue(async () => {
    calls += 1;
    return { ok: true };
  });

  queue.startClosing();
  assert.equal(queue.isClosing(), true);

  const save = await queue.enqueue("data");
  const task = await queue.run(async () => {
    calls += 1;
    return { ok: true };
  });

  assert.equal(save.ok, false);
  assert.equal(save.code, "CLOSING");
  assert.match(save.error, /قيد الإغلاق/);
  assert.equal(task.ok, false);
  assert.equal(task.code, "CLOSING");
  assert.equal(calls, 0);
});

test("drainUntilIdle waits for all queued work before resolving", async () => {
  let finished = 0;
  const queue = createSaveQueue(async () => {
    await delay(10);
    finished += 1;
    return { ok: true };
  });

  queue.enqueue("one");
  queue.enqueue("two");
  queue.startClosing();

  await queue.drainUntilIdle();
  assert.equal(finished, 2);
  assert.equal(queue.isIdle(), true);
});

test("drainUntilIdle returns a timeout error instead of hanging", async () => {
  const queue = createSaveQueue(() => new Promise(() => {}));
  queue.enqueue("stuck");
  queue.startClosing();

  const started = Date.now();
  const result = await queue.drainUntilIdle(25);

  assert.equal(result.ok, false);
  assert.equal(result.code, "DRAIN_TIMEOUT");
  assert.match(result.error, /مهلة/);
  assert.ok(Date.now() - started >= 15);
});

test("draining on close persists the last of three quick saves", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createStore } = require("../data-store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "centre-queue-"));

  try {
    const store = createStore({ dir, now: () => new Date(2026, 0, 1, 10, 0, 0, 0) });
    store.ensureDir();
    const queue = createSaveQueue(async (json) => {
      await delay(5);
      return store.save(json);
    });

    queue.enqueue(JSON.stringify(savedData("الأول")));
    queue.enqueue(JSON.stringify(savedData("الثاني")));
    queue.enqueue(JSON.stringify(savedData("الثالث")));
    await queue.drain();

    const reopened = createStore({ dir });
    const loaded = reopened.load();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.data.students[0].name, "الثالث");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
