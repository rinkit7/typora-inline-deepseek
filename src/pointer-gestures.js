// Own geometry input before it reaches Typora's document handlers. React is
// notified only after a completed width change, never for pointer movement.
export function createPointerGestures({shadow,actions,appearance,detached,runtime = window}) {
  let width = appearance.loadReaderWidth(), active = null, frame = null, pending = null;
  let timer = null, saveWidth = null, report = null, disposed = false;
  const listeners = new Set(), bindings = [];
  const now = () => runtime.performance.now();
  const pathOf = event => event.composedPath();
  function handleOf(event) {
    return pathOf(event).find(node => node?.getRootNode?.() === shadow && node.matches?.(".ds-header,.ds-resize-edge"));
  }
  function isControl(event,handle) {
    for (const node of pathOf(event)) {
      if (node === handle) break;
      if (node?.matches?.("button,input,textarea,summary,details,label,a,select")) return true;
    }
    return false;
  }
  const stop = event => {event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault();};
  const matches = event => active && (active.id == null || event.pointerId == null || event.pointerId === active.id);
  const publish = value => {width = value; for (const callback of listeners) callback();};
  function settle() {
    timer = null;
    if (saveWidth !== null) {appearance.saveReaderWidth(saveWidth); saveWidth = null;}
    if (report) {actions.motionStats?.(report); report = null;}
  }
  function defer() {if (timer !== null) runtime.clearTimeout(timer); timer = runtime.setTimeout(settle,120);}
  function flush() {
    if (frame !== null) runtime.cancelAnimationFrame(frame);
    frame = null;
    const work = pending; pending = null; work?.();
  }
  function schedule(work) {
    pending = work;
    if (frame !== null) return;
    const queued = now();
    frame = runtime.requestAnimationFrame(() => {
      frame = null;
      if (active) {
        const time = now(), gap = active.lastFrame == null ? 0 : time - active.lastFrame;
        active.frames++; active.maxFrameGapMs = Math.max(active.maxFrameGapMs,gap);
        active.maxQueueMs = Math.max(active.maxQueueMs,time - queued);
        if (gap > 34) active.slowFrames++;
        active.lastFrame = time;
      }
      const latest = pending; pending = null; latest?.();
    });
  }
  function resizeTo(edge,start,delta) {
    const right = start.left + start.width;
    const maximum = Math.max(0,Math.min(640,runtime.innerWidth - 36,edge === "left" ? right - 18 : runtime.innerWidth - 18 - start.left));
    const value = Math.round(Math.max(Math.min(300,maximum),Math.min(maximum,start.width + (edge === "left" ? -delta : delta))));
    actions.resize(value,edge === "left" ? right - value : start.left);
    return value;
  }
  function finish(reason) {
    if (!active) return;
    flush();
    const current = active; active = null;
    try {
      if (current.edge) {
        actions.endResize?.(); publish(current.width); saveWidth = current.width;
      } else actions.endDrag?.();
    } finally {
      current.shield.remove();
      if (current.id != null && current.source.hasPointerCapture?.(current.id)) current.source.releasePointerCapture(current.id);
    }
    report = {implementation:"native-capture-v1",kind:current.edge ? "resize" : "drag",reason,
      durationMs:Math.round(now() - current.started),pointerMoves:current.moves,blockedMouseEvents:current.mouseEvents,
      frames:current.frames,slowFrames:current.slowFrames,maxFrameGapMs:Math.round(current.maxFrameGapMs),maxQueueMs:Math.round(current.maxQueueMs)};
    defer();
  }
  function start(event) {
    if (detached || disposed || event.button !== 0 || event.isPrimary === false) return;
    const source = handleOf(event);
    if (!source || isControl(event,source)) return;
    stop(event);
    if (active) finish("replaced");
    // A previous release may have scheduled persistence. Never let that
    // synchronous filesystem work fire in the middle of the next gesture.
    if (timer !== null) {runtime.clearTimeout(timer); timer = null;}
    const edge = source.classList.contains("ds-resize-edge") ? (source.classList.contains("ds-resize-left") ? "left" : "right") : null;
    const rect = actions.getPosition(), shield = shadow.ownerDocument.createElement("div");
    shield.className = edge ? "ds-resize-shield" : "ds-drag-shield";
    shield.style.cssText = `position:fixed;inset:0;z-index:999996;background:transparent;touch-action:none;user-select:none;cursor:${edge ? "ew-resize" : "move"};`;
    shield.setAttribute("aria-hidden","true");
    shadow.ownerDocument.body.appendChild(shield);
    shadow.querySelector(".ds-settings")?.removeAttribute("open");
    active = {source,shield,edge,rect,x:event.clientX,y:event.clientY,width,
      id:event.pointerId ?? null,started:now(),moves:0,mouseEvents:0,frames:0,slowFrames:0,maxFrameGapMs:0,maxQueueMs:0,lastFrame:null};
    if (edge) actions.startResize?.(rect); else actions.startDrag?.(rect);
    if (active.id != null) source.setPointerCapture?.(active.id);
  }
  function move(event) {
    if (!matches(event)) return;
    stop(event);
    const current = active, x = event.clientX, y = event.clientY; current.moves++;
    schedule(() => {
      if (active !== current) return;
      if (current.edge) current.width = resizeTo(current.edge,current.rect,x - current.x);
      else actions.drag(current.rect.left + x - current.x,current.rect.top + y - current.y);
    });
  }
  function end(event) {if (matches(event)) {stop(event); finish(event.type);}}
  function mouse(event) {
    if (detached) return;
    if (active) {active.mouseEvents++; stop(event); return;}
    const handle = handleOf(event);
    if (handle && !isControl(event,handle)) stop(event);
  }
  function key(event) {
    if (detached || !["ArrowLeft","ArrowRight"].includes(event.key)) return;
    const handle = handleOf(event);
    if (!handle?.classList.contains("ds-resize-edge")) return;
    stop(event);
    const edge = handle.classList.contains("ds-resize-left") ? "left" : "right";
    const value = resizeTo(edge,actions.getPosition(),(event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10));
    publish(value); saveWidth = value; defer();
  }
  function bind(name,handler) {runtime.addEventListener(name,handler,{capture:true,passive:false}); bindings.push([name,handler]);}
  bind("pointerdown",start); bind("pointermove",move);
  for (const name of ["pointerup","pointercancel","lostpointercapture"]) bind(name,end);
  for (const name of ["mousedown","mousemove","mouseup","dragstart","selectstart"]) bind(name,mouse);
  bind("keydown",key); bind("blur",() => finish("blur")); bind("resize",() => finish("viewport-resize"));
  actions.width(width);
  return {subscribe(callback) {listeners.add(callback); return () => listeners.delete(callback);},getSnapshot:() => width,
    dispose() {
      disposed = true;
      if (frame !== null) runtime.cancelAnimationFrame(frame);
      frame = null; pending = null;
      active?.shield.remove(); active = null;
      for (const [name,handler] of bindings) runtime.removeEventListener(name,handler,true);
      if (timer !== null) runtime.clearTimeout(timer);
      settle(); listeners.clear();
    }};
}
