import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerDeepSeekMenu } from "../src/web-provider.js";

test("DeepSeek extends the original menu and leaves copy/paste directly available", () => {
  let listener, disposed = false, opened, closed = false;
  const workspace = { on(name, callback) {
    assert.equal(name, "editor-menu"); listener = callback;
    return () => { disposed = true; };
  } };
  const copy = { key:"copy", action:() => "copied" }, paste = { key:"paste", action:() => "pasted" };
  const items = [copy, paste];
  const menu = {
    addSeparator() { items.push({ separator:true }); },
    addItem(build) {
      const item = {
        setKey(key) { this.key = key; return this; },
        setTitle(title) { this.title = title; return this; },
        onClick(action) { this.action = action; return this; }
      };
      build(item); items.push(item);
    },
    close() { closed = true; }
  };
  let selected = "original selection";
  const dispose = registerDeepSeekMenu(workspace, () => ({text:selected}), target => { opened = target; });
  listener({menu});
  selected = "selection after clicking the menu";
  assert.equal(items[0], copy);
  assert.equal(items[1], paste);
  assert.equal(copy.action(), "copied");
  assert.equal(paste.action(), "pasted");
  assert.equal(items.length, 4);
  const ask = items[3];
  assert.equal(ask.title, "✦ DeepSeek 问答");
  ask.action({ preventDefault() {} });
  assert.equal(closed, true);
  assert.equal(opened.text, "original selection");
  dispose(); assert.equal(disposed, true);
});

test("active plugin entry does not load GPT, OAuth, API, provider settings or legacy chat modules", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const visited = new Set();
  const forbidden = new Set(["plugin.js", "api.js", "platform.js", "config.js", "settings-tab.js", "chat-panel.js", "chat-service.js", "chat-store.js", "editor.js", "document-identity.js", "ui.js", "i18n.js"]);
  for (const name of forbidden) assert.equal(fs.existsSync(path.join(root,"src",name)),false,`${name} must not remain in the independent project`);
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.equal(forbidden.has(path.basename(file)), false, `${path.basename(file)} is still active`);
    for (const match of fs.readFileSync(file,"utf8").matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      visit(path.resolve(path.dirname(file),match[1]));
    }
  }
  visit(path.join(root,"main.js"));
  assert.ok([...visited].some(file => path.basename(file) === "deepseek-plugin.js"));
});
