function createSaveQueue(saveFn) {
  let tail = Promise.resolve();
  let pending = 0;
  let waiters = [];
  let closing = false;

  function closingResult() {
    return {
      ok: false,
      code: "CLOSING",
      error: "التطبيق قيد الإغلاق. لم يتم حفظ أي تغيير.",
    };
  }

  function settle() {
    pending -= 1;
    if (pending !== 0) return;
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  }

  function run(task) {
    if (closing) return Promise.resolve(closingResult());
    pending += 1;
    const attempt = tail.then(async function () {
      try {
        return await task();
      } catch (error) {
        return {
          ok: false,
          code: "SAVE_FAILED",
          error: "تعذر حفظ المعطيات. لم يتم تعديل الملف الأصلي.",
        };
      }
    });
    tail = attempt.then(settle, settle);
    return attempt;
  }

  function enqueue(payload) {
    return run(function () {
      return saveFn(payload);
    });
  }

  function drain() {
    if (pending === 0) return Promise.resolve();
    return new Promise(function (resolve) {
      waiters.push(resolve);
    });
  }

  function isIdle() {
    return pending === 0;
  }

  async function drainUntilIdle(timeoutMs) {
    const draining = (async function () {
      while (pending > 0) {
        await drain();
      }
      return { ok: true };
    })();

    if (!(typeof timeoutMs === "number" && timeoutMs > 0)) return draining;

    let timer = null;
    const timeout = new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve({
          ok: false,
          code: "DRAIN_TIMEOUT",
          error: "انتهت مهلة انتظار حفظ التغييرات. سيتم إغلاق التطبيق.",
        });
      }, timeoutMs);
    });

    const result = await Promise.race([draining, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  function startClosing() {
    closing = true;
  }

  function isClosing() {
    return closing;
  }

  return {
    enqueue: enqueue,
    run: run,
    drain: drain,
    drainUntilIdle: drainUntilIdle,
    isIdle: isIdle,
    startClosing: startClosing,
    isClosing: isClosing,
  };
}

module.exports = { createSaveQueue: createSaveQueue };
