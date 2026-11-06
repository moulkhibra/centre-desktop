function createShutdownCoordinator(options) {
  const queue = options.queue;
  const requestRendererFlush = options.requestRendererFlush;
  const timeoutMs = options.timeoutMs;
  const onFailure = typeof options.onFailure === "function" ? options.onFailure : function () {};
  let started = null;

  function fail(code, error) {
    const result = { ok: false, code: code, error: error };
    try {
      onFailure(result);
    } catch (ignored) {}
    return result;
  }

  function start() {
    if (started) return started;
    started = (async function () {
      try {
        await requestRendererFlush();
      } catch (error) {}
      queue.startClosing();
      let drained;
      try {
        drained = await queue.drainUntilIdle(timeoutMs);
      } catch (error) {
        return fail("DRAIN_FAILED", "تعذر انتظار حفظ التغييرات. سيتم إغلاق التطبيق.");
      }
      if (!drained || !drained.ok) {
        return fail(
          (drained && drained.code) || "DRAIN_FAILED",
          (drained && drained.error) || "تعذر انتظار حفظ التغييرات. سيتم إغلاق التطبيق."
        );
      }
      return { ok: true };
    })();
    return started;
  }

  return {
    start: start,
    isStarted: function () {
      return started !== null;
    },
  };
}

module.exports = { createShutdownCoordinator: createShutdownCoordinator };
