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
    if (code.includes('inspectDeepSeekReply')) {reads++; if (reads === 1) return new Promise(resolve => {completeOld = resolve;}); return {count:1,text:'chosen answer',loggedIn:true,generating:false};}
    throw Error('must not send a message');
  }};
  const provider = createDeepSeekWeb({webview:page,interval:60000,historyPause:async () => {}});
  try {
    provider.subscribe(reply => events.push(reply.text)); provider.setActive(true);
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal((await provider.listHistory())[0].title,'saved question');
    const reply = await provider.openHistory('/a/chat/s/new');
    assert.equal(reply.text,'chosen answer');
    completeOld({text:'wrong old answer'}); await new Promise(resolve => setTimeout(resolve,0));
    assert.deepEqual(events,[]);
    await provider.poll(); assert.deepEqual(events,['chosen answer']);
    assert.deepEqual(navigations,['https://chat.deepseek.com/a/chat/s/new']);
  } finally {provider.dispose();}
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
          if (script.includes('inspectWebHistory')) return {loggedIn:true,items:[{id:'saved',title:'缓存知识笔记',url:'https://chat.deepseek.com/a/chat/s/saved'}]};
          if (script.includes('inspectDeepSeekReply')) return {loggedIn:true,count:1,text:currentText,generating:false};
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
    const showHistory = async () => {mount.querySelector('.ds-settings').open = true; fireEvent.click(await findByRole(mount,'button',{name:'历史问答',exact:true}));};
    await showHistory(); await findByRole(mount,'region',{name:'历史问答'});
    fireEvent.click(await findByRole(mount,'button',{name:'返回对话'}));
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    await showHistory();
    fireEvent.click(await findByRole(mount,'button',{name:/缓存知识笔记/}));
    await findByText(mount,'从网页历史读取的回答');
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'尚未发送的草稿');
    assert.equal((await findByText(mount,'保留的引用',{selector:'summary'})).textContent,'保留的引用');
    await waitFor(() => assert.equal(url,'https://chat.deepseek.com/a/chat/s/saved'));
    assert.equal((await findByRole(mount,'button',{name:'插入文档'})).disabled,true,'old webpage answers have no live insertion target');
    controller.dispose(); controller = null;
    assert.ok(writes.every(([file]) => !/history|conversation/i.test(file)));
    assert.ok(writes.every(([,text]) => !text.includes('从网页历史读取的回答') && !text.includes('尚未发送的草稿')));
  } finally {controller?.dispose(); env.dispose();}
});
