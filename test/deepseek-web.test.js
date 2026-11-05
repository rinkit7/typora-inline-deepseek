import test from "node:test";
import assert from "node:assert/strict";
import {browserEnvironment} from "./helpers/browser-env.js";
import {inspectDeepSeekReply,createDeepSeekWeb} from "../src/deepseek-web.js";

test("geometry gestures suspend answer extraction without clearing the user's pause or publishing an in-flight read", async () => {
  let finishRead, reads = 0;
  const replies = [], listeners = new Map();
  const page = {addEventListener:(name,fn) => listeners.set(name,fn),removeEventListener:name => listeners.delete(name),getURL:() => "https://chat.deepseek.com/",
    executeJavaScript:async () => {reads++; return new Promise(resolve => {finishRead = resolve;});}};
  const adapter = createDeepSeekWeb({webview:page,interval:60000});
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  try {
    adapter.subscribe(reply => replies.push(reply));
    adapter.setActive(true); await tick();
    assert.equal(reads,1);
    adapter.setSuspended(true);
    finishRead({text:"deferred while dragging"}); await tick();
    assert.deepEqual(replies,[]);
    await adapter.poll(); assert.equal(reads,1);
    adapter.setPaused(true);
    adapter.setSuspended(false); await tick();
    assert.equal(reads,1,"ending a gesture must retain a manual pause");
    adapter.setPaused(false); await tick();
    assert.equal(reads,2);
    finishRead({text:"latest answer"}); await tick();
    assert.deepEqual(replies,[{text:"latest answer"}]);
  } finally {adapter.dispose();}
});

test("DeepSeek extraction preserves Markdown and math while excluding executable HTML and URLs", () => {
  const env = browserEnvironment('<body><div class="ds-markdown"><p>A <strong>bold</strong> answer <a href="javascript:attack()">link text</a></p><pre><code>const x = `value`</code></pre><span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>secret code</script><img src="secret url"></div><div><textarea></textarea><button class="ds-button--primary ds-button--filled ds-button--circle ds-button--disabled"></button></div></body>');
  try {
    const pre = env.document.querySelector("pre"); pre.innerText = pre.textContent;
    const result = inspectDeepSeekReply();
    assert.match(result.text,/\*\*bold\*\*/); assert.match(result.text,/```/); assert.match(result.text,/\$x\^2\$/);
    assert.match(result.text,/\| A \| B \|/); assert.match(result.text,/\| 1 \| 2 \|/);
    for (const text of ["secret code","secret url","javascript:attack","<script>"]) assert.equal(result.text.includes(text),false);
    assert.equal(result.generating,false);
    const button = env.document.querySelector("button"); button.classList.remove("ds-button--disabled"); button.getBoundingClientRect = () => ({width:30,height:30});
    assert.equal(inspectDeepSeekReply().generating,true,"an enabled unlabelled stop circle must block another submission");
    env.document.querySelector("textarea").value = "draft";
    assert.equal(inspectDeepSeekReply().generating,false);
  } finally {env.dispose();}
});

test("the web adapter checks generation before filling and never retries an ambiguous send", async () => {
  const listeners = new Map(), calls = [];
  let generating = true, confirmed = true;
  const page = {addEventListener:(name,fn) => listeners.set(name,fn),removeEventListener:name => listeners.delete(name),getURL:() => "https://chat.deepseek.com/",executeJavaScript:async code => {
    if (code.includes("inspectWebPageReady")) return true;
    if (code.includes("inspectDeepSeekReply")) return {count:1,text:"old",generating};
    if (code.includes("fillWebComposer")) {calls.push("fill"); return {ok:true};}
    if (code.includes("submitWebComposer")) {calls.push("send"); return {ok:confirmed,reason:"not confirmed"};}
    throw Error("unexpected script");
  }};
  const adapter = createDeepSeekWeb({webview:page,interval:60000});
  try {
    await assert.rejects(adapter.send("question"),/上一条/); assert.deepEqual(calls,[]);
    generating = false;
    const result = await adapter.send("question"); assert.equal(result.baseline.text,"old"); assert.deepEqual(calls,["fill","send"]);
    calls.length = 0; confirmed = false;
    await assert.rejects(adapter.send("question"),/not confirmed/); assert.deepEqual(calls,["fill","send"]);
  } finally {adapter.dispose(); assert.equal(listeners.size,0);}
});

test("web citation markers are stripped while real ranges survive", () => {
  const env = browserEnvironment('<body><div class="ds-markdown"><p>它是一家公司。 -2-4-10</p><p>成立于 2023 年。 -7</p><p>时间范围是 2024-2025</p></div><div><textarea></textarea></div></body>');
  try {
    const result = inspectDeepSeekReply();
    assert.equal(result.text.includes("-2-4-10"),false,"multi part markers must go");
    assert.equal(result.text.includes(" -7"),false,"single markers must go");
    assert.equal(result.text.includes("2024-2025"),true,"real number ranges must survive");
    assert.match(result.text,/它是一家公司。/);
    assert.match(result.text,/成立于 2023 年。/);
  } finally {env.dispose();}
});
