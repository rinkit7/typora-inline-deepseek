import test from "node:test";
import assert from "node:assert/strict";
import {browserEnvironment} from "./helpers/browser-env.js";
import {createChatSession} from "../src/chat-session.js";
import {createAppearanceStore} from "../src/appearance.js";
import {inspectDeepSeekReply} from "../src/deepseek-web.js";

test("extracted code blocks copy independently, preserving code exactly and reporting clipboard failure", async () => {
  const env = browserEnvironment('<body><div id="host"></div><div class="ds-markdown" id="source"></div></body>');
  const session = createChatSession(), copied = [];
  let ui, fail = false;
  try {
    const snippets = ['[Required(ErrorMessage = "请输入电影名称")]\n  public string? Title { get; set; }\n','[Range(1, 100)]\npublic decimal Price { get; set; }\n','  <script>literal</script>\nprint("复制下载 -7")\n'];
    const source = env.document.getElementById("source");
    snippets.forEach((code,index) => {
      const wrapper = env.document.createElement("div");
      wrapper.innerHTML = index < 2 ? '<div>csharp<span>复制</span><span>下载</span></div><pre><code></code></pre>' : '<pre><code></code></pre>';
      wrapper.querySelector("code").textContent = code; source.appendChild(wrapper);
    });
    const reply = inspectDeepSeekReply(); source.remove();
    const {mountChatUI} = await import("../dist/chat-ui.js");
    const {findAllByRole,findByRole,fireEvent,waitFor} = await import("@testing-library/dom");
    const shadow = env.document.getElementById("host").attachShadow({mode:"open"}), mount = env.document.createElement("div"); shadow.appendChild(mount);
    const appearance = createAppearanceStore({reqnode:() => ({readFileSync:() => "{}"})});
    ui = mountChatUI(mount,shadow,{session,appearance,detached:false,actions:{width() {},height() {},copy:async code => {if (fail) throw Error("剪贴板暂不可用"); copied.push(code);},getPosition:() => ({left:0,top:0})}});
    session.receive(reply);
    const buttons = await findAllByRole(mount,"button",{name:"复制代码"});
    assert.equal(buttons.length,3);
    assert.deepEqual([...mount.querySelectorAll("pre code")].map(node => node.textContent),snippets);
    assert.deepEqual([...mount.querySelectorAll(".ds-code-header>span")].map(node => node.textContent),["csharp","csharp","代码"]);
    assert.equal(mount.querySelector("script"),null,"HTML inside code stays inert text");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(buttons[i]);
      await waitFor(() => assert.equal(buttons[i].textContent,"已复制"));
      assert.equal(copied[i],snippets[i]);
    }
    fail = true; fireEvent.click(buttons[1]);
    const alert = await findByRole(mount,"alert"); assert.match(alert.textContent,/剪贴板暂不可用/);
    await waitFor(() => assert.equal(buttons[1].textContent,"复制代码"));
    assert.equal(copied.length,3);
    fail = false; fireEvent.click(buttons[1]);
    await waitFor(() => assert.equal(copied.length,4));
    assert.equal(copied[3],snippets[1]);
    fireEvent.click(await findByRole(mount,"button",{name:"复制",exact:true}));
    await waitFor(() => assert.equal(copied.length,5));
    assert.equal(copied[4],reply.text,"whole-answer copying remains available");
  } finally {ui?.dispose(); session.dispose(); env.dispose();}
});
