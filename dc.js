// dc.js: a small stand-in for the design canvas runtime, so each board runs as an ordinary web page.
// What a board is: a template (HTML with {{path}} values, <sc-if value>, <sc-for list as>, onClick/onInput="{{fn}}")
// plus a `class Component extends DCLogic` with renderVals() -> values, setState() -> re-render, componentDidMount().
// Re-renders are DIFFED into the page (morphdom), not rebuilt, so nothing flashes or restarts its animation when a timer ticks,
// focus and scroll stay put, and big screens stay quick. Events are delegated from the stage.
// Boards that drive their own DOM (no templating) are rendered once and left alone.
(function () {
  // haptics only after you've touched the page: browsers block (and log an error for) vibrate() before the first tap
  try { const vib = navigator.vibrate && navigator.vibrate.bind(navigator);
    if (vib) navigator.vibrate = (p) => { try { if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false; return vib(p); } catch (e) { return false; } }; } catch (e) {}
  const $ = (id) => document.getElementById(id);
  const TPL = $('dc-tpl').textContent, CODE = $('dc-logic').textContent;
  const PROPS = (() => { try { return JSON.parse($('dc-props').textContent || '{}'); } catch (e) { return {}; } })();
  const W = (PROPS.$preview && PROPS.$preview.width) || 390, H = (PROPS.$preview && PROPS.$preview.height) || 844;
  const EXTRA = +(document.body.dataset.extra || 0);   // room the demo adds under a board (the pinned nav bar)
  const stage = $('dc-stage'), frame = $('dc-frame') || stage;   // frame = the board plus any demo bar under it
  const bar = $('dc-bar');   // the nav / back bar: drawn at Today's size, outside the board's scaling
  stage.style.width = W + 'px'; stage.style.height = H + 'px'; frame.style.width = W + 'px'; frame.style.height = H + 'px';

  // ---- fit the board to the window. A phone keyboard shrinks the window's height: ignore that, so the screen doesn't jump or shrink
  let lastW = 0, lastH = 0;
  const fit = () => {
    const w = innerWidth, h = innerHeight;
    if (w === lastW && h < lastH) return;           // keyboard opened: keep the size we had
    lastW = w; lastH = h;
    const kT = Math.min(w / W, h / H), t = Math.max(0, (h - H * kT) / 2), k = EXTRA ? Math.min(w / W, (H - EXTRA) * kT / H) : kT;
    frame.style.transform = 'scale(' + k + ')';
    frame.style.left = Math.max(0, (w - W * k) / 2) + 'px'; frame.style.top = t + 'px';
    if (bar) { bar.style.transform = 'scale(' + kT + ')'; bar.style.left = Math.max(0, (w - W * kT) / 2) + 'px'; bar.style.top = (t + (H - EXTRA) * kT) + 'px'; }
  };
  addEventListener('resize', fit); fit();

  // ---- the logic class
  let queued = false, inst = null;
  class DCLogic {
    constructor(p) { this.props = p || {}; if (!this.state) this.state = {}; }
    setState(u) { const s = this.state || {}; const v = typeof u === 'function' ? u(s, this.props) : u; this.state = Object.assign({}, s, v || {});
      if (!queued) { queued = true; Promise.resolve().then(() => { queued = false; render(); }); } }
  }
  window.DCLogic = DCLogic;
  const Klass = (0, eval)('(' + CODE.replace(/class\s+Component\b/, 'class') + ')');
  inst = new Klass(Object.assign({}, PROPS)); window.__dc = inst;

  // ---- templating
  const get = (ctx, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
  const esc = (x) => String(x).replace(/"/g, '&quot;');
  let fns = [];
  const reFor = /<sc-for\s+list="\{\{\s*([\w.]+)\s*\}\}"\s+as="(\w+)"[^>]*>/g;
  function expand(str, ctx) {
    let out = '', i = 0;
    for (;;) {
      reFor.lastIndex = i; const m = reFor.exec(str); if (!m) { out += str.slice(i); break; }
      out += str.slice(i, m.index); let depth = 1, j = reFor.lastIndex;
      while (depth) { const o = str.indexOf('<sc-for', j), c = str.indexOf('</sc-for>', j); if (c < 0) { j = str.length + 9; break; } if (o >= 0 && o < c) { depth++; j = o + 7; } else { depth--; j = c + 9; } }
      const inner = str.slice(reFor.lastIndex, j - 9), list = get(ctx, m[1]) || [];
      out += (Array.isArray(list) ? list : []).map((it, ix) => expand(inner, Object.assign({}, ctx, { [m[2]]: it, index: ix }))).join(''); i = j;
    }
    let prev;
    do { prev = out; out = out.replace(/<sc-if\s+value="\{\{\s*(!?)([\w.]+)\s*\}\}"[^>]*>((?:(?!<sc-if)[\s\S])*?)<\/sc-if>/g, (mm, neg, k, inner) => { const v = get(ctx, k); return (neg ? !v : v) ? inner : ''; }); } while (out !== prev);
    out = out.replace(/\son([A-Z]\w*)="\{\{\s*([\w.]+)\s*\}\}"/g, (mm, ev, k) => { const f = get(ctx, k); if (typeof f !== 'function') return ''; fns.push(f); return ' data-dce-' + ev.toLowerCase() + '="' + (fns.length - 1) + '"'; });
    return out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (mm, k) => { const x = get(ctx, k); return typeof x === 'function' || x == null ? '' : esc(x); });
  }
  const templated = /<sc-(?:if|for)|\son[A-Z]\w*="\{\{/.test(TPL);

  // delegated events: one listener per event type on the stage, looked up against this render's handlers
  const evTypes = new Set(); TPL.replace(/\son([A-Z]\w*)="\{\{/g, (m, ev) => { evTypes.add(ev.toLowerCase()); return m; });
  evTypes.forEach((ev) => stage.addEventListener(ev, (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-dce-' + ev + ']'); if (!el || !stage.contains(el)) return;
    const f = fns[+el.getAttribute('data-dce-' + ev)]; if (f) f(e);
  }));

  let mounted = false;
  function render() {
    if (mounted && !templated) return;
    const vals = (inst.renderVals && inst.renderVals()) || {};
    fns = [];
    const html = expand(TPL, vals);
    if (!mounted || !window.morphdom) { stage.innerHTML = html; }
    else {
      const next = stage.cloneNode(false); next.innerHTML = html;
      window.morphdom(stage, next, { childrenOnly: true, onBeforeElUpdated: (from, to) => {
        if (from.isEqualNode(to)) return false;
        if (from === document.activeElement && (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA')) to.value = from.value;
        return true; } });
    }
    if (!mounted) { mounted = true; if (inst.componentDidMount) setTimeout(() => inst.componentDidMount(), 0); }
  }
  // wait for the fonts (so text measures right), but never more than a moment: after the first page they're cached anyway
  let started = false; const start = () => { if (started) return; started = true; render(); };
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(start, start); setTimeout(start, 500); } else start();
})();
