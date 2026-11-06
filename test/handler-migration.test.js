const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const DV = require("../data-validation");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const requiredActions = [
  "go",
  "retry-load",
  "open-folder",
  "pick-file",
  "import-file",
  "restore-backup",
  "dash-month",
  "confirm-import",
  "cancel-import",
  "set-center-name",
  "set-logo",
  "remove-logo",
  "export",
  "show-backups",
  "add-student",
  "filter-students",
  "open-student",
  "back-to-students",
  "update-student",
  "ask-delete-student",
  "ask-delete-payment",
  "add-reg",
  "reg-activity",
  "reg-subject",
  "add-detail-payment",
  "detail-pay-reg",
  "detail-pay-months",
  "reg-date",
  "reg-fee",
  "toggle-reg",
  "receipt",
  "set-price",
  "toggle-subject-form",
  "subject-activity",
  "cancel-subject-form",
  "add-subject",
  "save-subject",
  "edit-subject",
  "ask-delete-subject",
  "set-template",
  "message-text",
  "message-filter",
  "attendance-date",
  "attendance-filter",
  "toggle-attendance",
  "pay-reg",
  "pay-months",
  "add-payment",
  "print",
  "close-receipt",
  "mark-sent",
];

function loadActions() {
  const cutoff = appSource.indexOf("bindEvents();");
  assert.ok(cutoff > 0, "bindEvents call not found");
  const source = appSource.slice(0, cutoff) +
    "\nglobalThis.__actions=ACTIONS;globalThis.__events=ACTION_EVENTS;";
  const context = {
    window: { DataValidation: DV },
    document: { body: {} },
    navigator: { userAgent: "node" },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    setTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app-actions.js" });
  return {
    actions: context.__actions,
    events: context.__events,
  };
}

test("index.html has no inline event handler attributes", () => {
  assert.equal(/\sonclick\s*=/i.test(html), false);
  assert.equal(/\sonchange\s*=/i.test(html), false);
  assert.equal(/\soninput\s*=/i.test(html), false);
});

test("index.html has no inline script block", () => {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    const openTag = /^<script\b([^>]*)>/i.exec(script)[1];
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    assert.match(openTag, /\bsrc\s*=/i, script);
    assert.equal(body, "", script);
  }
});

test("script-src no longer allows unsafe-inline", () => {
  const meta = /<meta[^>]+Content-Security-Policy[^>]+content="([^"]+)"/i.exec(html);
  assert.ok(meta, "CSP meta tag missing");
  assert.match(meta[1], /script-src 'self'/);
  assert.equal(/script-src[^;]*unsafe-inline/.test(meta[1]), false);
  const mainScriptLine = mainSource.split("\n").find((line) => line.includes("script-src"));
  assert.ok(mainScriptLine);
  assert.equal(mainScriptLine.includes("unsafe-inline"), false);
  assert.match(mainSource, /"script-src 'self'"/);
});

test("app.js is included in the packaged files", () => {
  assert.ok(pkg.build.files.includes("app.js"));
});

test("every migrated action has a working handler and a valid event type", () => {
  const { actions, events } = loadActions();
  const used = new Set();
  const normalized = appSource.replace(/\\"/g, '"');
  const matches = normalized.matchAll(/data-action="([a-z-]+)"/g);
  for (const match of matches) used.add(match[1]);

  assert.ok(used.size > 0);
  for (const action of requiredActions) {
    assert.equal(used.has(action), true, "missing data-action: " + action);
    assert.equal(typeof actions[action], "function", "missing handler: " + action);
  }
  for (const action of used) {
    assert.equal(typeof actions[action], "function", "missing handler: " + action);
  }
  for (const [action, type] of Object.entries(events)) {
    assert.equal(typeof actions[action], "function", "event action without handler: " + action);
    assert.ok(["click", "change", "input"].includes(type), "bad event type for " + action);
  }
});
