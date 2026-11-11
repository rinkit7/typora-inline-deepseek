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
  session.setDockPosition("bottom");
  session.askSelection({text:"old",targetId:"old"});
  const pending = session.submit();
  session.setDraft("next draft"); session.askSelection({text:"new",targetId:"new"});
  finish({baseline:{count:0,text:""}}); await pending;
  const state = session.getSnapshot();
  assert.equal(state.draft,"next draft"); assert.equal(state.quote.text,"new");
  assert.equal(state.composerCollapsed,false);
  assert.equal(state.messages[0].quote.text,"old"); assert.equal(state.messages[1].targetId,"old");
  session.dispose();
});

test("failed sends preserve quote and draft and do not invent a completed user turn", async () => {
  const session = createChatSession({provider:{send:async () => {const error = Error("请登录"); error.code = "LOGIN_REQUIRED"; throw error;}}});
  session.setDockPosition("bottom");
  session.askSelection({text:"retained"});
  assert.equal(await session.submit(),false);
  assert.equal(session.getSnapshot().quote.text,"retained");
  assert.equal(session.getSnapshot().draft,"解释这段内容");
  assert.equal(session.getSnapshot().composerCollapsed,false);
  assert.equal(session.getSnapshot().messages.length,0); assert.equal(session.getSnapshot().view,"web");
  session.dispose();
});

test("one conversation state survives view changes and serialized window transfer", async () => {
  const provider = {send:async () => ({baseline:{count:0,text:""}})};
  const origin = createChatSession({provider});
  origin.askSelection({text:"source",label:"a.md",targetId:"target"}); await origin.submit();
  origin.receive({count:1,text:"**answer**",generating:false});
  origin.setDraft("next"); origin.setView("web"); origin.setDockPosition("right");
  const child = createChatSession({provider}); child.restore(JSON.parse(JSON.stringify(origin.export())));
  assert.equal(child.getSnapshot().messages[0].quote.text,"source");
  assert.equal(child.getSnapshot().messages[1].text,"**answer**");
  child.receive({count:1,text:"stale reply from the reloaded page"});
  assert.equal(child.getSnapshot().messages[1].text,"**answer**");
  assert.equal(child.getSnapshot().draft,"next"); assert.equal(child.getSnapshot().dockPosition,null);
  child.setView("chat"); assert.equal(child.getSnapshot().draft,"next");
  child.askSelection({text:"other",targetId:"another"}); assert.equal(child.getSnapshot().messages.length,2);
  origin.dispose(); child.dispose();
});

test("imported history stays immutable across window transfer while a new question still streams its own answer", async () => {
  let now = 0;
  const history = [{role:"user",text:"first question",imported:true},{role:"assistant",text:"first answer",imported:true},
    {role:"user",text:"second question",imported:true},{role:"assistant",text:"second answer",imported:true}];
  const provider = {send:async prompt => {assert.equal(prompt,"third question"); return {baseline:{count:2,text:"second answer"}};}};
  const origin = createChatSession({provider,clock:() => now});
  const child = createChatSession({provider,clock:() => now});
  try {
    origin.restore({messages:history});
    child.restore(JSON.parse(JSON.stringify(origin.export())));
    child.receive({count:3,text:"unrelated webpage answer",generating:false});
    assert.deepEqual(child.getSnapshot().messages.map(m => m.text),history.map(m => m.text));
    assert.equal(await child.submit("third question"),true);
    child.receive({count:3,text:"third answer",generating:true});
    now = 3000; child.receive({count:3,text:"third answer",generating:false});
    assert.deepEqual(child.getSnapshot().messages.map(m => m.text),[...history.map(m => m.text),"third question","third answer"]);
    assert.equal(child.getSnapshot().responding,false);
  } finally {origin.dispose(); child.dispose();}
});

test("a pending answer only accepts its own message and remains fixed after settling", async () => {
  const url = "https://chat.deepseek.com/a/chat/s/current";
  const baseline = {url,count:2,key:"row:previous",text:"previous answer"};
  const live = {url,count:2,key:"row:new",text:"new answer",generating:true,atEnd:true};
  let now = 0;
  const session = createChatSession({provider:{send:async (prompt,selectedURL) => {
    assert.equal(selectedURL,url);
    return {url,baseline};
  }},clock:() => now});
  try {
    session.restore({conversationURL:url});
    assert.equal(await session.submit("question"),true);
    session.receive({...baseline,count:1});
    session.receive({...live,key:"row:older",text:"older answer",atEnd:false});
    assert.equal(session.getSnapshot().messages.at(-1).text,"");
    session.receive(live);
    session.receive({...live,key:"row:unrelated",text:"another message"});
    assert.equal(session.getSnapshot().messages.at(-1).text,"new answer");
    now = 3000;
    session.receive({...live,generating:false});
    assert.equal(session.getSnapshot().responding,false);
    session.receive({...live,text:"regenerated later"});
    session.receive({...live,url:"https://chat.deepseek.com/a/chat/s/other",text:"another conversation"});
    assert.equal(session.getSnapshot().messages.at(-1).text,"new answer");
    assert.equal(session.getSnapshot().responding,false);
  } finally {session.dispose();}
});

test("switching the guest conversation during generation cannot attach that page's reply", async () => {
  const url = "https://chat.deepseek.com/a/chat/s/current";
  const session = createChatSession({provider:{send:async () => ({url,baseline:null})}});
  try {
    await session.submit("question");
    session.receive({url,key:"row:mine",text:"partial",generating:true});
    session.receive({url:"https://chat.deepseek.com/a/chat/s/other",key:"row:mine",text:"other answer"});
    assert.equal(session.getSnapshot().messages.at(-1).text,"partial");
    assert.equal(session.getSnapshot().conversationURL,url);
    assert.equal(session.getSnapshot().responding,false);
    assert.match(session.getSnapshot().error,/会话已切换/);
  } finally {session.dispose();}
});

test("a reply arriving after the wait notice can still fill its own turn", async () => {
  const url = "https://chat.deepseek.com/a/chat/s/current";
  let now = 0;
  const session = createChatSession({provider:{send:async () => ({url,baseline:{key:"row:previous",count:1}})},clock:() => now});
  try {
    await session.submit("question");
    now = 91000;
    session.receive({url,key:"row:previous",text:"previous answer",generating:true});
    assert.equal(session.getSnapshot().responding,true);
    session.receive({url,key:"row:previous",text:"previous answer",generating:false});
    assert.equal(session.getSnapshot().responding,false);
    assert.equal(session.getSnapshot().messages.at(-1).text,"");
    session.receive({url,key:"row:new",text:"late answer",generating:false,atEnd:true});
    now = 94000;
    session.receive({url,key:"row:new",text:"late answer",generating:false,atEnd:true});
    assert.equal(session.getSnapshot().messages.at(-1).text,"late answer");
    assert.equal(session.getSnapshot().responding,false);
    assert.equal(session.getSnapshot().notice,"回答已同步");
  } finally {session.dispose();}
});
