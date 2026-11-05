const { Plugin } = window[Symbol.for("typora-plugin-core@v2")];

import { createWorkspaceChat } from "./workspace-controller.js";
import { createDetachedSession } from "./detached-session.js";
import { TyporaHost, getCurrentDocumentIdentity } from "./typora-host.js";

// This entry point has no provider, API, OAuth or GPT imports.
export default class DeepSeekPlugin extends Plugin {
  constructor() {
    super(...arguments);
    this.editorSelection = new TyporaHost();
  }

  onload() {
    this.detachedSession = createDetachedSession(this, () => this.inlineWebChat);
    this.inlineWebChat = createWorkspaceChat(this, {
      detachedHost:this.detachedSession.child,
      onDetach:payload => this.detachedSession.detach(payload),
      onDock:payload => this.detachedSession.dock(payload),
      isDetachedActive:() => this.detachedSession.isActive(),
      onInsert:this.detachedSession.child ? (text,targetId) => this.detachedSession.insert(text,targetId) : null,
      onClose:() => this.detachedSession.close(),
      onPeek:() => this.detachedSession.minimize(),
      onReveal:() => this.detachedSession.reveal(),
      onOpacity:this.detachedSession.child ? value => this.detachedSession.setOpacity(value) : null,
      onPin:this.detachedSession.child ? value => this.detachedSession.setPinned(value) : null,
      notifyHost:this.detachedSession.child ? () => this.detachedSession.notifyHost() : null
    });
    this.detachedSession.start();
  }

  onunload() {
    this.detachedSession?.dispose();
    this.inlineWebChat?.dispose();
  }

  getCurrentDocumentIdentity() { return getCurrentDocumentIdentity(); }

  async copyTextToClipboard(text) {
    const content = String(text || "");
    if (!content.trim()) return false;
    const clipboard = this.editorSelection.getElectronClipboard();
    if (clipboard?.writeText) { clipboard.writeText(content); return true; }
    try { await navigator.clipboard.writeText(content); return true; }
    catch (_) { return false; }
  }
}
