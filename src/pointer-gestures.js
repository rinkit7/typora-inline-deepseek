// Own geometry input before it reaches Typora's document handlers. React is
// notified only after a completed size change, never for pointer movement.
export function createPointerGestures({shadow,actions,appearance,detached,runtime = window}) {
  let size = {width:appearance.loadReaderWidth(),height:appearance.loadReaderHeight?.() ?? 640}, active = null, frame = null, pending = null;
  let timer = null, saveWidth = null, saveHeight = null, report = null, disposed = false;
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
  const vertical = edge => edge === "top" || edge === "bottom";
  const edgeOf = handle => ["left","right","top","bottom"].find(edge => handle.classList.contains(`ds-resize-${edge}`));
  const publish = (edge,value) => {size = {...size,[vertical(edge) ? "height" : "width"]:value}; for (const callback of listeners) callback();};
  function rememberSize(edge,value) {
    publish(edge,value);
    if (vertical(edge)) saveHeight = value; else saveWidth = value;
  }
  function settle() {
    timer = null;
    if (saveWidth !== null) {appearance.saveReaderWidth(saveWidth); saveWidth = null;}
    if (saveHeight !== null) {appearance.saveReaderHeight?.(saveHeight); saveHeight = null;}
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
    const isVertical = vertical(edge), leading = edge === "left" || edge === "top";
    const origin = isVertical ? start.top : start.left, extent = isVertical ? start.height : start.width;
    const end = origin + extent, viewport = isVertical ? runtime.innerHeight : runtime.innerWidth;
    const maximum = Math.max(0,Math.min(isVertical ? 12000 : 640,viewport - 36,leading ? end - 18 : viewport - 18 - origin));
    const value = Math.round(Math.max(Math.min(isVertical ? 320 : 300,maximum),Math.min(maximum,extent + (leading ? -delta : delta))));
    if (isVertical) actions.resizeHeight(value,leading ? end - value : origin);
    else actions.resize(value,leading ? end - value : origin);
    return value;
  }
  function finish(reason) {
    if (!active) return;
    flush();
    const current = active; active = null;
    try {
      if (current.edge) {
        actions.endResize?.(); rememberSize(current.edge,current.size);
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
    const edge = source.classList.contains("ds-resize-edge") ? edgeOf(source) : null;
    const rect = actions.getPosition(), shield = shadow.ownerDocument.createElement("div");
    shield.className = edge ? "ds-resize-shield" : "ds-drag-shield";
    shield.style.cssText = `position:fixed;inset:0;z-index:999996;background:transparent;touch-action:none;user-select:none;cursor:${edge ? vertical(edge) ? "ns-resize" : "ew-resize" : "move"};`;
    shield.setAttribute("aria-hidden","true");
    shadow.ownerDocument.body.appendChild(shield);
    shadow.querySelector(".ds-settings")?.removeAttribute("open");
    active = {source,shield,edge,rect,x:event.clientX,y:event.clientY,size:vertical(edge) ? size.height : size.width,
      id:event.pointerId ?? null,started:now(),moves:0,mouseEvents:0,frames:0,slowFrames:0,maxFrameGapMs:0,maxQueueMs:0,lastFrame:null};
    if (edge) actions.startResize?.(rect,edge); else actions.startDrag?.(rect);
    if (active.id != null) source.setPointerCapture?.(active.id);
  }
  function move(event) {
    if (!matches(event)) return;
    stop(event);
    const current = active, x = event.clientX, y = event.clientY; current.moves++;
    schedule(() => {
      if (active !== current) return;
      if (current.edge) current.size = resizeTo(current.edge,current.rect,vertical(current.edge) ? y - current.y : x - current.x);
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
    if (detached) return;
    const handle = handleOf(event);
    if (!handle?.classList.contains("ds-resize-edge")) return;
    const edge = edgeOf(handle), keys = vertical(edge) ? ["ArrowUp","ArrowDown"] : ["ArrowLeft","ArrowRight"];
    if (!keys.includes(event.key)) return;
    stop(event);
    const value = resizeTo(edge,actions.getPosition(),(event.key === keys[0] ? -1 : 1) * (event.shiftKey ? 40 : 10));
    rememberSize(edge,value); defer();
  }
  function bind(name,handler) {runtime.addEventListener(name,handler,{capture:true,passive:false}); bindings.push([name,handler]);}
  bind("pointerdown",start); bind("pointermove",move);
  for (const name of ["pointerup","pointercancel","lostpointercapture"]) bind(name,end);
  for (const name of ["mousedown","mousemove","mouseup","dragstart","selectstart"]) bind(name,mouse);
  bind("keydown",key); bind("blur",() => finish("blur")); bind("resize",() => finish("viewport-resize"));
  actions.width(size.width); actions.height?.(size.height);
  return {subscribe(callback) {listeners.add(callback); return () => listeners.delete(callback);},getSnapshot:() => size,
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
