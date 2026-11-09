import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {browserEnvironment} from "./helpers/browser-env.js";
import {inspectWebHistory,validateHistoryURL} from "../src/web-history.js";
import {createDeepSeekWeb} from "../src/deepseek-web.js";
import {TyporaHost} from "../src/typora-host.js";

test("web history reads only same-origin sidebar conversation links, including collapsed ones", () => {
  const env = browserEnvironment('<body><aside hidden><a href="/a/chat/s/one" title="第一段问答">first</a><a href="/a/chat/s/two">第二段问答</a><a href="/a/chat/s/one?from=sidebar">duplicate</a><a href="https://evil.test/a/chat/s/three">evil</a><a href="javascript:alert(1)">script</a></aside><div class="ds-markdown"><a href="/a/chat/s/quoted">quoted link</a></div><textarea></textarea></body>');
  try {
    const result = inspectWebHistory();
    assert.equal(result.loggedIn,true);
    assert.deepEqual(result.items.map(item => item.title),["第一段问答","第二段问答"]);
    assert.equal(result.items[0].url,"https://chat.deepseek.com/a/chat/s/one");
    assert.deepEqual(new Function('document',`return (${inspectWebHistory.toString()})()`)(env.document),result);
    for (const url of ["https://evil.test/a/chat/s/one","javascript:alert(1)","/api/v0/users"]) assert.throws(() => validateHistoryURL(url));
    assert.equal(validateHistoryURL('/a/chat/s/one?foo=bar#hash'),'https://chat.deepseek.com/a/chat/s/one');
  } finally {env.dispose();}
});

test("switching web history rejects old in-flight reads and restores the chosen page without sending", async () => {
  let url = 'https://chat.deepseek.com/a/chat/s/old', completeOld, reads = 0;
  const events = [], navigations = [];
  const page = {addEventListener() {},removeEventListener() {},getURL:() => url,setAttribute:(key,value) => {url = value; navigations.push(value);},executeJavaScript:async code => {
    if (code.includes('inspectWebPageReady')) return true;
    if (code.includes('inspectWebHistory')) return {loggedIn:true,items:[{id:'new',title:'saved question',url:'https://chat.deepseek.com/a/chat/s/new'}]};
    if (code.includes('.conversation()')) return {url,loggedIn:true,generating:false,count:2,text:'chosen answer',messages:[{role:'user',text:'chosen question'},{role:'assistant',text:'chosen answer'}]};
    if (code.includes('.reply()')) {reads++; if (reads === 1) return new Promise(resolve => {completeOld = resolve;}); return {url,count:1,text:'chosen answer',loggedIn:true,generating:false};}
    throw Error('must not send a message');
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    provider.subscribe(reply => events.push(reply.text)); provider.setActive(true);
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal((await provider.listHistory())[0].title,'saved question');
    const reply = await provider.openHistory('/a/chat/s/new');
    assert.equal(reply.text,'chosen answer');
    assert.deepEqual(reply.messages.map(message => [message.role,message.text]),[['user','chosen question'],['assistant','chosen answer']],'a history session carries its whole conversation');
    completeOld({text:'wrong old answer',url:'https://chat.deepseek.com/a/chat/s/old'}); await new Promise(resolve => setTimeout(resolve,0));
    assert.deepEqual(events,[]);
    await provider.poll(); assert.deepEqual(events,['chosen answer']);
    assert.deepEqual(navigations,['https://chat.deepseek.com/a/chat/s/new']);
  } finally {provider.dispose();}
});

test("history dates use item metadata or webpage date groups without guessing missing dates", () => {
  const env = browserEnvironment('<body><aside><section><h3>今天</h3><a href="/a/chat/s/today">today</a><a href="/a/chat/s/explicit" data-updated-at="2025-12-23T10:00:00Z">explicit</a></section><section><h3>昨天</h3><a href="/a/chat/s/yesterday">yesterday</a></section><section><h3>过去7天</h3><a href="/a/chat/s/range">range</a></section><section><a href="/a/chat/s/clock"><time datetime="2024-02-29">time</time></a></section><section><a href="/a/chat/s/props">props</a></section><section><a href="/a/chat/s/missing">2020-01-01 in title is not metadata</a></section><section><a href="/a/chat/s/invalid" data-created-at="2026-02-30">invalid</a></section></aside></body>');
  try {
    const now = new Date(2026,0,1,12).getTime();
    const props = env.document.querySelector('a[href$="/props"]');
    props.__reactProps$test = {session:{id:'props',updated_at:Date.parse('2025-11-20T10:00:00Z') / 1000,token:'must-not-be-returned'}};
    const items = inspectWebHistory(now).items;
    assert.deepEqual(items.map(item => item.dateLabel),['2026-01-01','2025-12-23','2025-12-31','过去7天（网页分组）','2024-02-29','2025-11-20','日期未知','日期未知']);
    assert.ok(!JSON.stringify(items).includes('must-not-be-returned'));
    props.__reactProps$test.session.id = 'different-conversation';
    assert.equal(inspectWebHistory(now).items.find(item => item.id.endsWith('/props')).dateLabel,'日期未知');
    props.__reactFiber$test = {memoizedProps:{},return:{memoizedProps:{item:{id:'props',created_at:'2023-01-03'}}}};
    assert.equal(inspectWebHistory(now).items.find(item => item.id.endsWith('/props')).dateLabel,'2023-01-03');
    assert.deepEqual(new Function('document','now',`return (${inspectWebHistory.toString()})(now)`)(env.document,now).items,inspectWebHistory(now).items);
  } finally {env.dispose();}
});

test("a failed history navigation retains the original page and blocks ambiguous sends", async () => {
  const original = 'https://chat.deepseek.com/a/chat/s/old', navigations = [];
  const page = {addEventListener() {},removeEventListener() {},getURL:() => original,setAttribute:(key,value) => navigations.push(value),executeJavaScript:async () => true};
  const provider = createDeepSeekWeb({webview:page,historyAttempts:1,historyPause:async () => {}});
  try {
    await assert.rejects(provider.openHistory('/a/chat/s/new'),/尚未加载/);
    assert.deepEqual(navigations,['https://chat.deepseek.com/a/chat/s/new',original]);
    await assert.rejects(provider.send('do not send'),/重新选择/);
    await assert.rejects(provider.openHistory('https://evil.test/a/chat/s/new'),/地址无效/);
  } finally {provider.dispose();}
});

test("opening history waits for progressively mounted messages to stabilize without sending", async () => {
  let url = 'https://chat.deepseek.com/', reads = 0;
  const page = {addEventListener() {},removeEventListener() {},getURL:() => url,setAttribute:(key,value) => {url = value;},executeJavaScript:async script => {
    if (script.includes('inspectWebPageReady')) return true;
    assert.ok(script.includes('.conversation()'),'history must only inspect the webpage');
    reads++;
    const turns = reads < 3 ? 1 : 3;
    return {url,loggedIn:true,generating:false,count:turns,text:`answer ${turns}`,messages:Array.from({length:turns},(_,i) => [{role:'user',text:`question ${i + 1}`},{role:'assistant',text:`answer ${i + 1}`}]).flat()};
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    const result = await provider.openHistory('/a/chat/s/loaded');
    assert.equal(reads,5,'the partial first two reads must not be accepted');
    assert.equal(result.messages.length,6);
    assert.equal(result.messages.at(-1).text,'answer 3');
  } finally {provider.dispose();}
});

test("history readiness ignores an old document even after the webview URL changes", async () => {
  let url = 'https://chat.deepseek.com/a/chat/s/old', reads = 0;
  const page = {addEventListener() {},removeEventListener() {},getURL:() => url,setAttribute:(key,value) => {url = value;},executeJavaScript:async script => {
    if (script.includes('inspectWebPageReady')) return true;
    reads++;
    return {url:reads < 3 ? 'https://chat.deepseek.com/a/chat/s/old' : url,loggedIn:true,generating:false,count:1,text:'answer',messages:[{role:'assistant',text:'answer'}]};
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    const result = await provider.openHistory('/a/chat/s/new');
    assert.equal(reads,5);
    assert.equal(result.url,'https://chat.deepseek.com/a/chat/s/new');
  } finally {provider.dispose();}
});

test("a full history scan failure propagates without restarting the scan or allowing ambiguous sends", async () => {
  const original = 'https://chat.deepseek.com/a/chat/s/old';
  let url = original, scans = 0;
  const page = {addEventListener() {},removeEventListener() {},getURL:() => url,setAttribute:(key,value) => {url = value;},executeJavaScript:async script => {
    if (script.includes('inspectWebPageReady')) return true;
    if (script.includes('.history()')) {scans++; throw Error('会话较长，尚未完整读取');}
    return {url,virtual:true,loggedIn:true,generating:false,count:1,text:'partial',messages:[{role:'assistant',text:'partial',webKey:'a'}]};
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    await assert.rejects(provider.openHistory('/a/chat/s/new'),/尚未完整读取/);
    assert.equal(scans,1);
    assert.equal(url,original);
    await assert.rejects(provider.send('do not send'),/重新选择/);
  } finally {provider.dispose();}
});

test("history does not accept a completed scan from another webpage conversation", async () => {
  const original = 'https://chat.deepseek.com/a/chat/s/old';
  let url = original;
  const page = {addEventListener() {},removeEventListener() {},getURL:() => url,setAttribute:(key,value) => {url = value;},executeJavaScript:async script => {
    if (script.includes('inspectWebPageReady')) return true;
    if (script.includes('.history()')) url = 'https://chat.deepseek.com/a/chat/s/other';
    return {url,virtual:true,loggedIn:true,generating:false,count:1,text:'answer',messages:[{role:'assistant',text:'answer',webKey:'a'}]};
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    await assert.rejects(provider.openHistory('/a/chat/s/new'),/会话已改变/);
    assert.equal(url,original);
  } finally {provider.dispose();}
});

test("history picker uses webpage records, preserves the draft and quote, and writes no local history", async () => {
  const env = browserEnvironment(), writes = [];
  let controller, url = 'https://chat.deepseek.com/', currentText = 'old answer';
  try {
    const {document,window} = env;
    window.reqnode = name => name === 'crypto' ? crypto : {readFileSync() {throw Error('no local state');},mkdirSync() {},writeFileSync:(file,value) => writes.push([file,value])};
    const create = document.createElement.bind(document);
    document.createElement = (tag,...args) => {
      const node = create(tag,...args);
      if (tag === 'webview') {
        node.getURL = () => url;
        node.executeJavaScript = async script => {
          if (script.includes('inspectWebPageReady')) return true;
          if (script.includes('inspectWebHistory')) return {loggedIn:true,items:[{id:'saved',title:'缓存知识笔记',dateLabel:'2026-11-06',url:'https://chat.deepseek.com/a/chat/s/saved'}]};
          if (script.includes('.conversation()')) return {url,loggedIn:true,generating:false,count:1,text:currentText,messages:[{role:'user',text:'较早的提问'},{role:'assistant',text:currentText}]};
          if (script.includes('inspectDeepSeekReply')) return {url,loggedIn:true,count:1,text:currentText,generating:false};
          throw Error('history must not send');
        };
        const set = node.setAttribute.bind(node);
        node.setAttribute = (key,value) => {set(key,value); if (key === 'src') {url = value; if (value.endsWith('/saved')) currentText = '从网页历史读取的回答';}};
      }
      return node;
    };
    const {createWorkspaceChat} = await import('../src/workspace-controller.js');
    const {fireEvent,findByRole,findByText,waitFor} = await import('@testing-library/dom');
    controller = createWorkspaceChat({editorSelection:new TyporaHost(window,document),getCurrentDocumentIdentity:() => ({key:'doc',label:'notes.md'}),app:{workspace:{on:() => () => {}}}});
    controller.askSelection({text:'保留的引用',key:'doc',label:'notes.md'});
    const mount = document.getElementById('deepseek-workspace').lastElementChild.shadowRoot.lastElementChild;
    const input = await findByRole(mount,'textbox',{name:'输入问题'});
    fireEvent.change(input,{target:{value:'尚未发送的草稿'}});
    const showHistory = async () => {
      const button = await findByRole(mount,'button',{name:'历史问答',exact:true});
      assert.ok(button.closest('.ds-header-actions'));
      assert.equal(button.closest('.ds-settings'),null,'history is a direct header entry');
      assert.equal(mount.querySelector('.ds-settings').open,false);
      fireEvent.click(button);
      await waitFor(() => assert.equal(button.getAttribute('aria-pressed'),'true'));
    };
    await showHistory(); await findByRole(mount,'region',{name:'历史问答'});
    await findByText(mount,'2026-11-06 · DeepSeek 网页会话');
    fireEvent.click(await findByRole(mount,'button',{name:'返回对话'}));
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    await showHistory();
    fireEvent.click(await findByRole(mount,'button',{name:'网页',exact:true}));
    await findByRole(mount,'generic',{name:'DeepSeek 网页区域'});
    assert.equal(mount.querySelector('.ds-history'),null);
    fireEvent.click(await findByRole(mount,'button',{name:'对话',exact:true}));
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    await showHistory();
    fireEvent.click(await findByRole(mount,'button',{name:/缓存知识笔记/}));
    // A restored history question must render, not only the newest answer.
    await findByText(mount,'较早的提问');
    await findByText(mount,'从网页历史读取的回答');
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    assert.equal((await findByText(mount,'保留的引用',{selector:'summary'})).textContent,'保留的引用');
    await waitFor(() => assert.equal(url,'https://chat.deepseek.com/a/chat/s/saved'));
    assert.equal((await findByRole(mount,'button',{name:'插入文档'})).disabled,true,'old webpage answers have no live insertion target');
    fireEvent.click(await findByRole(mount,'button',{name:'网页',exact:true}));
    await findByRole(mount,'generic',{name:'DeepSeek 网页区域'});
    url = 'https://chat.deepseek.com/a/chat/s/other';
    currentText = '另一会话的回答';
    fireEvent.click(await findByRole(mount,'button',{name:'对话',exact:true}));
    fireEvent.click(await findByRole(mount,'button',{name:'发送问题'}));
    assert.match((await findByRole(mount,'alert')).textContent,/网页会话已切换/);
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    assert.equal((await findByText(mount,'从网页历史读取的回答')).textContent,'从网页历史读取的回答');
    controller.dispose(); controller = null;
    assert.ok(writes.every(([file]) => !/history|conversation/i.test(file)));
    assert.ok(writes.every(([,text]) => !text.includes('从网页历史读取的回答') && !text.includes('尚未发送的草稿')));
  } finally {controller?.dispose(); env.dispose();}
});
