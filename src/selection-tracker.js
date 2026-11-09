// Capture document context before a menu/button can move focus to chat.
export function createSelectionTracker({host,getIdentity,view = document,runtime = window}) {
  let cached = null, consumed = null, disposed = false, suspended = false;
  const sameSelection = (a,b) => a && b && a.key === b.key && a.text === b.text && (a.cm ? a.cm.wrapper === b.cm?.wrapper && JSON.stringify(a.to) === JSON.stringify(b.to) : a.anchor?.node === b.anchor?.node && a.anchor?.offset === b.anchor?.offset);
  const valid = target => {
    if (!target || target.key !== getIdentity().key) return false;
    try {
      if (target.document !== host.getDocumentText()) return false;
      if (target.cm) return target.cm.wrapper.isConnected;
      return host.isChatCaretRangeUsable(target.range);
    } catch (_) {return false;}
  };
  function capture({fallback = true,fresh = false} = {}) {
    if (disposed || suspended) return null;
    try {
      const identity = getIdentity();
      if (cached && cached.key !== identity.key) cached = null;
      const selected = host.captureSelectionSnapshot(identity.key);
      if (selected?.text) {
        const range = host.captureInsertionRange(selected,runtime.getSelection());
        const current = {key:identity.key,label:identity.label,document:host.getDocumentText(),text:selected.text,
          range,anchor:range && {node:range.startContainer,offset:range.startOffset},cm:selected.codeMirror,to:selected.to};
        if (!fresh && sameSelection(current,consumed)) return null;
        cached = current;
        return cached;
      }
    } catch (_) {}
    return fallback && valid(cached) ? cached : null;
  }
  const record = event => {
    if (suspended) return;
    if (event?.type === "pointerdown" && !host.isEditorTarget(event.target)) return;
    if (["pointerdown","keyup","contextmenu"].includes(event?.type) && host.isEditorTarget(event.target)) consumed = null;
    capture({fallback:false});
  };
  const pointer = event => {
    // A new click/caret in the editor cancels an old selection. Moving into the
    // chat must preserve it, including before the native context menu opens.
    if (host.isEditorTarget(event.target)) {cached = null; consumed = null; record();}
  };
  for (const event of ["selectionchange","keyup","contextmenu"]) view.addEventListener(event,record,true);
  view.addEventListener("pointerup",pointer,true);
  view.addEventListener("pointerdown",record,true);
  return {
    capture,
    setSuspended(value) {suspended = !!value;},
    clear() {consumed = cached; cached = null;},
    dispose() {
      disposed = true; cached = null;
      for (const event of ["selectionchange","keyup","contextmenu"]) view.removeEventListener(event,record,true);
      view.removeEventListener("pointerup",pointer,true); view.removeEventListener("pointerdown",record,true);
    }
  };
}
