import test from "node:test";
import assert from "node:assert/strict";
import { createWebviewLifecycle, fillWebComposer } from "../src/web-provider.js";

function createFakePage() {
  const listeners = new Map();
  let documentReady = true, reloads = 0;
  return {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    executeJavaScript:async () => documentReady,
    reload() { reloads++; },
    emit(name, event = {}) { listeners.get(name)?.(event); },
    setReady(value) { documentReady = value; },
    get reloads() { return reloads; },
    get listenerCount() { return listeners.size; }
  };
}

test("second question recovers a stale loading flag without dom-ready or refreshing", async () => {
  const page = createFakePage();
  let ready = false;
  const lifecycle = createWebviewLifecycle(page, state => { ready = state.ready; });
  await lifecycle.ensureReady();
  assert.equal(ready, true);
  // DeepSeek changes its URL after the first submission; no new DOM-ready follows.
  page.emit("did-start-loading");
  assert.equal(ready, false);
  await lifecycle.ensureReady();
  assert.equal(ready, true);
  assert.equal(page.reloads, 0);
  lifecycle.dispose();
});

test("load completion and same-document navigation restore readiness", async () => {
  const page = createFakePage();
  let ready = false;
  const lifecycle = createWebviewLifecycle(page, state => { ready = state.ready; });
  for (const event of ["did-stop-loading", "did-navigate-in-page", "did-finish-load"]) {
    page.emit("did-start-loading");
    assert.equal(ready, false);
    page.emit(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, true, event);
  }
  lifecycle.dispose();
  assert.equal(page.listenerCount, 0);
});

test("a send waits through a real navigation and preserves the conversation", async () => {
  const page = createFakePage();
  page.setReady(false);
  let pauses = 0;
  const lifecycle = createWebviewLifecycle(page, () => {}, {
    attempts:3, pause:async () => { pauses++; page.setReady(true); }
  });
  await lifecycle.ensureReady();
  assert.equal(pauses, 1);
  assert.equal(page.reloads, 0);
  lifecycle.dispose();
});

test("a genuinely unavailable page reports loading, not lost login", async () => {
  const page = createFakePage();
  page.setReady(false);
  const lifecycle = createWebviewLifecycle(page, () => {}, {attempts:2, pause:async () => {}});
  await assert.rejects(lifecycle.ensureReady(), error => error.message.includes("仍在加载") && !error.message.includes("登录"));
  assert.equal(page.reloads, 0);
  lifecycle.dispose();
});

test("disabled composer during generation does not ask the user to log in again", () => {
  const oldDocument = globalThis.document;
  try {
    globalThis.document = {querySelector:selector => selector === 'textarea[disabled]' ? {disabled:true} : null};
    const result = fillWebComposer("follow-up question");
    assert.equal(result.ok, false);
    assert.match(result.reason, /回答尚未结束/);
    assert.doesNotMatch(result.reason, /登录/);
  } finally { globalThis.document = oldDocument; }
});
