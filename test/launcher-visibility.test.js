import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {browserEnvironment} from "./helpers/browser-env.js";
import {TyporaHost} from "../src/typora-host.js";

test("hidden launcher survives reopening and remains recoverable through Ctrl+I and settings", async () => {
  const env = browserEnvironment('<body><div id="write" contenteditable="true"><p id="text">示例正文</p></div></body>');
  let controller, preferences = {}, writable = true;
  try {
    const {document,window} = env;
    window.reqnode = name => name === 'crypto' ? crypto : {readFileSync:() => JSON.stringify(preferences),mkdirSync() {},writeFileSync:(file,value) => {
      if (file.endsWith('preferences.json')) {if (!writable) throw Error('read-only'); preferences = JSON.parse(value);}
    }};
    const create = document.createElement.bind(document);
    document.createElement = (tag,...args) => {const node = create(tag,...args); if (tag === 'webview') {node.getURL = () => 'https://chat.deepseek.com/'; node.executeJavaScript = async () => ({count:0,text:''});} return node;};
    const {createWorkspaceChat} = await import('../src/workspace-controller.js');
    const {fireEvent,findByRole,waitFor} = await import('@testing-library/dom');
    const plugin = {editorSelection:new TyporaHost(window,document),getCurrentDocumentIdentity:() => ({key:'doc',label:'a.md'}),app:{workspace:{on:() => () => {}}}};
    const setup = () => {controller = createWorkspaceChat(plugin); return {launch:document.getElementById('deepseek-workspace-launch'),node:document.getElementById('deepseek-workspace'),mount:document.getElementById('deepseek-workspace').lastElementChild.shadowRoot.lastElementChild};};
    let {launch,node,mount} = setup(); controller.reveal();
    const input = await findByRole(mount,'textbox',{name:'输入问题'}); fireEvent.change(input,{target:{value:'保留草稿'}});
    mount.querySelector('.ds-settings').open = true;
    const toggle = await findByRole(mount,'checkbox',{name:'显示悬浮按钮'});
    assert.equal(toggle.checked,true); fireEvent.click(toggle);
    await waitFor(() => assert.equal(launch.hidden,true));
    assert.equal(launch.style.display,'none'); assert.equal(preferences.launcherVisible,false);
    fireEvent.click(await findByRole(mount,'button',{name:'关闭问答'}));
    assert.equal(node.hidden,true);
    fireEvent.keyDown(document.getElementById('text'),{key:'i',ctrlKey:true});
    await waitFor(() => assert.equal(node.hidden,false));
    assert.equal((await findByRole(mount,'textbox',{name:'输入问题'})).value,'保留草稿');
    controller.dispose(); controller = null;
    ({launch,node,mount} = setup()); assert.equal(launch.hidden,true);
    fireEvent.keyDown(document.getElementById('text'),{key:'i',ctrlKey:true});
    await findByRole(mount,'textbox',{name:'输入问题'}); mount.querySelector('.ds-settings').open = true;
    const reopened = await findByRole(mount,'checkbox',{name:'显示悬浮按钮'}); assert.equal(reopened.checked,false);
    writable = false; fireEvent.click(reopened);
    assert.match((await findByRole(mount,'alert')).textContent,/保存失败/);
    assert.equal(launch.hidden,true); assert.equal(reopened.checked,false);
    writable = true; fireEvent.click(reopened);
    await waitFor(() => assert.equal(launch.hidden,false)); assert.equal(preferences.launcherVisible,true);
    preferences.launcherVisible = false; window.dispatchEvent(new window.Event('focus'));
    await waitFor(() => assert.equal(reopened.checked,false)); assert.equal(launch.hidden,true);
  } finally {controller?.dispose(); env.dispose();}
});
