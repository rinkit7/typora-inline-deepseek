import test from "node:test";
import assert from "node:assert/strict";
import {browserEnvironment} from "./helpers/browser-env.js";
import {inspectDeepSeekReply,inspectDeepSeekReplyBuilder,createDeepSeekWeb} from "../src/deepseek-web.js";

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

test("code toolbars become fenced language metadata without altering code or nearby prose", () => {
  const env = browserEnvironment('<body><div class="ds-markdown"><p>点击复制下载；以下是示例。 -7</p><div><div><span>csharp</span><div role="button">复制</div><div role="button">下载</div></div><pre><code class="language-csharp"></code></pre></div><div><div>python Copy Download</div><pre><code></code></pre></div><pre><code class="language-text"></code></pre><p>普通正文中的 csharp复制下载 应保留。</p></div></body>');
  try {
    const codes = [...env.document.querySelectorAll("code")];
    codes[0].textContent = '[Required(ErrorMessage = "请输入电影名称")]\n  public string? Title { get; set; }\n';
    codes[1].textContent = 'print("复制下载")\nvalue = " -7"\n';
    codes[2].textContent = '```\n<script>literal code</script>\n';
    const {text} = inspectDeepSeekReply();
    assert.ok(text.includes('```csharp\n'+codes[0].textContent+'```'));
    assert.ok(text.includes('```python\n'+codes[1].textContent+'```'));
    assert.ok(text.includes('````text\n'+codes[2].textContent+'````'));
    assert.ok(!text.includes('csharp复制下载\n'));
    assert.ok(!text.includes('Copy Download'));
    assert.ok(text.includes('点击复制下载；以下是示例。'));
    assert.ok(text.includes('普通正文中的 csharp复制下载 应保留。'));
    assert.ok(!text.includes('示例。 -7'));
    const isolated = new Function('document',`return (${inspectDeepSeekReplyBuilder.toString()})().reply()`)(env.document);
    assert.equal(isolated.text,text,"the serialized extractor must work in the isolated webpage");
  } finally {env.dispose();}
});

test("conversation extraction restores every user question and assistant answer in page order", () => {
  const env = browserEnvironment('<body><div id="chat">'
    + '<div class="group"><div class="bubble">第一段提问内容</div><div class="answer"><div class="ds-markdown"><p>第一段回答内容。</p></div></div></div>'
    + '<div class="group"><div class="bubble">复制<br/>真正的提问<br/>已深度思考（用时6秒）</div><div class="answer"><span class="ds-markdown"><p>第二段回答 -2-4-10</p></span></div></div>'
    + '<div class="group"><div class="ds-markdown"><p>第三段回答，没有提问。</p></div></div>'
    + '</div><div><textarea></textarea></div></body>');
  try {
    const result = inspectDeepSeekReplyBuilder().conversation();
    assert.deepEqual(result.messages.map(message => [message.role,message.text]),[
      ["user","第一段提问内容"],
      ["assistant","第一段回答内容。"],
      ["user","真正的提问"],
      ["assistant","第二段回答"],
      ["assistant","第三段回答，没有提问。"],
    ],"page furniture lines and citation markers must be dropped, questions kept in order");
    assert.equal(result.loggedIn,true);
    assert.equal(result.generating,false);
    // The newest answer read by the poll must be byte-identical to the last
    // restored assistant message, so restore does not trigger an update.
    assert.equal(result.text,inspectDeepSeekReply().text);
    assert.equal(result.text,inspectDeepSeekReplyBuilder().conversation().text,"in-page and in-process reads agree");
    assert.deepEqual(new Function(`return (${inspectDeepSeekReplyBuilder.toString()})().conversation()`)(),result);
  } finally {env.dispose();}
});

test("conversation extraction handles an empty page and keeps returning the reply reader", () => {
  const env = browserEnvironment('<body><textarea></textarea></body>');
  try {
    const reader = inspectDeepSeekReplyBuilder();
    const empty = reader.conversation();
    assert.deepEqual(empty.messages,[]);
    assert.equal(empty.text,"");
    assert.equal(empty.loggedIn,true);
    assert.equal(reader.reply().loggedIn,true);
  } finally {env.dispose();}
});

test("a single history question is included without main landmarks or stable message classes", () => {
  const env = browserEnvironment('<body><aside>Unrelated sidebar</aside><div><div>第一段<p>第二段</p><p>第三段</p></div><section><div><button>复制</button><div class="ds-markdown"><p>回答</p></div></div></section></div><textarea></textarea></body>');
  try {
    assert.deepEqual(inspectDeepSeekReplyBuilder().conversation().messages,[{role:"user",text:"第一段\n第二段\n第三段"},{role:"assistant",text:"回答"}]);
  } finally {env.dispose();}
});

test("per-message history limits preserve long questions and keep the latest answer identical to live reading", () => {
  const env = browserEnvironment('<body><main><div id="question"></div><div class="ds-markdown" id="first"></div><div>follow up</div><div class="ds-markdown" id="last"></div></main><textarea></textarea></body>');
  try {
    env.document.getElementById("question").textContent = "Q".repeat(12000);
    env.document.getElementById("first").textContent = "A".repeat(200001);
    env.document.getElementById("last").textContent = "last answer";
    const reader = inspectDeepSeekReplyBuilder(), history = reader.conversation();
    assert.equal(history.messages.length,4);
    assert.equal(history.messages[0].text.length,12000,"long user questions must not disappear");
    assert.equal(history.messages[1].text.length,200000);
    assert.equal(history.truncated,true);
    assert.equal(history.messages.at(-1).text,reader.reply().text);
    assert.equal(history.text,"last answer");
  } finally {env.dispose();}
});
