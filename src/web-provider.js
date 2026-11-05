
export function registerDeepSeekMenu(workspace, captureTarget, open) {
  return workspace.on("editor-menu", ({ menu }) => {
    const captured = captureTarget();
    menu.addSeparator();
    menu.addItem(item => item
      .setKey("typora-deepseek.ask")
      .setTitle("✦ DeepSeek 问答")
      .onClick(event => {
        event?.preventDefault();
        menu.close();
        open(captured);
      }));
  });
}

export function buildWebQuestion(selection, question) {
  const q = String(question || "").trim();
  if (!q) throw new Error("请输入问题。");
  return selection
    ? `请根据以下选中文字回答问题，使用中文和 Markdown；不要改写原文，除非问题明确要求。\n\n<选中文字>\n${selection}\n</选中文字>\n\n问题：${q}`
    : q;
}

export function canInsertAtSnapshot(snapshot, identity, currentText) {
  return !!snapshot && snapshot.key === identity.key && snapshot.document === currentText;
}

export function inspectWebPageReady() {
  return document.readyState === "interactive" || document.readyState === "complete";
}

export function executeWebScript(page,code,userGesture = false,timeout = 6000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => page.executeJavaScript(code,userGesture)),
    new Promise((_,reject) => {timer = setTimeout(() => reject(Error("网页暂未确认操作，请切换“网页模式”查看状态；不会自动重复发送。")),timeout);})
  ]).finally(() => clearTimeout(timer));
}

export function createWebviewLifecycle(webview, onState = () => {}, options = {}) {
  let disposed = false;
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = options.attempts || 25;
  const handlers = [];
  const bind = (event, handler) => {
    webview.addEventListener(event, handler);
    handlers.push([event, handler]);
  };
  async function probe() {
    if (disposed || typeof webview.executeJavaScript !== "function") return false;
    try {
      const loaded = await executeWebScript(webview,`(${inspectWebPageReady.toString()})()`,false,1000);
      if (disposed) return false;
      onState({ ready:!!loaded });
      return !!loaded;
    } catch (_) {
      if (!disposed) onState({ ready:false });
      return false;
    }
  }
  bind("did-start-loading", () => onState({ ready:false, loading:true }));
  // SPA route changes and completion of non-document loads do not guarantee dom-ready.
  for (const event of ["dom-ready", "did-finish-load", "did-stop-loading", "did-navigate-in-page"]) {
    bind(event, () => { void probe(); });
  }
  bind("did-fail-load", event => {
    if (event.errorCode !== -3 && event.isMainFrame !== false) {
      onState({ ready:false, error:event.errorDescription });
    }
  });
  return {
    probe,
    async ensureReady() {
      // Always inspect the live document; a cached loading flag can be stale.
      for (let attempt = 0; attempt < attempts && !disposed; attempt++) {
        if (await probe()) return;
        if (attempt + 1 < attempts) await pause(100);
      }
      throw Error("DeepSeek 网页仍在加载，请稍后再发送。已有会话无需刷新。");
    },
    dispose() {
      disposed = true;
      for (const [event, handler] of handlers) webview.removeEventListener(event, handler);
    }
  };
}

// This code runs inside DeepSeek's isolated web page, with no Node access.
export function fillWebComposer(text) {
  const el = document.querySelector('textarea:not([disabled])');
  if (!el) return { ok: false, reason: document.querySelector('textarea[disabled]')
    ? "上一条回答尚未结束，请等待生成完成后再提问。"
    : "请先在下面的 DeepSeek 页面登录，登录后再发送。" };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
  return { ok: true };
}

export function readWebAnswer() {
  // DeepSeek renders assistant Markdown in ds-markdown; do not read auth/storage.
  const blocks = [...document.querySelectorAll(".ds-markdown")];
  const last = blocks.at(-1);
  return last ? String(last.innerText || "").trim() : "";
}

export async function submitWebComposer() {
  const input = document.querySelector('textarea:not([disabled])');
  if (!input?.value.trim()) return { ok: false, reason: "网页输入框为空。" };
  const isEnabled = button => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !button.disabled
      && button.getAttribute("aria-disabled") !== "true"
      && !button.classList.contains("ds-icon-button--disabled")
      && !button.classList.contains("ds-button--disabled");
  };
  const labels = button => ["aria-label", "title", "data-testid"].map(key => button.getAttribute(key) || "").join(" ");
  function findButton() {
    let scope = input.parentElement;
    for (let level = 0; scope && level < 8 && scope !== document.body; level++, scope = scope.parentElement) {
      // Stay within the composer, away from sidebar and conversation controls.
      if (scope.querySelector(".ds-markdown")) break;
      const buttons = [...scope.querySelectorAll('button,[role="button"]')];
      const labelled = buttons.find(button => isEnabled(button) && /send|发送|提交/i.test(labels(button)) && !/stop|停止|取消/i.test(labels(button)));
      if (labelled) return labelled;
      const submit = scope.querySelector('button[type="submit"]');
      if (submit && isEnabled(submit)) return submit;
      // Current DeepSeek uses an unlabelled primary filled circular button.
      // These classes were confirmed in this installation's composer diagnostics.
      const circular = scope.querySelector('.ds-button--primary.ds-button--filled.ds-button--circle');
      if (circular && isEnabled(circular) && !/stop|停止|取消/i.test(labels(circular))) return circular;
      // Known DeepSeek composer layout: upload input immediately precedes send.
      const adjacent = scope.querySelector('input[type="file"] + [role="button"]');
      if (adjacent && isEnabled(adjacent) && !/stop|停止|取消/i.test(labels(adjacent))) return adjacent;
    }
    return null;
  }
  let button;
  for (let attempt = 0; attempt < 12; attempt++) {
    button = findButton();
    if (button) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!button) {
    const candidates = [];
    let scope = input.parentElement;
    for (let level = 0; scope && level < 6 && scope !== document.body; level++, scope = scope.parentElement) {
      if (scope.querySelector(".ds-markdown")) break;
      for (const item of scope.querySelectorAll('button,[role="button"],.ds-icon-button,input[type="file"]')) {
        const data = { tag:item.tagName, role:item.getAttribute("role"), label:labels(item), className:String(item.className), disabled:item.getAttribute("aria-disabled"), svgViewBox:item.querySelector("svg")?.getAttribute("viewBox") || "" };
        if (!candidates.some(x => JSON.stringify(x) === JSON.stringify(data))) candidates.push(data);
      }
    }
    return { ok:false, reason:"未识别到可用的网页发送按钮，请点击网页自身的发送按钮。", candidates };
  }
  button.click();
  // Never retry a click: a delayed successful submission must not be duplicated.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!input.isConnected || !input.value.trim()) return { ok:true };
  }
  return { ok:false, reason:"已点击网页发送按钮，但尚未确认发送。请查看网页状态；不会重复发送。" };
}
