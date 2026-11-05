import test from "node:test";
import assert from "node:assert/strict";
import {browserEnvironment} from "./helpers/browser-env.js";
import {createPointerGestures} from "../src/pointer-gestures.js";

test("native capture isolates composed geometry events and compatibility mouse events from host listeners", async () => {
  const env = browserEnvironment('<body><div id="write"></div><div id="host"></div></body>');
  let gestures;
  try {
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"});
    shadow.innerHTML = '<div class="ds-header"><span>Drag</span><button>Settings</button></div><div class="ds-resize-edge ds-resize-right"></div>';
    const header = shadow.querySelector(".ds-header"), editor = env.document.getElementById("write");
    const received = [], reports = [], saves = [], frames = new Map();
    let seq = 0, starts = 0, ends = 0, captured = false;
    env.window.requestAnimationFrame = fn => {frames.set(++seq,fn); return seq;};
    env.window.cancelAnimationFrame = id => frames.delete(id);
    header.setPointerCapture = () => {captured = true;};
    header.hasPointerCapture = () => captured;
    header.releasePointerCapture = () => {captured = false;};
    gestures = createPointerGestures({shadow,runtime:env.window,detached:false,
      appearance:{loadReaderWidth:() => 440,saveReaderWidth:value => saves.push(value)},
      actions:{width() {},getPosition:() => ({left:200,top:48,width:440,height:640}),startDrag() {starts++;},endDrag() {ends++;},drag() {},startResize() {},endResize() {},resize() {},motionStats:stats => reports.push(stats)}});
    const types = ["pointerdown","pointermove","pointerup","mousedown","mousemove","mouseup","selectstart","dragstart"];
    for (const type of types) env.document.addEventListener(type,e => received.push(e.type),true);
    const event = (target,type,x = 220,id = 1) => {
      const e = new env.window.MouseEvent(type,{composed:true,bubbles:true,cancelable:true,button:0,clientX:x,clientY:68});
      Object.defineProperty(e,"pointerId",{value:id}); target.dispatchEvent(e); return e;
    };
    assert.equal(event(header,"pointerdown").defaultPrevented,true);
    assert.equal(captured,true);
    event(header,"mousedown");
    for (let i = 0; i < 120; i++) {event(header,"pointermove",220 + i); event(editor,"mousemove",220 + i);}
    event(editor,"selectstart"); event(editor,"dragstart");
    event(header,"pointerup",339);
    assert.equal(frames.size,0);
    assert.deepEqual(received,[],"neither capture nor bubble handlers in the editor may see a geometry gesture");
    assert.equal(starts,1); assert.equal(ends,1); assert.equal(captured,false);
    assert.ok(!env.document.querySelector(".ds-drag-shield"));
    event(shadow.querySelector("button"),"pointerdown");
    event(editor,"pointermove"); event(editor,"mousemove");
    assert.deepEqual(received,["pointerdown","pointermove","mousemove"],"controls and normal editor interaction must still work");
    const edge = shadow.querySelector(".ds-resize-edge");
    event(edge,"pointerdown"); event(edge,"pointermove",260);
    await new Promise(resolve => setTimeout(resolve,150));
    assert.deepEqual(reports,[],"a previous gesture's diagnostics cannot write during the next gesture");
    assert.deepEqual(saves,[]);
    event(edge,"pointercancel",260);
    assert.deepEqual(received,["pointerdown","pointermove","mousemove"],"resize input must be isolated too");
    assert.deepEqual(saves,[],"do not perform synchronous preference I/O inside input dispatch");
    gestures.dispose(); gestures = null;
    assert.deepEqual(saves,[480]);
    assert.equal(reports.at(-1).implementation,"native-capture-v1");
    event(header,"pointerdown");
    assert.equal(received.at(-1),"pointerdown","dispose must remove capture listeners");
  } finally {gestures?.dispose(); env.dispose();}
});

test("detached windows retain their native titlebar and mouse handling", () => {
  const env = browserEnvironment('<body><div id="host"></div></body>');
  let gestures;
  try {
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"});
    shadow.innerHTML = '<div class="ds-header">Native window header</div>';
    gestures = createPointerGestures({shadow,runtime:env.window,detached:true,appearance:{loadReaderWidth:() => 440},actions:{width() {},getPosition() {throw Error("Do not intercept a native window drag");}}});
    const received = [];
    env.document.addEventListener("mousedown",() => received.push("mousedown"),true);
    const header = shadow.querySelector(".ds-header");
    const pointer = new env.window.MouseEvent("pointerdown",{composed:true,bubbles:true,cancelable:true,button:0});
    header.dispatchEvent(pointer);
    header.dispatchEvent(new env.window.MouseEvent("mousedown",{composed:true,bubbles:true,cancelable:true,button:0}));
    assert.equal(pointer.defaultPrevented,false);
    assert.deepEqual(received,["mousedown"]);
    assert.ok(!env.document.querySelector(".ds-drag-shield"));
  } finally {gestures?.dispose(); env.dispose();}
});
