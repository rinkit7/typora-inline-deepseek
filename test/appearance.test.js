import test from "node:test";
import assert from "node:assert/strict";
import {createAppearanceStore,normalizeDetachedGeometry,normalizeOpacity,normalizeReaderWidth,normalizeReaderHeight,normalizeReaderFont} from "../src/appearance.js";
import {DETACHED_WINDOW_TITLE,setNativeOpacity} from "../src/detached-session.js";

test("opacity defaults and limits keep the window usable with malformed preferences", () => {
  for (const value of [undefined,null,"", "  ","bad",NaN,Infinity,false,{}]) assert.equal(normalizeOpacity(value),100);
  assert.equal(normalizeOpacity("75"),75);
  assert.equal(normalizeOpacity(0),40);
  assert.equal(normalizeOpacity(120),100);
});

test("opacity persists across store instances while retaining other preferences", () => {
  let data = '{"other":"keep"}';
  const fs = {mkdirSync() {},readFileSync:() => data,writeFileSync:(filename,value) => {data = value;}};
  const runtime = {reqnode:() => fs};
  const first = createAppearanceStore(runtime);
  assert.equal(first.loadOpacity(),100);
  assert.equal(first.saveOpacity(65),true);
  assert.equal(createAppearanceStore(runtime).loadOpacity(),65);
  assert.equal(JSON.parse(data).other,"keep");
  first.saveOpacity(100);
  assert.equal(createAppearanceStore(runtime).loadOpacity(),100);
  data = 'invalid json';
  assert.equal(first.loadOpacity(),100);
  fs.writeFileSync = () => {throw Error("read only");};
  assert.equal(first.saveOpacity(50),false);
});

test("native opacity targets only the exact helper window and rejects invalid requests", async () => {
  const calls = [];
  const runtime = {reqnode:name => name === "process" ? {execPath:"E:\\Typora\\Typora.exe"} : {
    execFile(helper,args,options,callback) {calls.push({args,options}); callback(null,'{"opacityApplied":true,"opacity":75}');}
  }};
  const identifier = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await setNativeOpacity(runtime,identifier,75);
  assert.deepEqual(calls[0].args,[identifier,"E:\\Typora\\Typora.exe","--opacity","75","--title",DETACHED_WINDOW_TITLE]);
  assert.equal(calls[0].options.windowsHide,true);
  await assert.rejects(setNativeOpacity(runtime,"invalid",75),/标识无效/);
  await assert.rejects(setNativeOpacity(runtime,identifier,0),/40%/);
  assert.equal(calls.length,1);
});

test("reading layout and dock sizes persist independently of floating size and whole-window opacity", () => {
  let data = '{"readerOpacity":30}';
  const store = createAppearanceStore({reqnode:() => ({mkdirSync() {},readFileSync:() => data,writeFileSync:(file,value) => {data = value;}})});
  assert.equal(store.loadReadingLayout(),"auto"); assert.equal(store.loadReaderWidth(),440);
  store.saveOpacity(65); store.saveReadingLayout("bottom"); store.saveReaderWidth(320);
  store.saveDockSize("top",260); store.saveDockSize("left",360);
  assert.equal(store.loadOpacity(),65); assert.equal(store.loadReadingLayout(),"bottom"); assert.equal(store.loadReaderWidth(),320);
  assert.equal(store.loadDockHeight(),260); assert.equal(store.loadDockWidth(),360);
  assert.equal(normalizeReaderWidth(0),300); assert.equal(normalizeReaderWidth(1000),640); assert.equal(normalizeReaderWidth(null),440);
  assert.equal(store.loadReaderFont(),16); store.saveReaderFont(19); assert.equal(store.loadReaderFont(),19);
  assert.equal(normalizeReaderFont(2),14); assert.equal(normalizeReaderFont(50),22); assert.equal(normalizeReaderFont("bad"),16);
});

test("reader height survives reopening and rejects malformed or unreachable preferences", () => {
  let data = '{"readerWidth":440,"readerFont":19}';
  const runtime = {reqnode:() => ({mkdirSync() {},readFileSync:() => data,writeFileSync:(file,value) => {data = value;}})};
  const first = createAppearanceStore(runtime);
  assert.equal(first.loadReaderHeight(),640);
  assert.equal(first.saveReaderHeight(520.4),true);
  const reopened = createAppearanceStore(runtime);
  assert.equal(reopened.loadReaderHeight(),520);
  assert.equal(reopened.loadReaderWidth(),440);
  assert.equal(reopened.loadReaderFont(),19);
  for (const value of [undefined,null,"","  ",false,{},NaN,Infinity,"bad"]) assert.equal(normalizeReaderHeight(value),640);
  assert.equal(normalizeReaderHeight(100),320);
  assert.equal(normalizeReaderHeight(99999),12000);
  assert.equal(normalizeReaderHeight("720"),720);
});

test("detached geometry normalizer rejects phantom and malformed rects", () => {
  assert.equal(normalizeDetachedGeometry(null),null);
  assert.equal(normalizeDetachedGeometry({x:-32000,y:-32000,width:1820,height:932}),null,"minimized phantom rect");
  assert.equal(normalizeDetachedGeometry({x:30,y:30,width:100,height:100}),null,"too small");
  assert.equal(normalizeDetachedGeometry({x:0,y:0,width:99999,height:932}),null,"too wide");
  assert.equal(normalizeDetachedGeometry({x:"a",y:0,width:800,height:600}),null);
  assert.deepEqual(normalizeDetachedGeometry({x:30.4,y:-10,width:1820.7,height:932}),{x:30,y:-10,width:1821,height:932});
});

test("pinned flag and detached geometry persist across store instances", () => {
  let data = '{"other":"keep"}';
  const fs = {mkdirSync() {},readFileSync:() => data,writeFileSync:(filename,value) => {data = value;}};
  const runtime = {reqnode:() => fs};
  const first = createAppearanceStore(runtime);
  assert.equal(first.loadPinned(),false);
  first.savePinned(true);
  first.saveDetachedGeometry({x:120,y:80,width:1000,height:700});
  const second = createAppearanceStore(runtime);
  assert.equal(second.loadPinned(),true);
  assert.deepEqual(second.loadDetachedGeometry(),{x:120,y:80,width:1000,height:700});
  assert.equal(second.saveDetachedGeometry({x:-32000,y:-32000,width:800,height:600}),true);
  assert.equal(JSON.parse(data).detachedGeometry,null,"phantom rects must not be stored");
  assert.equal(JSON.parse(data).other,"keep");
});

test("launcher visibility defaults to on and persists without replacing other preferences", () => {
  let data = '{"readerFont":19}';
  const runtime = {reqnode:() => ({mkdirSync() {},readFileSync:() => data,writeFileSync:(file,text) => {data = text;}})};
  const store = createAppearanceStore(runtime);
  assert.equal(store.loadLauncherVisible(),true);
  assert.equal(store.saveLauncherVisible(false),true);
  assert.equal(createAppearanceStore(runtime).loadLauncherVisible(),false);
  assert.equal(JSON.parse(data).readerFont,19);
  store.saveLauncherVisible(true);
  assert.equal(createAppearanceStore(runtime).loadLauncherVisible(),true);
});
