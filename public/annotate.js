// Shots annotation editor: draw on an uploaded image, then save it as a copy or
// replace the original. Plain canvas, no libraries.
//
// Annotations are kept as a list of shapes and redrawn over the original on every
// change, so undo/redo is exact and the export is at full resolution.

(() => {
  const TOOLS = [
    { id: 'arrow', label: 'Arrow', key: 'a' },
    { id: 'box', label: 'Box', key: 'b' },
    { id: 'pen', label: 'Pen', key: 'p' },
    { id: 'text', label: 'Text', key: 't' },
    { id: 'highlight', label: 'Highlight', key: 'h' },
    { id: 'pixelate', label: 'Pixelate', key: 'x' },
  ];
  const COLORS = ['#e53935', '#fdd835', '#43a047', '#1e88e5', '#111111', '#ffffff'];
  const SIZES = [{ id: 's', label: 'S', px: 3 }, { id: 'm', label: 'M', px: 6 }, { id: 'l', label: 'L', px: 11 }];
  const OUTPUT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

  let el = null;          // editor DOM
  let ctx = null;         // visible canvas context (full image resolution)
  let image = null;       // ImageBitmap of the original
  let scale = 1;          // stroke scaling for large images
  let ops = [], redo = [], drawing = null;
  let tool = 'arrow', color = COLORS[0], size = SIZES[1];
  let source = null, outType = 'image/png', canReplace = false, onSaved = null, busy = false;

  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  };

  function build() {
    const toolBtns = TOOLS.map(t => h('button', {
      className: 'ed-tool', textContent: t.label, title: `${t.label} (${t.key.toUpperCase()})`,
      onclick: () => setTool(t.id),
    }));
    toolBtns.forEach((b, i) => (b.dataset.tool = TOOLS[i].id));

    const swatches = COLORS.map(c => {
      const b = h('button', { className: 'ed-swatch', title: c, onclick: () => setColor(c) });
      b.style.background = c;
      b.dataset.color = c;
      return b;
    });
    const sizes = SIZES.map(s => {
      const b = h('button', { className: 'ed-size', textContent: s.label, title: 'Line width', onclick: () => setSize(s) });
      b.dataset.size = s.id;
      return b;
    });

    const canvas = h('canvas', { id: 'edCanvas' });
    const textInput = h('input', { id: 'edText', type: 'text', placeholder: 'Type, then Enter', autocomplete: 'off' });

    el = h('div', { id: 'ed', role: 'dialog', ariaModal: 'true', ariaLabel: 'Annotate image' },
      h('div', { className: 'ed-bar' },
        h('div', { className: 'ed-group' }, ...toolBtns),
        h('div', { className: 'ed-group' }, ...swatches),
        h('div', { className: 'ed-group' }, ...sizes),
        h('div', { className: 'ed-group' },
          h('button', { id: 'edUndo', textContent: 'Undo', title: 'Undo (Ctrl+Z)', onclick: undo }),
          h('button', { id: 'edRedo', textContent: 'Redo', title: 'Redo (Ctrl+Y)', onclick: doRedo })),
        h('span', { className: 'ed-spacer' }),
        h('div', { className: 'ed-group' },
          h('button', { id: 'edCancel', textContent: 'Cancel', onclick: () => close(false) }),
          h('button', { id: 'edCopy', className: 'ed-primary', textContent: 'Save as copy', onclick: () => save('copy') }),
          h('button', { id: 'edReplace', className: 'ed-danger', textContent: 'Replace original', onclick: () => save('replace') }))),
      h('div', { className: 'ed-stage', id: 'edStage' }, canvas, textInput),
      h('div', { className: 'ed-status', id: 'edStatus' }));

    document.body.append(el);
    ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => { drawing = null; paint(); });
    textInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') commitText();
      if (e.key === 'Escape') { e.stopPropagation(); hideText(); }
    });
    textInput.addEventListener('blur', commitText);
    document.addEventListener('keydown', keys, true);
  }

  // ---- State setters ------------------------------------------------------------

  function setTool(id) {
    commitText();
    tool = id;
    el.querySelectorAll('.ed-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === id));
    $c().style.cursor = id === 'text' ? 'text' : 'crosshair';
  }
  function setColor(c) {
    color = c;
    el.querySelectorAll('.ed-swatch').forEach(b => b.classList.toggle('on', b.dataset.color === c));
  }
  function setSize(s) {
    size = s;
    el.querySelectorAll('.ed-size').forEach(b => b.classList.toggle('on', b.dataset.size === s.id));
  }
  const $c = () => el.querySelector('#edCanvas');
  const status = t => (el.querySelector('#edStatus').textContent = t || '');

  function refreshButtons() {
    el.querySelector('#edUndo').disabled = !ops.length || busy;
    el.querySelector('#edRedo').disabled = !redo.length || busy;
    el.querySelector('#edCopy').disabled = !ops.length || busy;
    el.querySelector('#edReplace').disabled = !ops.length || busy || !canReplace;
    el.querySelector('#edReplace').title = canReplace
      ? 'Overwrite the original: existing links will show the annotated version'
      : 'This file type can only be saved as a copy';
  }

  // ---- Coordinates --------------------------------------------------------------

  function point(e) {
    const r = $c().getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (image.width / r.width)),
      y: Math.round((e.clientY - r.top) * (image.height / r.height)),
    };
  }
  const rect = (a, b) => ({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
  });

  // ---- Drawing input ------------------------------------------------------------

  function down(e) {
    if (busy || e.button > 0) return;
    const p = point(e);
    // preventDefault stops the click from pulling focus back off the text box.
    if (tool === 'text') { e.preventDefault(); showText(e, p); return; }
    commitText();
    $c().setPointerCapture(e.pointerId);
    const width = size.px * scale;
    drawing = tool === 'pen'
      ? { type: 'pen', color, width, points: [p] }
      : { type: tool, color, width, from: p, to: p };
  }

  function move(e) {
    if (!drawing) return;
    const p = point(e);
    if (drawing.type === 'pen') drawing.points.push(p); else drawing.to = p;
    paint();
  }

  function up() {
    if (!drawing) return;
    const d = drawing;
    drawing = null;
    const tiny = d.type === 'pen'
      ? d.points.length < 2
      : Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 4 * scale;
    if (!tiny) { ops.push(d); redo = []; }
    paint();
  }

  // ---- Text entry -----------------------------------------------------------------

  let pendingText = null;
  function showText(e, p) {
    commitText();
    const input = el.querySelector('#edText');
    const stage = el.querySelector('#edStage').getBoundingClientRect();
    pendingText = p;
    input.value = '';
    input.style.left = (e.clientX - stage.left) + 'px';
    input.style.top = (e.clientY - stage.top) + 'px';
    input.style.color = color;
    input.classList.add('on');
    input.focus(); // synchronously, so no early keystrokes are lost
  }
  function hideText() {
    pendingText = null;
    el.querySelector('#edText').classList.remove('on');
  }
  function commitText() {
    if (!pendingText) return;
    const text = el.querySelector('#edText').value.trim();
    const at = pendingText;
    hideText();
    if (text) {
      ops.push({ type: 'text', color, text, x: at.x, y: at.y, px: (12 + size.px * 3) * scale });
      redo = [];
      paint();
    }
  }

  // ---- Rendering --------------------------------------------------------------------

  function arrow(c, o) {
    const { from: a, to: b, width } = o;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(12, width * 4);
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
    c.stroke();
    c.beginPath();
    c.moveTo(b.x, b.y);
    c.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7));
    c.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7));
    c.closePath();
    c.fill();
  }

  function pixelate(c, r) {
    if (r.w < 2 || r.h < 2) return;
    const block = Math.max(6, Math.round(Math.min(r.w, r.h) / 12), Math.round(10 * scale));
    const tw = Math.max(1, Math.round(r.w / block)), th = Math.max(1, Math.round(r.h / block));
    const tmp = new OffscreenCanvas(tw, th);
    const t = tmp.getContext('2d');
    t.drawImage(c.canvas, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    c.save();
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h);
    c.restore();
  }

  function drawOp(c, o) {
    c.save();
    c.strokeStyle = c.fillStyle = o.color;
    c.lineWidth = o.width;
    c.lineCap = c.lineJoin = 'round';
    if (o.type === 'arrow') arrow(c, o);
    else if (o.type === 'box') { const r = rect(o.from, o.to); c.strokeRect(r.x, r.y, r.w, r.h); }
    else if (o.type === 'highlight') { const r = rect(o.from, o.to); c.globalAlpha = 0.35; c.fillRect(r.x, r.y, r.w, r.h); }
    else if (o.type === 'pixelate') pixelate(c, rect(o.from, o.to));
    else if (o.type === 'pen') {
      c.beginPath();
      o.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    } else if (o.type === 'text') {
      c.font = `600 ${o.px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      c.textBaseline = 'top';
      c.lineWidth = Math.max(2, o.px / 7);
      c.strokeStyle = o.color === '#111111' ? '#ffffff' : '#000000';
      c.strokeText(o.text, o.x, o.y);
      c.fillText(o.text, o.x, o.y);
    }
    c.restore();
  }

  function renderTo(c, withDraft) {
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.drawImage(image, 0, 0);
    ops.forEach(o => drawOp(c, o));
    if (withDraft && drawing) drawOp(c, drawing);
  }

  function paint() {
    renderTo(ctx, true);
    refreshButtons();
  }

  // ---- Undo / redo / keys -------------------------------------------------------------

  function undo() { commitText(); if (ops.length) { redo.push(ops.pop()); paint(); } }
  function doRedo() { if (redo.length) { ops.push(redo.pop()); paint(); } }

  function keys(e) {
    if (!el || !el.classList.contains('open')) return;
    if (document.activeElement === el.querySelector('#edText')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    else if (!mod && !e.altKey) {
      const t = TOOLS.find(x => x.key === e.key.toLowerCase());
      if (t) setTool(t.id);
    }
    e.stopPropagation(); // keep the gallery's arrow-key navigation out of the editor
  }

  // ---- Open / save / close --------------------------------------------------------------

  async function open(key, opts = {}) {
    if (!el) build();
    source = key;
    onSaved = opts.onSaved || null;
    const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    outType = OUTPUT[ext] || 'image/png';
    canReplace = Boolean(OUTPUT[ext]);
    ops = []; redo = []; drawing = null; busy = false;
    hideText();
    setTool(tool); setColor(color); setSize(size);
    el.classList.add('open');
    status('Loading image…');
    ctx.canvas.width = ctx.canvas.height = 1;
    refreshButtons();

    try {
      const r = await fetch('/api/raw?key=' + encodeURIComponent(key));
      if (!r.ok) throw new Error('Could not load the image (' + r.status + ')');
      image = await createImageBitmap(await r.blob());
    } catch (e) {
      status(e.message);
      return;
    }
    ctx.canvas.width = image.width;
    ctx.canvas.height = image.height;
    scale = Math.max(1, Math.max(image.width, image.height) / 1400);
    status(canReplace ? '' : 'This file type can only be saved as a copy (PNG).');
    paint();
  }

  function close(force) {
    if (!force && busy) return;
    if (!force && ops.length && !confirm('Discard your annotations?')) return;
    commitText();
    el.classList.remove('open');
    if (image) { image.close?.(); image = null; }
    ops = []; redo = [];
  }

  async function save(mode) {
    commitText();
    if (!ops.length || busy) return;
    if (mode === 'replace' && !confirm(
      'Replace the original? Anyone with its link will see the annotated version, and the original is gone.')) return;

    busy = true; refreshButtons(); status('Saving…');
    try {
      const out = new OffscreenCanvas(image.width, image.height);
      renderTo(out.getContext('2d'), false);
      const blob = await out.convertToBlob({ type: outType, quality: 0.92 });
      const r = await fetch(`/api/upload?mode=${mode}&source=${encodeURIComponent(source)}`, {
        method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
      });
      if (!r.ok) throw new Error((await r.text()) || 'Save failed (' + r.status + ')');
      const saved = await r.json();
      busy = false;
      close(true);
      onSaved && onSaved(saved);
    } catch (e) {
      busy = false; refreshButtons();
      status('Save failed: ' + e.message);
    }
  }

  window.ShotsAnnotate = { open };
})();
