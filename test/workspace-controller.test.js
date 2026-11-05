import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {browserEnvironment} from "./helpers/browser-env.js";
import {TyporaHost} from "../src/typora-host.js";

test("four edge handles resize live, anchor the opposite side and remember sizes across workspaces", async () => {
  const env = browserEnvironment();
  let controller, preferences = {};
  try {
    const {document,window} = env;
    Object.defineProperty(window,"innerWidth",{value:1280,configurable:true});
    Object.defineProperty(window,"innerHeight",{value:960,writable:true,configurable:true});
    window.reqnode = name => name === "crypto" ? crypto : {
      readFileSync:() => JSON.stringify(preferences),mkdirSync() {},
      writeFileSync(file,value) {if (file.endsWith("preferences.json")) preferences = JSON.parse(value);}
    };
    const create = document.createElement.bind(document);
    document.createElement = (tag,...args) => {
      const node = create(tag,...args);
      if (tag === "webview") {node.getURL = () => "https://chat.deepseek.com/"; node.executeJavaScript = async () => ({count:0,text:""});}
      return node;
    };
    const plugin = {editorSelection:new TyporaHost(window,document),getCurrentDocumentIdentity:() => ({key:"doc",label:"a.md"}),app:{workspace:{on:() => () => {}}}};
    const {createWorkspaceChat} = await import("../src/workspace-controller.js");
    const {fireEvent,findByRole,waitFor} = await import("@testing-library/dom");
    const setup = () => {
      controller = createWorkspaceChat(plugin); controller.reveal();
      const node = document.getElementById("deepseek-workspace");
      node.getBoundingClientRect = () => {
        const width = Number(node.style.width.match(/[\d.]+/)[0]);
        const left = Number.isFinite(parseFloat(node.style.left)) ? parseFloat(node.style.left) : 1280 - 18 - width;
        const top = parseFloat(node.style.top), height = parseFloat(node.style.height);
        const translation = node.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
        const dx = translation ? Number(translation[1]) : 0, dy = translation ? Number(translation[2]) : 0;
        return {left:left + dx,width,right:left + dx + width,top:top + dy,height,bottom:top + dy + height};
      };
      return {node,mount:node.lastElementChild.shadowRoot.lastElementChild};
    };
    let {node,mount} = setup();
    const left = await findByRole(mount,"separator",{name:"拖动左边框调整宽度"});
    const right = await findByRole(mount,"separator",{name:"拖动右边框调整宽度"});
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,440));
    assert.equal(mount.querySelector('input[aria-label="窗口宽度"]'),null);
    const pointer = (target,type,x,button = 0) => {
      const event = new window.MouseEvent(type,{composed:true,bubbles:true,cancelable:true,clientX:x,button});
      Object.defineProperty(event,"pointerId",{value:1}); return fireEvent(target,event);
    };
    let captured = 0;
    left.setPointerCapture = () => captured++;
    pointer(left,"pointerdown",822);
    for (let x = 821; x >= 722; x--) pointer(left,"pointermove",x);
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,540));
    assert.equal(node.getBoundingClientRect().right,1262);
    assert.notEqual(node.querySelector("webview").style.visibility,"hidden","keep the webpage visible during live geometry updates");
    assert.equal(captured,1);
    assert.ok(document.querySelector(".ds-resize-shield"));
    pointer(left,"pointerup",722);
    await waitFor(() => assert.ok(!document.querySelector(".ds-resize-shield")));
    await waitFor(() => assert.equal(preferences.readerWidth,540));
    assert.equal(node.getBoundingClientRect().width,540);
    assert.notEqual(node.querySelector("webview").style.visibility,"hidden");
    assert.ok(!document.getElementById("deepseek-geometry-preview"));
    fireEvent.click(mount.querySelector('input[type="checkbox"]'));
    await waitFor(() => assert.ok(mount.querySelector(".ds-transparent")));
    pointer(right,"pointerdown",1262); pointer(right,"pointermove",500);
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,300));
    assert.equal(node.getBoundingClientRect().left,722);
    assert.equal(node.getBoundingClientRect().width,300,"the real card resizes before pointer release");
    pointer(right,"pointercancel",500);
    await waitFor(() => assert.equal(preferences.readerWidth,300));
    pointer(right,"pointermove",1100);
    assert.equal(node.getBoundingClientRect().width,300,"cancelled gestures cannot keep resizing");
    fireEvent.click(await findByRole(mount,"button",{name:"网页"}));
    await findByRole(mount,"generic",{name:"DeepSeek 网页区域"});
    pointer(left,"pointerdown",722); pointer(left,"pointermove",-500);
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,640));
    assert.equal(node.getBoundingClientRect().right,1022);
    pointer(left,"lostpointercapture",-500);
    await waitFor(() => assert.equal(preferences.readerWidth,640));
    fireEvent.keyDown(right,{key:"ArrowLeft"});
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,630));
    await waitFor(() => assert.equal(preferences.readerWidth,630));
    pointer(left,"pointerdown",382,2); pointer(left,"pointermove",0);
    assert.equal(node.getBoundingClientRect().width,630,"secondary clicks must not resize");
    const header = mount.querySelector(".ds-header"), before = node.getBoundingClientRect();
    const moveHeader = (type,x,y) => {
      const event = new window.MouseEvent(type,{composed:true,bubbles:true,cancelable:true,clientX:x,clientY:y});
      Object.defineProperty(event,"pointerId",{value:1}); return fireEvent(header,event);
    };
    moveHeader("pointerdown",before.left + 20,before.top + 20);
    moveHeader("pointermove",before.left - 80,before.top + 120);
    await waitFor(() => assert.equal(node.getBoundingClientRect().top,before.top + 100));
    const moved = node.getBoundingClientRect();
    assert.equal(moved.left,before.left - 100);
    assert.equal(moved.top,before.top + 100);
    assert.equal(moved.height,before.height,"dragging must preserve height");
    assert.equal(moved.bottom,before.bottom + 100,"the bottom moves with the whole card");
    assert.equal(parseFloat(node.style.top),before.top,"live movement must preserve the layout height");
    assert.match(node.style.transform,/translate3d/,"move the real card and webpage before pointer release");
    await waitFor(() => assert.ok(document.querySelector(".ds-drag-shield")));
    moveHeader("pointercancel",0,0);
    await waitFor(() => assert.ok(!document.querySelector(".ds-drag-shield")));
    assert.equal(node.style.transform,"","commit the position once the gesture ends");
    assert.ok(!document.getElementById("deepseek-geometry-preview"));
    assert.notEqual(node.querySelector("webview").style.visibility,"hidden");
    moveHeader("pointermove",0,0);
    assert.equal(node.getBoundingClientRect().top,moved.top,"cancelled drags must stop moving");
    moveHeader("pointerdown",moved.left + 20,moved.top + 20);
    moveHeader("pointermove",-10000,10000);
    await waitFor(() => assert.equal(node.getBoundingClientRect().left,0));
    assert.equal(node.getBoundingClientRect().bottom,942,"keep the bottom inside the viewport");
    assert.equal(node.getBoundingClientRect().height,before.height);
    moveHeader("pointerup",-10000,10000);
    assert.equal(node.getBoundingClientRect().left,0);
    assert.equal(node.getBoundingClientRect().bottom,942);
    globalThis.innerHeight = 500; window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().height,464);
    assert.equal(node.getBoundingClientRect().top,18);
    globalThis.innerHeight = 960; window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().height,before.height,"restore the preferred height when space returns");
    const top = await findByRole(mount,"separator",{name:"拖动上边框调整高度"});
    const bottom = await findByRole(mount,"separator",{name:"拖动下边框调整高度"});
    const verticalPointer = (target,type,y,button = 0) => {
      const event = new window.MouseEvent(type,{composed:true,bubbles:true,cancelable:true,clientX:30,clientY:y,button});
      Object.defineProperty(event,"pointerId",{value:1}); return fireEvent(target,event);
    };
    const initial = node.getBoundingClientRect();
    verticalPointer(bottom,"pointerdown",initial.bottom);
    verticalPointer(bottom,"pointermove",initial.bottom + 100);
    await waitFor(() => assert.equal(node.getBoundingClientRect().height,740));
    assert.equal(node.getBoundingClientRect().top,initial.top,"the top stays fixed while dragging the bottom");
    assert.equal(node.getBoundingClientRect().width,630);
    assert.equal(node.style.getPropertyValue("--workspace-height"),"740px");
    assert.equal(preferences.readerHeight,undefined,"live resizing does not save preferences");
    assert.match(document.querySelector(".ds-resize-shield").style.cursor,/ns-resize/);
    verticalPointer(bottom,"pointerup",initial.bottom + 100);
    await waitFor(() => assert.equal(preferences.readerHeight,740));
    const anchoredBottom = node.getBoundingClientRect().bottom;
    verticalPointer(top,"pointerdown",initial.top);
    verticalPointer(top,"pointermove",initial.top + 100);
    await waitFor(() => assert.equal(node.getBoundingClientRect().height,640));
    assert.equal(node.getBoundingClientRect().bottom,anchoredBottom,"the bottom stays fixed while dragging the top");
    verticalPointer(top,"pointercancel",initial.top + 100);
    await waitFor(() => assert.equal(preferences.readerHeight,640));
    verticalPointer(top,"pointermove",-10000);
    assert.equal(node.getBoundingClientRect().height,640,"cancelled gestures stop resizing");
    verticalPointer(top,"pointerdown",initial.top + 100);
    verticalPointer(top,"pointermove",10000);
    await waitFor(() => assert.equal(node.getBoundingClientRect().height,320));
    assert.equal(node.getBoundingClientRect().bottom,anchoredBottom);
    verticalPointer(top,"pointerup",10000);
    verticalPointer(top,"pointerdown",node.getBoundingClientRect().top);
    verticalPointer(top,"pointermove",-10000);
    await waitFor(() => assert.equal(node.getBoundingClientRect().top,18));
    assert.equal(node.getBoundingClientRect().bottom,anchoredBottom);
    verticalPointer(top,"lostpointercapture",-10000);
    const expanded = node.getBoundingClientRect();
    verticalPointer(bottom,"pointerdown",expanded.bottom);
    verticalPointer(bottom,"pointermove",10000);
    await waitFor(() => assert.equal(node.getBoundingClientRect().bottom,942));
    verticalPointer(bottom,"pointerup",10000);
    assert.equal(node.getBoundingClientRect().height,924,"limit height to the viewport with margins");
    fireEvent.keyDown(bottom,{key:"ArrowUp",shiftKey:true});
    await waitFor(() => assert.equal(preferences.readerHeight,884));
    const keyboardBottom = node.getBoundingClientRect().bottom;
    fireEvent.keyDown(top,{key:"ArrowDown"});
    await waitFor(() => assert.equal(preferences.readerHeight,874));
    assert.equal(node.getBoundingClientRect().bottom,keyboardBottom);
    globalThis.innerWidth = 400;
    Object.defineProperty(window,"innerWidth",{value:400,configurable:true});
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().width,364);
    const currentTop = node.getBoundingClientRect().top;
    verticalPointer(bottom,"pointerdown",node.getBoundingClientRect().bottom);
    verticalPointer(bottom,"pointermove",currentTop + 520);
    verticalPointer(bottom,"pointerup",currentTop + 520);
    await waitFor(() => assert.equal(preferences.readerHeight,520));
    assert.equal(preferences.readerWidth,630);
    globalThis.innerWidth = 1280;
    Object.defineProperty(window,"innerWidth",{value:1280,configurable:true});
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().width,630,"height resizing in a narrow viewport must retain the preferred width");
    controller.dispose(); controller = null;
    ({node,mount} = setup());
    await findByRole(mount,"separator",{name:"拖动左边框调整宽度"});
    await waitFor(() => assert.equal(node.getBoundingClientRect().width,630));
    assert.equal(node.getBoundingClientRect().height,520,"restore a custom height in a new workspace");
    globalThis.innerHeight = window.innerHeight = 400; window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().height,364);
    assert.equal(preferences.readerHeight,520,"a smaller viewport cannot overwrite the preferred height");
    controller.dispose(); controller = null;
    ({node,mount} = setup());
    await findByRole(mount,"separator",{name:"拖动下边框调整高度"});
    assert.equal(node.getBoundingClientRect().height,364);
    globalThis.innerHeight = window.innerHeight = 960; window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.getBoundingClientRect().height,520);
  } finally {controller?.dispose(); env.dispose();}
});

test("native menu, floating button and Ctrl+I attach new selections to the same React workspace", async () => {
  const env = browserEnvironment('<body><div id="write" contenteditable="true"><p id="first">First paragraph</p><p id="second">Second paragraph</p><p id="third">Third paragraph</p></div></body>');
  let controller, listener, key = "a";
  try {
    const {document,window} = env;
    window.reqnode = name => name === "crypto" ? crypto : {readFileSync() {throw Error("no preferences");},mkdirSync() {},writeFileSync() {}};
    window.File = {editor:{getMarkdown:() => "First paragraph\nSecond paragraph\nThird paragraph"}};
    const createElement = document.createElement.bind(document), pages = [];
    document.createElement = function(tag,...args) {
      const element = createElement(tag,...args);
      if (tag === "webview") {
        element.getURL = () => element.getAttribute("src");
        element.executeJavaScript = async script => script.includes("inspectWebPageReady") ? true : script.includes("inspectDeepSeekReply") ? {count:0,text:"",generating:false,loggedIn:true} : {ok:true};
        element.reload = () => {throw Error("conversation must not reload");}; pages.push(element);
      }
      return element;
    };
    const host = new TyporaHost(window,document);
    const plugin = {editorSelection:host,getCurrentDocumentIdentity:() => ({key,label:"document.md"}),copyTextToClipboard:async () => true,app:{workspace:{on(name,callback) {listener = callback; return () => {};}}}};
    const {createWorkspaceChat} = await import("../src/workspace-controller.js");
    const {fireEvent,findByText,findByRole,waitFor} = await import("@testing-library/dom");
    controller = createWorkspaceChat(plugin,{isDetachedActive:() => false});
    assert.equal(pages[0].isConnected,false,"do not start the remote webpage just because Typora opened a document");
    const mount = document.getElementById("deepseek-workspace").lastElementChild.shadowRoot.lastElementChild;
    function select(id) {
      const range = document.createRange(); range.selectNodeContents(document.getElementById(id));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    }
    select("first");
    let item;
    const menu = {addSeparator() {},close() {},addItem(build) {item = {setKey() {return this;},setTitle() {return this;},onClick(callback) {this.click = callback; return this;}}; build(item);}};
    listener({menu}); window.getSelection().removeAllRanges(); item.click({preventDefault() {}});
    await findByText(mount,"First paragraph",{selector:"summary"});
    assert.equal(pages[0].isConnected,true);
    const settings = mount.querySelector(".ds-settings"); settings.open = true;
    fireEvent.click(mount.querySelector('input[type="checkbox"]'));
    await waitFor(() => assert.ok(mount.querySelector(".ds-transparent")));
    const input = await findByRole(mount,"textbox",{name:"输入问题"});
    fireEvent.change(input,{target:{value:"keep custom question"}});
    select("second");
    const launch = document.getElementById("deepseek-workspace-launch");
    fireEvent(launch,new window.MouseEvent("pointerdown",{bubbles:true,cancelable:true}));
    window.getSelection().removeAllRanges(); fireEvent.click(launch);
    await findByText(mount,"Second paragraph",{selector:"summary"});
    assert.equal(input.value,"keep custom question");
    select("third"); fireEvent.keyDown(document.getElementById("third"),{key:"i",ctrlKey:true});
    await findByText(mount,"Third paragraph",{selector:"summary"});
    assert.equal(pages.length,1);
    key = "another document"; controller.reveal();
    for (let i = 0; i < 20 && mount.querySelector(".ds-quote"); i++) await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(mount.querySelector(".ds-quote"),null,"quote from another document must not remain attached");
  } finally {controller?.dispose(); env.dispose();}
});

test("an active detached window receives a new selection rather than only a focus command", async () => {
  const env = browserEnvironment('<body><div id="write"><p id="text">new selected content</p></div></body>');
  let controller, delivered;
  try {
    env.window.reqnode = name => name === "crypto" ? crypto : {readFileSync() {throw Error("missing");},mkdirSync() {},writeFileSync() {}};
    env.window.File = {editor:{getMarkdown:() => "new selected content"}};
    const create = env.document.createElement.bind(env.document);
    env.document.createElement = (tag,...args) => {const node = create(tag,...args); if (tag === "webview") {node.getURL = () => "https://chat.deepseek.com/"; node.executeJavaScript = async () => ({count:0,text:""});} return node;};
    const {createWorkspaceChat} = await import("../src/workspace-controller.js");
    controller = createWorkspaceChat({editorSelection:new TyporaHost(env.window,env.document),getCurrentDocumentIdentity:() => ({key:"doc",label:"a.md"}),app:{workspace:{on:() => () => {}}}}, {isDetachedActive:() => true,onDetach:async payload => {delivered = payload;}});
    const range = env.document.createRange(); range.selectNodeContents(env.document.getElementById("text"));
    env.window.getSelection().addRange(range); env.document.dispatchEvent(new env.window.Event("selectionchange"));
    const launch = env.document.getElementById("deepseek-workspace-launch");
    launch.dispatchEvent(new env.window.MouseEvent("pointerdown",{bubbles:true,cancelable:true})); launch.click();
    assert.equal(delivered.intent,"selection"); assert.equal(delivered.selectionContext.text,"new selected content");
    assert.ok(delivered.selectionContext.targetId);
  } finally {controller?.dispose(); env.dispose();}
});
