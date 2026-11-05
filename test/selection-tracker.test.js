import test from "node:test";
import assert from "node:assert/strict";
import {createSelectionTracker} from "../src/selection-tracker.js";

test("geometry gestures and chat pointer events do not repeatedly serialize the selected document", () => {
  const events = new Map();
  let captures = 0, reads = 0;
  const tracker = createSelectionTracker({
    host:{captureSelectionSnapshot() {captures++; return {text:"original selection"};},captureInsertionRange:() => ({}),getDocumentText() {reads++; return "document";},isChatCaretRangeUsable:() => true,isEditorTarget:node => node === "editor"},
    getIdentity:() => ({key:"a",label:"a.md"}),runtime:{getSelection:() => null},
    view:{addEventListener:(name,fn) => events.set(name,fn),removeEventListener:name => events.delete(name)}});
  try {
    events.get("selectionchange")();
    assert.equal(captures,1); assert.equal(reads,1);
    events.get("pointerdown")({type:"pointerdown",target:"chat"});
    assert.equal(captures,1);
    tracker.setSuspended(true);
    for (let i = 0; i < 120; i++) events.get("selectionchange")({type:"selectionchange"});
    assert.equal(captures,1); assert.equal(reads,1);
    assert.equal(tracker.capture(),null);
    tracker.setSuspended(false);
    assert.equal(tracker.capture().text,"original selection");
  } finally {tracker.dispose();}
});

test("selection survives focus moving to chat but not document edits or identity changes", () => {
  let selected = "first", key = "a", markdown = "document", alive = true;
  const events = new Map();
  const view = {addEventListener:(name,fn) => events.set(name,fn),removeEventListener:name => events.delete(name)};
  const host = {captureSelectionSnapshot:() => selected ? {text:selected,range:{}} : null,captureInsertionRange:() => ({}),getDocumentText:() => markdown,isChatCaretRangeUsable:() => alive,isEditorTarget:node => node === "editor"};
  const tracker = createSelectionTracker({host,getIdentity:() => ({key,label:key}),view,runtime:{getSelection:() => null}});
  events.get("selectionchange")(); selected = "";
  assert.equal(tracker.capture().text,"first","must retain the context before focus changes");
  selected = "second"; events.get("pointerup")({target:"editor"}); selected = "";
  assert.equal(tracker.capture().text,"second");
  selected = "second"; tracker.clear();
  assert.equal(tracker.capture(),null,"a consumed selection must not be reattached merely by revealing the window");
  assert.equal(tracker.capture({fresh:true}).text,"second","explicit new-question commands can reuse a live selection");
  selected = "";
  events.get("pointerup")({target:"editor"}); assert.equal(tracker.capture(),null,"new empty caret must clear the old selection");
  selected = "third"; events.get("contextmenu")(); selected = ""; markdown = "edited";
  assert.equal(tracker.capture(),null);
  markdown = "document"; selected = "fourth"; events.get("selectionchange")(); selected = ""; key = "b";
  assert.equal(tracker.capture(),null);
  tracker.dispose(); assert.equal(events.size,0);
});
