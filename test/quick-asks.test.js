import test from "node:test";
import assert from "node:assert/strict";
import {createAppearanceStore} from "../src/appearance.js";
import {DEFAULT_QUICK_ASKS,normalizeQuickAsks,validateQuickAsks} from "../src/quick-asks.js";

test("custom quick asks persist separately from appearance, including an intentionally empty list", () => {
  let data = '{"readerFont":20,"other":"keep"}', writable = true;
  const runtime = {reqnode:() => ({readFileSync:() => data,mkdirSync() {},writeFileSync:(file,value) => {if (!writable) throw Error("readonly"); data = value;}})};
  const store = createAppearanceStore(runtime);
  assert.deepEqual(store.loadQuickAsks(),DEFAULT_QUICK_ASKS);
  const items = [{label:"通俗解释",prompt:"用生活中的例子解释这段话。\n先给结论，再给例子。"}];
  assert.equal(store.saveQuickAsks(items),true);
  const reopened = createAppearanceStore(runtime);
  assert.deepEqual(reopened.loadQuickAsks(),items);
  assert.equal(reopened.loadReaderFont(),20); assert.equal(JSON.parse(data).other,"keep");
  assert.equal(store.saveQuickAsks([]),true); assert.deepEqual(reopened.loadQuickAsks(),[]);
  writable = false;
  assert.equal(store.saveQuickAsks(items),false);
  assert.deepEqual(reopened.loadQuickAsks(),[]);
  assert.throws(() => store.saveQuickAsks([{label:"",prompt:"prompt"}]),/需要填写/);
});

test("quick ask validation rejects unfinished or duplicate entries and corrupt preferences recover defaults", () => {
  assert.deepEqual(validateQuickAsks([{label:" Name ",prompt:" Prompt \n second line "}]),[{label:"Name",prompt:"Prompt \n second line"}]);
  assert.throws(() => validateQuickAsks([{label:"A",prompt:""}]),/需要填写/);
  assert.throws(() => validateQuickAsks([{label:"A",prompt:"one"},{label:"A",prompt:"two"}]),/重复/);
  assert.throws(() => validateQuickAsks([{label:"x".repeat(25),prompt:"one"}]),/过长/);
  assert.throws(() => validateQuickAsks(Array.from({length:21},(_,i) => ({label:String(i),prompt:"one"}))),/最多/);
  assert.deepEqual(normalizeQuickAsks([null,{}]),DEFAULT_QUICK_ASKS);
  assert.deepEqual(normalizeQuickAsks(undefined),DEFAULT_QUICK_ASKS);
  const defaults = normalizeQuickAsks(null); defaults[0].label = "changed";
  assert.equal(normalizeQuickAsks(null)[0].label,"解释这段内容");
  assert.deepEqual(normalizeQuickAsks(["旧字符串",{label:"新按钮",prompt:"自定义内容"}]),[{label:"旧字符串",prompt:"旧字符串"},{label:"新按钮",prompt:"自定义内容"}]);
});
