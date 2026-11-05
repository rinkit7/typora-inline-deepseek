import test from "node:test";
import assert from "node:assert/strict";
import { buildWebQuestion, canInsertAtSnapshot, fillWebComposer, readWebAnswer, submitWebComposer } from "../src/web-provider.js";

test("question includes selected context without changing source text", () => {
  const text = "a < b\n$x^2$";
  const prompt = buildWebQuestion(text, "解释公式");
  assert.ok(prompt.includes(text));
  assert.ok(prompt.endsWith("问题：解释公式"));
  assert.equal(buildWebQuestion("", "  你好  "), "你好");
  assert.throws(() => buildWebQuestion(text, "  "), /请输入问题/);
});

test("insertion rejects changed documents and changed content", () => {
  const target = { key: "first", document: "original" };
  assert.equal(canInsertAtSnapshot(target, { key: "first" }, "original"), true);
  assert.equal(canInsertAtSnapshot(target, { key: "second" }, "original"), false);
  assert.equal(canInsertAtSnapshot(target, { key: "first" }, "changed"), false);
  assert.equal(canInsertAtSnapshot(null, { key: "first" }, "original"), false);
});

test("composer reports login required and dispatches controlled textarea input", () => {
  const oldDocument = globalThis.document, oldTextarea = globalThis.HTMLTextAreaElement;
  const events = [];
  class Textarea { set value(v) { this.text = v; } }
  const input = new Textarea();
  input.dispatchEvent = e => events.push(e.type);
  input.focus = () => events.push("focus");
  try {
    globalThis.HTMLTextAreaElement = Textarea;
    globalThis.document = { querySelector: () => null };
    assert.equal(fillWebComposer("test").ok, false);
    globalThis.document = { querySelector: () => input };
    assert.equal(fillWebComposer("selected context").ok, true);
    assert.equal(input.text, "selected context");
    assert.deepEqual(events, ["input", "change", "focus"]);
  } finally { globalThis.document = oldDocument; globalThis.HTMLTextAreaElement = oldTextarea; }
});

test("answer extraction returns the latest rendered answer and handles no answer", () => {
  const oldDocument = globalThis.document;
  try {
    globalThis.document = { querySelectorAll: () => [] };
    assert.equal(readWebAnswer(), "");
    globalThis.document = { querySelectorAll: () => [{ innerText: "old" }, { innerText: " new response " }] };
    assert.equal(readWebAnswer(), "new response");
  } finally { globalThis.document = oldDocument; }
});

test("submission skips disabled/stop buttons, clicks send once and confirms input clearing", async () => {
  const oldDocument = globalThis.document;
  let clicks = 0;
  const input = { value: "question", isConnected:true };
  const makeButton = (label, disabled = false) => ({
    disabled, classList:{ contains:() => false }, getBoundingClientRect:() => ({width:30,height:30}),
    getAttribute:key => key === "aria-label" ? label : "",
    click:() => { clicks++; input.value = ""; }
  });
  input.parentElement = { parentElement:null, querySelector:() => null,
    querySelectorAll:() => [makeButton("Send", true), makeButton("Stop sending"), makeButton("Send")] };
  try {
    globalThis.document = { querySelector:() => input, body:{} };
    assert.equal((await submitWebComposer()).ok, true);
    assert.equal(clicks, 1);
  } finally { globalThis.document = oldDocument; }
});

test("submission recognizes DeepSeek's upload-adjacent button", async () => {
  const oldDocument = globalThis.document;
  const input = { value:"test", isConnected:true };
  const button = { disabled:false, classList:{contains:() => false}, getBoundingClientRect:() => ({width:30,height:30}),
    getAttribute:() => "", click:() => { input.value = ""; } };
  input.parentElement = { parentElement:null, querySelectorAll:() => [],
    querySelector:selector => selector.includes('input[type="file"]') ? button : null };
  try {
    globalThis.document = { querySelector:() => input, body:{} };
    assert.equal((await submitWebComposer()).ok, true);
  } finally { globalThis.document = oldDocument; }
});

test("submission recognizes the current unlabelled DeepSeek circular send button", async () => {
  const oldDocument = globalThis.document;
  let clicks = 0;
  const input = { value:"test", isConnected:true };
  const button = { disabled:false, classList:{contains:() => false}, getBoundingClientRect:() => ({width:32,height:32}),
    getAttribute:() => "", click:() => { clicks++; input.value = ""; } };
  input.parentElement = { parentElement:null, querySelectorAll:() => [],
    querySelector:selector => selector.includes('.ds-button--primary') ? button : null };
  try {
    globalThis.document = { querySelector:() => input, body:{} };
    assert.equal((await submitWebComposer()).ok, true);
    assert.equal(clicks, 1);
  } finally { globalThis.document = oldDocument; }
});
