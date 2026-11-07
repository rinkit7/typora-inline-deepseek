import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {JSDOM} from 'jsdom';
import {browserEnvironment} from './helpers/browser-env.js';
import {inspectDeepSeekReplyBuilder} from '../src/deepseek-web.js';
import {createChatSession} from '../src/chat-session.js';
import {TyporaHost} from '../src/typora-host.js';

// Independent verification only. No production source or installed plugin is modified.
function conversationHTML(turns, {composerInside = false} = {}) {
  const messages = turns.map(([question,answer]) => `<div>${question}</div><section><div class="ds-markdown"><p>${answer}</p></div></section>`).join('');
  const composer = '<footer><textarea></textarea></footer>';
  return `<body><aside><a href="/a/chat/s/saved">Verification conversation</a></aside><main>${messages}${composerInside ? composer : ''}</main>${composerInside ? '' : composer}</body>`;
}
function withConversation(turns, options, verify) {
  const env = browserEnvironment(conversationHTML(turns,options));
  try {verify(inspectDeepSeekReplyBuilder());} finally {env.dispose();}
}
const shortTurns = [['question 1','answer 1'],['question 2','answer 2']];
const longTurns = [1,2,3].map(n => [`question ${n}`,String(n).repeat(50000)]);

test('two completed exchanges restore both questions and both answers in order', () => {
  withConversation(shortTurns,{},reader => {
    assert.deepEqual(reader.conversation().messages.map(m => [m.role,m.text]),shortTurns.flatMap(([q,a]) => [['user',q],['assistant',a]]));
  });
});

test('history picker renders two real extracted exchanges through the built UI', async () => {
  const env = browserEnvironment();
  const webpage = new JSDOM(conversationHTML(shortTurns),{url:'https://chat.deepseek.com/a/chat/s/saved'});
  let controller, url = 'https://chat.deepseek.com/', conversationReads = 0;
  try {
    env.window.reqnode = name => name === 'crypto' ? crypto : {readFileSync() {throw Error('No persisted state');},mkdirSync() {},writeFileSync() {}};
    const create = env.document.createElement.bind(env.document);
    env.document.createElement = (tag,...args) => {
      const node = create(tag,...args);
      if (tag === 'webview') {
        node.getURL = () => url;
        const set = node.setAttribute.bind(node);
        node.setAttribute = (key,value) => {set(key,value); if (key === 'src') url = value;};
        node.executeJavaScript = async script => {
          if (script.includes('.conversation()')) conversationReads++;
          // Execute the actual serialized reader against a separate webpage DOM;
          // do not stub conversation() with a fabricated list of messages.
          return new Function('document',`return ${script}`)(webpage.window.document);
        };
      }
      return node;
    };
    const {createWorkspaceChat} = await import('../src/workspace-controller.js');
    const {fireEvent,findByRole,findByText} = await import('@testing-library/dom');
    controller = createWorkspaceChat({editorSelection:new TyporaHost(env.window,env.document),getCurrentDocumentIdentity:() => ({key:'doc',label:'verification.md'}),app:{workspace:{on:() => () => {}}}});
    controller.askSelection({text:'Retained quote',key:'doc',label:'verification.md'});
    const mount = env.document.getElementById('deepseek-workspace').lastElementChild.shadowRoot.lastElementChild;
    fireEvent.click(await findByRole(mount,'button',{name:'历史问答',exact:true}));
    fireEvent.click(await findByRole(mount,'button',{name:/Verification conversation/}));
    for (const [question,answer] of shortTurns) {await findByText(mount,question); await findByText(mount,answer);}
    assert.equal(mount.querySelectorAll('.ds-message').length,4);
    assert.ok(conversationReads > 0);
  } finally {controller?.dispose(); webpage.window.close(); env.dispose();}
});

test('one completed exchange retains the user question', () => {
  withConversation([shortTurns[0]],{},reader => {
    assert.deepEqual(reader.conversation().messages.map(m => [m.role,m.text]),[['user','question 1'],['assistant','answer 1']]);
  });
});

test('two exchanges remain readable when their common container also includes the composer', () => {
  withConversation(shortTurns,{composerInside:true},reader => {
    assert.equal(reader.conversation().messages.length,4,'The composer must not cause the whole common ancestor to be skipped');
  });
});

test('three answers totaling 150k characters fit in the declared 200k character budget', () => {
  withConversation(longTurns,{},reader => {
    const messages = reader.conversation().messages;
    assert.equal(messages.length,6,'Expected all three question/answer pairs, not just the first two');
    assert.deepEqual(messages.filter(m => m.role === 'assistant').map(m => m.text.length),[50000,50000,50000]);
    assert.equal(messages.at(-1).text,reader.reply().text);
  });
});

test('the first live poll must not replace an earlier history answer with the newest answer', () => {
  withConversation(longTurns,{},reader => {
    const session = createChatSession();
    try {
      session.restore({messages:reader.conversation().messages},{resume:true});
      session.receive(reader.reply());
      const answers = session.getSnapshot().messages.filter(m => m.role === 'assistant');
      assert.deepEqual(answers.map(m => m.text[0]),['1','2','3'],'Each answer must remain paired with its own question after synchronization');
    } finally {session.dispose();}
  });
});

test('real DeepSeek virtual-list rows are collected across scrolling without page titles or duplicated turns', async () => {
  const env = browserEnvironment('<body><main><div>Page title Page title</div><div class="ds-virtual-list"><div class="ds-virtual-list-visible-items"></div></div><textarea></textarea><div>AI disclaimer</div></main></body>');
  try {
    const list = env.document.querySelector('.ds-virtual-list');
    const items = list.firstElementChild;
    let position = 900;
    const render = () => {
      const turn = Math.min(3,Math.floor(position / 300)) + 1;
      items.innerHTML = `<div data-virtual-list-item-key="${turn * 2 - 1}"><div>question ${turn}</div><button>复制</button></div>`
        + `<div data-virtual-list-item-key="${turn * 2}"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content"><p>answer ${turn}</p></div></div><div role="button">重新生成</div></div>`;
    };
    Object.defineProperties(list,{clientHeight:{get:() => 300},scrollHeight:{get:() => 1200},scrollTop:{get:() => position,set:value => {position = Math.max(0,Math.min(900,value)); render();}}});
    render();
    const script = `(${inspectDeepSeekReplyBuilder.toString()})().history()`;
    const result = await new Function('document',`return ${script}`)(env.document);
    assert.deepEqual(result.messages.map(m => [m.role,m.text]),[1,2,3,4].flatMap(n => [['user',`question ${n}`],['assistant',`answer ${n}`]]));
    assert.ok(result.messages.every(m => !Object.hasOwn(m,'webKey')));
    assert.equal(result.text,'answer 4');
    assert.equal(list.scrollTop,900,'the webpage ends at the latest answer for follow-up sends');
    assert.equal(list.style.scrollBehavior,'');
  } finally {env.dispose();}
});

test('keyed user questions that match toolbar labels or timestamps are preserved', () => {
  const env = browserEnvironment('<body><div class="ds-virtual-list"><div class="ds-virtual-list-visible-items">'
    + '<div data-virtual-list-item-key="q"><div>删除<br>复制<br>12:30<br>思考过程</div><button>复制</button></div>'
    + '<div data-virtual-list-item-key="a"><div class="ds-markdown ds-assistant-message-main-content">answer</div></div>'
    + '</div></div><textarea></textarea></body>');
  try {
    const result = inspectDeepSeekReplyBuilder().conversation();
    assert.equal(result.messages[0].text,'删除\n复制\n12:30\n思考过程');
    assert.equal(result.messages[0].role,'user');
  } finally {env.dispose();}
});

test('a virtual-list scan aborts when its source conversation changes', async () => {
  const env = browserEnvironment('<body><div class="ds-virtual-list"><div class="ds-virtual-list-visible-items"><div data-virtual-list-item-key="a"><div class="ds-markdown">old answer</div></div></div><textarea></textarea></body>');
  const timer = setTimeout(() => env.window.history.replaceState({},'', '/another-conversation'),20);
  try {
    await assert.rejects(inspectDeepSeekReplyBuilder().history(),/会话已改变/);
    assert.equal(env.document.querySelector('.ds-virtual-list').style.scrollBehavior,'');
  } finally {clearTimeout(timer); env.dispose();}
});
