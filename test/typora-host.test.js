import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {TyporaHost,getCurrentDocumentIdentity} from "../src/typora-host.js";

test("document identity normalizes Windows paths and distinguishes saved documents", () => {
  const runtime = filename => ({File:{filePath:filename},reqnode:() => path});
  assert.equal(getCurrentDocumentIdentity(runtime("E:/Notes/a.md")).key,getCurrentDocumentIdentity(runtime("e:\\notes\\a.md")).key);
  assert.notEqual(getCurrentDocumentIdentity(runtime("E:/Notes/a.md")).key,getCurrentDocumentIdentity(runtime("E:/Notes/b.md")).key);
  assert.equal(getCurrentDocumentIdentity(runtime("")).persistable,false);
});

test("host captures Markdown without changing clipboard state or accepting ranges outside the editor", () => {
  let inside = true;
  const node = {isConnected:true,nodeType:1,closest:() => null};
  const range = {startContainer:node,endContainer:node,toString:() => "visible",cloneRange() {return {...this};},collapse() {this.collapsed = true;}};
  const file = {_CopyContentFlag:false,editor:{UserOp:{copyAsMarkdown(editor,event) {event.clipboardData.setData("text/plain","**markdown**");}}}};
  const runtime = {File:file,getSelection:() => ({rangeCount:1,isCollapsed:false,getRangeAt:() => range})};
  const host = new TyporaHost(runtime,{getElementById:() => ({contains:() => inside}),activeElement:null});
  const captured = host.captureSelectionSnapshot("doc");
  assert.equal(captured.text,"**markdown**"); assert.equal(file._CopyContentFlag,false);
  assert.equal(host.captureInsertionRange(captured).collapsed,true);
  file.editor.UserOp.copyAsMarkdown = () => {throw Error("serializer unavailable");};
  assert.equal(host.captureSelectionSnapshot("doc").text,"visible"); assert.equal(file._CopyContentFlag,false);
  inside = false;
  assert.equal(host.captureSelectionSnapshot("doc"),null);
  assert.equal(host.captureInsertionRange(captured),null);
});

test("host keeps CodeMirror selection and insertion position", () => {
  const cm = {getSelection:() => "source text",getCursor:() => ({line:2,ch:4}),replaceRange() {}};
  const wrapper = {isConnected:true,CodeMirror:cm};
  const host = new TyporaHost({getSelection:() => null},{activeElement:{closest:() => wrapper},getElementById:() => ({contains:() => true})});
  const captured = host.captureSelectionSnapshot("doc");
  assert.equal(captured.text,"source text"); assert.equal(captured.codeMirror.editor,cm);
  assert.deepEqual(captured.to,{line:2,ch:4});
});

test("host refuses unavailable Markdown rather than treating it as an empty document", async () => {
  const host = new TyporaHost({reqnode:() => ({clipboard:{readText:() => "answer"}})},{});
  assert.throws(() => host.getDocumentText(),/无法读取/);
  assert.equal(await host.readClipboardText(),"answer");
});
