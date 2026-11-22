// Injected into the page before the app loads (Playwright addInitScript):
// window.__TAURI_INTERNALS__ forwarding invoke() to tests/browser/fake-tauri.ts.
(() => {
  const port = window.__FAKE_TAURI_PORT__ || 1430;
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(cb) {
      const id = next++;
      window[`_${id}`] = cb;
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, args: args ?? {} }),
      });
      const body = await res.json();
      if ("err" in body) throw new Error(body.err);
      return body.ok;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
