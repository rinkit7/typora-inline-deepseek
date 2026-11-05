import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createChatSession} from "../src/chat-session.js";
import {browserEnvironment} from "./helpers/browser-env.js";
import {createAppearanceStore} from "../src/appearance.js";

test("custom quick asks can be edited, persisted and sent with a quote, while cancel and save failures retain drafts", async () => {
  const env = browserEnvironment('<body><div id="host"></div></body>');
  let data = '{}', writable = true, ui, now = 0, failSend = true;
  const sent = [];
  const appearance = createAppearanceStore({reqnode:() => ({readFileSync:() => data,mkdirSync() {},writeFileSync:(file,value) => {if (!writable) throw Error("readonly"); data = value;}})});
  const session = createChatSession({clock:() => now,provider:{send:async prompt => {sent.push(prompt); if (failSend) throw Error("send failed"); return {baseline:{count:0,text:""}};}}});
  try {
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {fireEvent,findByRole,waitFor} = await import("@testing-library/dom");
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"}), mount = env.document.createElement("div"); shadow.appendChild(mount);
    const services = {session,appearance,detached:false,actions:{width() {},getPosition:() => ({left:200,top:48,width:440,height:640}),pause() {},copy() {},insert() {},close() {}}};
    session.setDraft("保留原问题");
    ui = mountChatUI(mount,shadow,services);
    await findByRole(mount,"textbox",{name:"输入问题"});
    mount.querySelector(".ds-settings").open = true;
    fireEvent.click(await findByRole(mount,"button",{name:"快捷提问设置"}));
    await findByRole(mount,"region",{name:"快捷提问设置"});
    assert.equal(mount.querySelector(".ds-settings").open,false);
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 1 的按钮名称"}),{target:{value:"通俗讲解"}});
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 1 的提问内容"}),{target:{value:"用生活中的例子解释，先给结论再给例子。"}});
    fireEvent.click(await findByRole(mount,"button",{name:"删除快捷提问 2"}));
    await waitFor(() => assert.equal(mount.querySelectorAll(".ds-template-row").length,4));
    fireEvent.click(await findByRole(mount,"button",{name:"＋ 新增快捷提问"}));
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 5 的按钮名称"}),{target:{value:"提取公式"}});
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 5 的提问内容"}),{target:{value:"提取所有公式。\n逐项解释符号含义。"}});
    fireEvent.click(await findByRole(mount,"button",{name:"保存快捷提问"}));
    await findByRole(mount,"textbox",{name:"输入问题"});
    assert.equal(session.getSnapshot().draft,"保留原问题");
    assert.equal(session.getSnapshot().messages.length,0);
    assert.equal(JSON.parse(data).quickAsks.length,5);
    assert.equal(JSON.parse(data).quickAsks[4].prompt,"提取所有公式。\n逐项解释符号含义。");
    session.askSelection({text:"引用正文",label:"a.md",targetId:"source"});
    const custom = await findByRole(mount,"button",{name:"通俗讲解"});
    assert.equal(mount.querySelector('.ds-quick button[title="总结要点"]'),null);
    fireEvent.click(custom);
    await findByRole(mount,"alert");
    assert.match(sent[0],/用生活中的例子解释/); assert.match(sent[0],/引用正文/);
    assert.equal(session.getSnapshot().quote.text,"引用正文");
    await waitFor(() => assert.equal(session.getSnapshot().draft,"保留原问题"));
    fireEvent.click(await findByRole(mount,"button",{name:"自定义快捷提问"}));
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 1 的按钮名称"}),{target:{value:"未保存"}});
    fireEvent.click(await findByRole(mount,"button",{name:"取消"}));
    await findByRole(mount,"button",{name:"通俗讲解"});
    fireEvent.click(await findByRole(mount,"button",{name:"自定义快捷提问"}));
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 1 的提问内容"}),{target:{value:""}});
    fireEvent.click(await findByRole(mount,"button",{name:"保存快捷提问"}));
    await waitFor(() => assert.match(mount.querySelector(".ds-template-error").textContent,/需要填写/));
    assert.equal(JSON.parse(data).quickAsks[0].label,"通俗讲解");
    fireEvent.change(await findByRole(mount,"textbox",{name:"快捷提问 1 的提问内容"}),{target:{value:"新的提示词"}});
    writable = false;
    fireEvent.click(await findByRole(mount,"button",{name:"保存快捷提问"}));
    await waitFor(() => assert.match(mount.querySelector(".ds-template-error").textContent,/保存失败/));
    assert.equal(JSON.parse(data).quickAsks[0].prompt,"用生活中的例子解释，先给结论再给例子。");
    assert.equal(session.getSnapshot().quote.text,"引用正文");
    fireEvent.click(await findByRole(mount,"button",{name:"取消"}));
    writable = true;
    ui.dispose(); ui = mountChatUI(mount,shadow,services);
    await findByRole(mount,"button",{name:"通俗讲解"});
    failSend = false;
    fireEvent.click(await findByRole(mount,"button",{name:"提取公式"}));
    await waitFor(() => assert.equal(session.getSnapshot().messages.length,2));
    assert.match(sent.at(-1),/提取所有公式。\n逐项解释符号含义。/);
    assert.match(sent.at(-1),/引用正文/);
    assert.equal(session.getSnapshot().messages[0].text,"提取所有公式。\n逐项解释符号含义。");
    session.receive({count:1,text:"回答",generating:true}); now = 3000; session.receive({count:1,text:"回答",generating:false});
    session.askSelection({text:"另一个引用",label:"b.md",targetId:"source2"});
    fireEvent.click(await findByRole(mount,"button",{name:"自定义快捷提问"}));
    fireEvent.click(await findByRole(mount,"button",{name:"恢复默认"}));
    fireEvent.click(await findByRole(mount,"button",{name:"保存快捷提问"}));
    await findByRole(mount,"button",{name:"总结要点"});
    assert.equal(JSON.parse(data).quickAsks[0].label,"解释这段内容");
  } finally {ui?.dispose(); session.dispose(); env.dispose();}
});

test("pointer bursts update once per frame and release flushes the final position without extra layout reads", async () => {
  const env = browserEnvironment('<body><div id="host"></div></body>');
  const session = createChatSession();
  let ui, sequence = 0, reads = 0;
  const frames = new Map(), moves = [], sizes = [], heights = [], saved = [], savedHeights = [], ended = [];
  try {
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {fireEvent,findByRole,waitFor} = await import("@testing-library/dom");
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"});
    const mount = env.document.createElement("div"); shadow.appendChild(mount);
    ui = mountChatUI(mount,shadow,{session,detached:false,
      appearance:{loadReaderOpacity:() => 80,loadReaderWidth:() => 440,loadReaderHeight:() => 640,loadReaderFont:() => 16,loadOpacity:() => 100,saveReaderWidth:value => saved.push(value),saveReaderHeight:value => savedHeights.push(value)},
      actions:{width() {},height() {},getPosition:() => {reads++; return {left:200,top:48,width:440,height:640};},startDrag() {},endDrag:() => ended.push(true),drag:(x,y) => moves.push([x,y]),resize:(width,left) => sizes.push([width,left]),resizeHeight:(height,top) => heights.push([height,top])}});
    await findByRole(mount,"textbox",{name:"输入问题"});
    env.window.requestAnimationFrame = callback => {frames.set(++sequence,callback); return sequence;};
    env.window.cancelAnimationFrame = id => frames.delete(id);
    const frame = () => {const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0);};
    const pointer = (target,type,x,y = 68) => fireEvent(target,new env.window.MouseEvent(type,{composed:true,bubbles:true,cancelable:true,clientX:x,clientY:y}));
    const header = mount.querySelector(".ds-header");
    pointer(header,"pointerdown",220);
    for (let i = 1; i <= 120; i++) pointer(header,"pointermove",220 + i,68 + i);
    assert.equal(frames.size,1);
    assert.equal(moves.length,0);
    assert.equal(reads,1,"measure only at gesture start");
    frame();
    assert.deepEqual(moves,[[320,168]],"render only the latest of 120 pointer moves");
    pointer(header,"pointermove",350,188);
    pointer(header,"pointerup",350,188);
    assert.deepEqual(moves.at(-1),[330,168]);
    assert.equal(frames.size,0,"release cancels the queued frame and flushes it immediately");
    assert.equal(ended.length,1);
    const right = await findByRole(mount,"separator",{name:"拖动右边框调整宽度"});
    pointer(right,"pointerdown",640);
    for (let i = 1; i <= 100; i++) pointer(right,"pointermove",640 + i);
    assert.equal(frames.size,1);
    assert.equal(sizes.length,0);
    frame();
    assert.deepEqual(sizes,[[540,200]]);
    await new Promise(resolve => setTimeout(resolve,30));
    assert.equal(right.getAttribute("aria-valuenow"),"440","do not rerender the chat for each resized frame");
    pointer(right,"pointermove",760);
    env.window.dispatchEvent(new env.window.Event("blur"));
    assert.deepEqual(sizes.at(-1),[560,200]);
    await waitFor(() => assert.deepEqual(saved,[560],"save once after release or focus loss"));
    await waitFor(() => assert.equal(right.getAttribute("aria-valuenow"),"560"));
    Object.defineProperty(env.window,"innerHeight",{value:960,configurable:true});
    const bottom = await findByRole(mount,"separator",{name:"拖动下边框调整高度"});
    assert.equal(bottom.getAttribute("aria-orientation"),"horizontal");
    pointer(bottom,"pointerdown",500,688);
    for (let i = 1; i <= 120; i++) pointer(bottom,"pointermove",500,688 + i);
    assert.equal(frames.size,1);
    assert.equal(heights.length,0);
    assert.equal(reads,3,"height changes also measure only once per gesture");
    frame();
    assert.deepEqual(heights,[[760,48]]);
    assert.equal(bottom.getAttribute("aria-valuenow"),"640","height changes must not rerender React on each frame");
    pointer(bottom,"pointermove",500,838);
    pointer(bottom,"pointerup",500,838);
    assert.deepEqual(heights.at(-1),[790,48]);
    assert.equal(frames.size,0);
    assert.deepEqual(savedHeights,[],"height persistence stays outside the input handler");
    await waitFor(() => assert.deepEqual(savedHeights,[790]));
    await waitFor(() => assert.equal(bottom.getAttribute("aria-valuenow"),"790"));
    assert.deepEqual(saved,[560],"vertical resizing cannot overwrite the saved width");
    pointer(header,"pointerdown",220);
    pointer(header,"pointermove",250);
    ui.dispose(); ui = null;
    assert.equal(frames.size,0,"unmount cancels pending gesture work");
    assert.equal(session.getSnapshot().messages.length,0);
  } finally {ui?.dispose(); session.dispose(); env.dispose();}
});

test("reading font adjusts and previews before sending, and survives reopening", async () => {
  const env = browserEnvironment('<body><div id="host"></div></body>');
  const session = createChatSession({provider:{send() {throw Error("must not send in this test");}}});
  let ui, font = 16;
  try {
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {fireEvent,findByRole,waitFor} = await import("@testing-library/dom");
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"});
    const mount = env.document.createElement("div"); shadow.appendChild(mount);
    const services = {session,detached:false,
      appearance:{loadReaderOpacity:() => 80,loadReaderWidth:() => 440,loadReaderFont:() => font,loadOpacity:() => 100,saveReaderFont:value => {font = value;}},
      actions:{width() {},getPosition:() => ({left:0,top:0}),drag() {},pause() {},close() {}}};
    session.askSelection({text:"尚未发送的引用",label:"notes.md"});
    session.setDraft("尚未发送的问题");
    ui = mountChatUI(mount,shadow,services);
    await findByRole(mount,"textbox",{name:"输入问题"});
    mount.querySelector(".ds-settings").open = true;
    const slider = await findByRole(mount,"slider",{name:"阅读字号"});
    assert.equal(slider.disabled,false);
    fireEvent.input(slider,{target:{value:"22"}});
    await waitFor(() => assert.equal(mount.querySelector(".ds-font-preview").style.fontSize,"22px"));
    assert.equal(font,22);
    assert.equal(mount.querySelector(".ds-shell").style.getPropertyValue("--reader-font"),"22px");
    assert.equal(session.getSnapshot().messages.length,0);
    assert.equal(session.getSnapshot().draft,"尚未发送的问题");
    assert.equal(session.getSnapshot().quote.text,"尚未发送的引用");
    ui.dispose(); ui = mountChatUI(mount,shadow,services);
    await findByRole(mount,"textbox",{name:"输入问题"});
    mount.querySelector(".ds-settings").open = true;
    assert.equal((await findByRole(mount,"slider",{name:"阅读字号"})).value,"22");
    assert.equal(mount.querySelector(".ds-font-preview").style.fontSize,"22px");
  } finally {ui?.dispose(); session.dispose(); env.dispose();}
});

test("built assistant-ui renders the quote, sends it, and displays a complete conversation", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>',{url:"https://typora.local/",pretendToBeVisual:true});
  const previous = new Map();
  const globals = {window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,ShadowRoot:dom.window.ShadowRoot,MutationObserver:dom.window.MutationObserver,CustomEvent:dom.window.CustomEvent,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),getComputedStyle:dom.window.getComputedStyle.bind(dom.window),ResizeObserver:class {observe() {} unobserve() {} disconnect() {}},IntersectionObserver:class {observe() {} unobserve() {} disconnect() {}}};
  for (const key of ["DOMParser","XMLSerializer","Document","HTMLTextAreaElement","HTMLInputElement","HTMLFormElement","HTMLButtonElement","Event","EventTarget","KeyboardEvent","MouseEvent","Selection","Range","File","FileReader"]) globals[key] = dom.window[key];
  globals.MessageChannel = undefined;
  globals.fetch = () => {throw Error("UI must not make network requests");};
  for (const [key,value] of Object.entries(globals)) {previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.matchMedia = () => ({matches:false,addListener() {},removeListener() {},addEventListener() {},removeEventListener() {}});
  dom.window.HTMLElement.prototype.scrollTo = function(options) {this.scrollTop = options?.top || 0;};
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  const sent = [], copied = [];
  let now = 0, fail = false;
  const session = createChatSession({provider:{send:async prompt => {if (fail) throw Error("offline test"); sent.push(prompt); return {baseline:{count:0,text:""}};}},clock:() => now});
  let ui;
  try {
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {fireEvent,findByRole,findByText} = await import("@testing-library/dom");
    const shadow = dom.window.document.getElementById("host").attachShadow({mode:"open"});
    const mount = dom.window.document.createElement("div"); shadow.appendChild(mount);
    const appearance = {loadReaderOpacity:() => 80,loadReaderWidth:() => 440,loadReaderFont:() => 16,loadOpacity:() => 100,saveReaderOpacity() {},saveReaderWidth() {},saveReaderFont() {}};
    const actions = {width() {},getPosition:() => ({left:0,top:0}),drag() {},pause() {},copy:async text => copied.push(text),insert() {},reload() {},transfer() {},close() {}};
    ui = mountChatUI(mount,shadow,{session,appearance,detached:false,actions});
    session.askSelection({text:"selected context <script>alert(1)</script>",label:"notes.md",targetId:"source"});
    await findByRole(mount,"textbox",{name:"输入问题"});
    assert.ok(shadow.textContent.includes("selected context <script>alert(1)</script>"));
    assert.equal(shadow.querySelectorAll("script").length,0);
    const send = await findByRole(mount,"button",{name:"发送问题"});
    await new Promise(resolve => setTimeout(resolve,40));
    assert.equal(send.disabled,false);
    fireEvent.click(send);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(sent.length,1); assert.match(sent[0],/selected context/);
    for (let i = 0; i < 50 && session.getSnapshot().sending; i++) await new Promise(resolve => setTimeout(resolve,10));
    session.receive({count:1,text:"**Answer**\n\n- item\n\n$x^2$",generating:true});
    now = 3000; session.receive({count:1,text:"**Answer**\n\n- item\n\n$x^2$",generating:false});
    await findByText(mount,"Answer");
    assert.ok(shadow.querySelector("strong")); assert.ok(shadow.querySelector(".katex"));
    assert.ok(shadow.textContent.includes("引用 · notes.md"));
    session.askSelection({text:"second selection",label:"b.md",targetId:"two"});
    await findByText(mount,"second selection",{selector:"summary"});
    assert.equal(session.getSnapshot().messages.length,2);
    fireEvent.click(await findByRole(mount,"button",{name:"网页"}));
    assert.equal(session.getSnapshot().view,"web");
    fireEvent.click(await findByRole(mount,"button",{name:"对话"}));
    await findByRole(mount,"textbox",{name:"输入问题"});
    assert.equal(session.getSnapshot().quote.text,"second selection");
    const input = await findByRole(mount,"textbox",{name:"输入问题"});
    fireEvent.change(input,{target:{value:"explain second"}});
    assert.equal(session.getSnapshot().draft,"explain second");
    fireEvent.keyDown(input,{key:"Enter",ctrlKey:true});
    for (let i = 0; i < 50 && session.getSnapshot().messages.length < 4; i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(sent.length,2); assert.match(sent[1],/second selection/); assert.match(sent[1],/explain second/);
    session.receive({count:2,text:"second answer",generating:true}); now = 6000; session.receive({count:2,text:"second answer",generating:false});
    await findByText(mount,"second answer");
    fail = true; session.setDraft("keep on failure"); session.askSelection({text:"third selection",label:"c.md",targetId:"three"});
    await findByText(mount,"third selection",{selector:"summary"});
    await new Promise(resolve => setTimeout(resolve,30));
    fireEvent.click(await findByRole(mount,"button",{name:"发送问题"}));
    await findByRole(mount,"alert");
    assert.equal((await findByRole(mount,"textbox",{name:"输入问题"})).value,"keep on failure");
    assert.equal(session.getSnapshot().quote.text,"third selection"); assert.equal(session.getSnapshot().messages.length,4);
  } finally {
    ui?.dispose(); session.dispose(); dom.window.close();
    for (const [key,descriptor] of previous) {if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];}
  }
});

test("quick ask templates submit with the quote, and a settled answer raises the hook when unfocused", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>',{url:"https://typora.local/",pretendToBeVisual:true});
  const previous = new Map();
  const globals = {window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,ShadowRoot:dom.window.ShadowRoot,MutationObserver:dom.window.MutationObserver,CustomEvent:dom.window.CustomEvent,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),getComputedStyle:dom.window.getComputedStyle.bind(dom.window),ResizeObserver:class {observe() {} unobserve() {} disconnect() {}},IntersectionObserver:class {observe() {} unobserve() {} disconnect() {}}};
  for (const key of ["DOMParser","XMLSerializer","Document","HTMLTextAreaElement","HTMLInputElement","HTMLFormElement","HTMLButtonElement","Event","EventTarget","KeyboardEvent","MouseEvent","Selection","Range","File","FileReader"]) globals[key] = dom.window[key];
  globals.MessageChannel = undefined;
  globals.fetch = () => {throw Error("UI must not make network requests");};
  for (const [key,value] of Object.entries(globals)) {previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  dom.window.matchMedia = () => ({matches:false,addListener() {},removeListener() {},addEventListener() {},removeEventListener() {}});
  dom.window.HTMLElement.prototype.scrollTo = function(options) {this.scrollTop = options?.top || 0;};
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  const sent = [];
  let now = 0;
  const session = createChatSession({provider:{send:async prompt => {sent.push(prompt); return {baseline:{count:0,text:""}};}},clock:() => now});
  let ui;
  try {
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {fireEvent,findByRole,findByText} = await import("@testing-library/dom");
    const shadow = dom.window.document.getElementById("host").attachShadow({mode:"open"});
    const mount = dom.window.document.createElement("div"); shadow.appendChild(mount);
    const appearance = {loadReaderOpacity:() => 80,loadReaderWidth:() => 440,loadReaderFont:() => 16,loadOpacity:() => 100,loadPinned:() => false,saveReaderOpacity() {},saveReaderWidth() {},saveReaderFont() {},saveOpacity() {},savePinned() {}};
    const settled = [];
    const actions = {width() {},getPosition:() => ({left:0,top:0}),drag() {},pause() {},copy:async () => true,insert() {},reload() {},transfer() {},close() {},pin:value => pinCalls.push(value),onAnswerSettled:() => settled.push("settled")};
    const pinCalls = [];
    ui = mountChatUI(mount,shadow,{session,appearance,detached:false,actions});
    session.askSelection({text:"selected passage",label:"a.md",targetId:"t"});
    const chip = await findByRole(mount,"button",{name:"总结要点"});
    assert.ok(await findByRole(mount,"button",{name:"翻译成英文"}));
    fireEvent.click(chip);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(sent.length,1); assert.match(sent[0],/总结要点/); assert.match(sent[0],/selected passage/);
    for (let i = 0; i < 50 && session.getSnapshot().sending; i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(session.getSnapshot().draft,"","a successful template clears the draft");
    assert.equal(session.getSnapshot().quote,null,"the quote clears with the sent question");
    for (let i = 0; i < 50 && shadow.querySelector(".ds-quick"); i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(shadow.querySelector(".ds-quick"),null,"chips disappear once the quote is consumed");
    session.askSelection({text:"second passage",label:"b.md",targetId:"t2"});
    await findByRole(mount,"button",{name:"解释这段内容"});
    assert.equal((await findByRole(mount,"button",{name:"总结要点"})).disabled,true,"chips are disabled while answering");
    session.receive({count:1,text:"回答内容",generating:true});
    now = 3000; session.receive({count:1,text:"回答内容",generating:false});
    for (let i = 0; i < 50 && session.getSnapshot().responding; i++) await new Promise(resolve => setTimeout(resolve,10));
    await new Promise(resolve => setTimeout(resolve,30));
    assert.deepEqual(settled,["settled"],"settling an answer notifies the hook");
    session.setQuote(null);
    for (let i = 0; i < 50 && shadow.querySelector(".ds-quick"); i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(shadow.querySelector(".ds-quick"),null,"chips disappear without a quote");
  } finally {
    ui?.dispose(); session.dispose(); dom.window.close();
    for (const [key,descriptor] of previous) {if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];}
  }
});
