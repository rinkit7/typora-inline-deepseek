import test from "node:test";
import assert from "node:assert/strict";
import {createReadingDock} from "../src/reading-dock.js";
import {browserEnvironment} from "./helpers/browser-env.js";

const rect = (left,top,right,bottom) => ({left,top,right,bottom,width:right-left,height:bottom-top});

test("automatic docking uses the display width and leaves enough room for the editor", () => {
  const env = browserEnvironment('<body><content><div id="write"></div></content></body>');
  const {document,window} = env;
  let screenWidth, windowWidth, sidebarWidth;
  Object.defineProperties(window,{
    innerWidth:{get:() => windowWidth},
    outerWidth:{get:() => windowWidth},
    innerHeight:{value:800}
  });
  Object.defineProperty(window.screen,"availWidth",{get:() => screenWidth});
  document.querySelector("content").getBoundingClientRect = () => rect(sidebarWidth,50,windowWidth,770);
  const dock = createReadingDock(document,window);
  try {
    const cases = [
      {screen:2560,width:1280,sidebar:48,expected:"bottom"},
      {screen:2560,width:1290,sidebar:48,expected:"bottom"},
      {screen:2560,width:1460,sidebar:260,expected:"right"},
      {screen:1920,width:1120,sidebar:260,expected:"bottom"},
      {screen:1366,width:1260,sidebar:330,expected:"right"},
      {screen:2560,width:1460,sidebar:260,mode:"bottom",expected:"bottom"},
      {screen:2560,width:1460,sidebar:260,mode:"floating",expected:null}
    ];
    for (const {screen,width,sidebar,mode = "auto",expected} of cases) {
      screenWidth = screen; windowWidth = width; sidebarWidth = sidebar;
      dock.measure(mode);
      assert.equal(dock.position,expected,`${mode}, window ${width} of ${screen}, sidebar ${sidebar}`);
      if (expected === "right") assert.ok(dock.place(640).left - sidebar >= 600);
    }
  } finally {dock.clear(); env.dispose();}
});

test("a tall editor extending offscreen cannot make the bottom dock fill the viewport", () => {
  const env = browserEnvironment('<body><content><div id="write"></div></content></body>');
  const {document,window} = env;
  Object.defineProperties(window,{innerWidth:{value:720},innerHeight:{value:650}});
  Object.defineProperty(document.documentElement,"clientHeight",{value:2200});
  document.querySelector("content").getBoundingClientRect = () => rect(0,-1400,720,850);
  const dock = createReadingDock(document,window);
  try {
    dock.measure("auto");
    assert.equal(dock.position,"bottom");
    for (const preferred of [null,5000]) {
      const panel = dock.place(preferred);
      assert.equal(panel.left,0);
      assert.equal(panel.width,720);
      assert.equal(panel.top + panel.height,650);
      assert.ok(panel.height <= 650 * .55);
      assert.ok(panel.top >= 650 * .45,"the editor keeps a visible reading area");
    }
  } finally {dock.clear(); env.dispose();}
});

test("a temporary tab strip does not determine dock size or cover the editor", () => {
  const env = browserEnvironment('<body><div class="typ-workspace-root"></div><content class="typ-workspace-binding"><div id="write"></div></content></body>');
  const {document,window} = env;
  Object.defineProperties(window,{innerWidth:{value:720},innerHeight:{value:650}});
  const editor = document.querySelector("content");
  document.querySelector(".typ-workspace-root").getBoundingClientRect = () => rect(48,28,720,54);
  editor.getBoundingClientRect = () => rect(48,54,720,625);
  const dock = createReadingDock(document,window);
  try {
    dock.measure("auto");
    const panel = dock.place(null);
    assert.equal(panel.top + panel.height,625);
    assert.ok(panel.height >= 220 && panel.height <= 571 * .55);

    editor.getBoundingClientRect = () => rect(48,-600,720,-29);
    dock.measure("auto");
    assert.equal(dock.position,null,"fall back when no usable editor is on screen");
    assert.equal(document.querySelector("[data-deepseek-dock-host]"),null);
  } finally {dock.clear(); env.dispose();}
});

test("a second layout measures the full editor even when identical style text would retain its CSSOM limits", () => {
  const env = browserEnvironment('<body><content><div id="write"></div></content></body>');
  const {document,window} = env;
  Object.defineProperties(window,{innerWidth:{value:720},innerHeight:{value:650}});
  const editor = document.querySelector("content");
  const textContent = Object.getOwnPropertyDescriptor(window.Node.prototype,"textContent");
  const create = document.createElement.bind(document);
  document.createElement = (tag,...args) => {
    const element = create(tag,...args);
    if (tag === "style") Object.defineProperty(element,"textContent",{
      get() {return textContent.get.call(this);},
      set(value) {
        // Match Chromium's optimization for reassignment of identical text.
        if (value !== textContent.get.call(this)) textContent.set.call(this,value);
      }
    });
    return element;
  };
  editor.getBoundingClientRect = () => {
    const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
    const cap = rules.find(rule => rule.selectorText && editor.matches(rule.selectorText) &&
      rule.style.getPropertyValue("max-height"))?.style.getPropertyValue("max-height");
    return rect(48,54,720,54 + (cap ? parseFloat(cap) : 571));
  };
  const dock = createReadingDock(document,window);
  try {
    dock.measure("auto");
    const first = dock.place(300);
    assert.ok(editor.getBoundingClientRect().bottom <= first.top);
    dock.measure("auto");
    assert.equal(dock.position,"bottom");
    assert.deepEqual(dock.place(300),first);
    dock.clear();
    assert.equal(editor.getBoundingClientRect().height,571);
  } finally {dock.clear(); env.dispose();}
});
