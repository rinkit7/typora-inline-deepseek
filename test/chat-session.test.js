import test from "node:test";
import assert from "node:assert/strict";
import {createChatSession} from "../src/chat-session.js";

test("quoted context is visible state and is included in exactly the submitted turn", async () => {
  const prompts = []; let now = 0;
  const session = createChatSession({provider:{send:async prompt => {prompts.push(prompt); return {baseline:{count:0,text:""}};}},clock:() => now});
  session.askSelection({text:"selected <b>text</b>",label:"notes.md",targetId:"first"});
  assert.equal(session.getSnapshot().quote.text,"selected <b>text</b>");
  assert.equal(await session.submit(),true);
  assert.match(prompts[0],/selected <b>text<\/b>/);
  const messages = session.getSnapshot().messages;
  assert.equal(messages[0].quote.label,"notes.md"); assert.equal(messages[1].targetId,"first");
  assert.equal(session.getSnapshot().quote,null);
  session.receive({count:1,text:"answer",generating:true});
  now = 3000; session.receive({count:1,text:"answer",generating:false});
  assert.equal(session.getSnapshot().responding,false);
  session.setDraft("follow up"); await session.submit();
  assert.equal(prompts[1],"follow up");
  assert.equal(session.getSnapshot().messages.length,4);
  session.dispose();
});

test("new quote or draft selected during an in-flight send is not lost on confirmation", async () => {
  let finish;
  const session = createChatSession({provider:{send:() => new Promise(resolve => {finish = resolve;})}});
  session.askSelection({text:"old",targetId:"old"});
  const pending = session.submit();
  session.setDraft("next draft"); session.askSelection({text:"new",targetId:"new"});
  finish({baseline:{count:0,text:""}}); await pending;
  const state = session.getSnapshot();
  assert.equal(state.draft,"next draft"); assert.equal(state.quote.text,"new");
  assert.equal(state.messages[0].quote.text,"old"); assert.equal(state.messages[1].targetId,"old");
  session.dispose();
});

test("failed sends preserve quote and draft and do not invent a completed user turn", async () => {
  const session = createChatSession({provider:{send:async () => {const error = Error("请登录"); error.code = "LOGIN_REQUIRED"; throw error;}}});
  session.askSelection({text:"retained"});
  assert.equal(await session.submit(),false);
  assert.equal(session.getSnapshot().quote.text,"retained");
  assert.equal(session.getSnapshot().draft,"解释这段内容");
  assert.equal(session.getSnapshot().messages.length,0); assert.equal(session.getSnapshot().view,"web");
  session.dispose();
});

test("one conversation state survives view changes and serialized window transfer", async () => {
  const provider = {send:async () => ({baseline:{count:0,text:""}})};
  const origin = createChatSession({provider});
  origin.askSelection({text:"source",label:"a.md",targetId:"target"}); await origin.submit();
  origin.receive({count:1,text:"**answer**",generating:false});
  origin.setDraft("next"); origin.setView("web"); origin.setTransparent(true);
  const child = createChatSession({provider}); child.restore(JSON.parse(JSON.stringify(origin.export())));
  assert.equal(child.getSnapshot().messages[0].quote.text,"source");
  assert.equal(child.getSnapshot().messages[1].text,"**answer**");
  assert.equal(child.getSnapshot().draft,"next"); assert.equal(child.getSnapshot().transparent,true);
  child.setView("chat"); assert.equal(child.getSnapshot().draft,"next");
  child.askSelection({text:"other",targetId:"another"}); assert.equal(child.getSnapshot().messages.length,2);
  origin.dispose(); child.dispose();
});
