// Typora-specific APIs live here; the chat controller does not depend on any
// AI4Typora modules. See THIRD_PARTY_NOTICES.md for project provenance.
export function getCurrentDocumentIdentity(runtime = window) {
  let filename = runtime.File?.filePath || runtime.File?.bundle?.filePath || runtime._options?.initFilePath || "";
  if (!filename && runtime.location?.protocol === "file:") {
    try {
      const url = new URL(runtime.location.href);
      if (/\.md$/i.test(url.pathname)) filename = runtime.reqnode("url").fileURLToPath(url);
    } catch (_) {}
  }
  if (!filename) return {key:"unsaved",persistable:false,path:"",label:"未保存文档"};
  const path = runtime.reqnode("path").win32.normalize(String(filename)).toLowerCase();
  return {key:`file:${path}`,persistable:true,path,label:path.split("\\").at(-1)};
}

export class TyporaHost {
  constructor(runtime = window, view = document) { this.runtime = runtime; this.view = view; }

  isEditorTarget(node) { return !!node?.closest?.("#write,.CodeMirror"); }

  isChatCaretRangeUsable(range, write = this.view.getElementById("write")) {
    if (!range || !write) return false;
    return [range.startContainer,range.endContainer].every(node => node?.isConnected && write.contains(node));
  }

  captureInsertionRange(snapshot, selection = this.runtime.getSelection()) {
    const source = snapshot?.range || (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!this.isChatCaretRangeUsable(source)) return null;
    const result = source.cloneRange(); result.collapse(false); return result;
  }

  captureSelectionSnapshot(documentId) {
    const selection = this.runtime.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const anchor = range?.startContainer;
    const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    const write = this.view.getElementById("write");
    const wrapper = this.view.activeElement?.closest?.(".CodeMirror") || element?.closest?.(".CodeMirror");
    const cm = wrapper?.CodeMirror;
    if (wrapper?.isConnected && write?.contains(wrapper) && cm?.getSelection && cm?.getCursor && cm?.replaceRange) {
      const text = String(cm.getSelection());
      if (text) return {documentId,text,codeMirror:{wrapper,editor:cm},to:{...cm.getCursor("to")}};
    }
    if (selection?.isCollapsed || !this.isChatCaretRangeUsable(range,write)) return null;
    let text = String(range);
    // Ask Typora's Markdown serializer for the selection without touching the
    // system clipboard. Always restore the host's copy flag, including errors.
    const file = this.runtime.File, serialize = file?.editor?.UserOp?.copyAsMarkdown;
    if (serialize && !file._CopyContentFlag) {
      const previous = file._CopyContentFlag;
      try {
        file._CopyContentFlag = true;
        let markdown = "";
        serialize.call(file.editor.UserOp,file.editor,{
          type:"copy",preventDefault() {},clipboardData:{setData(type,value) {
            if (type === "text/plain") markdown = String(value);
          }}
        });
        if (markdown) text = markdown;
      } catch (_) {} finally { file._CopyContentFlag = previous; }
    }
    return text ? {documentId,text,range:range.cloneRange()} : null;
  }

  getDocumentText() {
    const editor = this.runtime.File?.editor || this.runtime.editor;
    if (typeof editor?.getMarkdown !== "function") throw Error("无法读取当前文档，请重新打开问答后重试。");
    return String(editor.getMarkdown());
  }

  getElectronClipboard() {
    try { return this.runtime.reqnode("electron").clipboard || null; } catch (_) { return null; }
  }

  async readClipboardText() {
    const clipboard = this.getElectronClipboard();
    try { if (clipboard?.readText) return String(clipboard.readText()); } catch (_) {}
    try { return await this.runtime.navigator.clipboard.readText(); } catch (_) { return ""; }
  }
}

export function showToast(message) {
  document.getElementById("deepseek-inline-notice")?.remove();
  const toast = document.createElement("div");
  toast.id = "deepseek-inline-notice"; toast.setAttribute("role","status"); toast.textContent = message;
  toast.style.cssText = "position:fixed;z-index:999999;left:50%;top:40px;transform:translateX(-50%);padding:10px 18px;border-radius:10px;background:#253047;color:white;font:14px/1.5 system-ui;box-shadow:0 6px 24px #0002";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(),2600);
}
