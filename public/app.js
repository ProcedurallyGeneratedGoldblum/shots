const VIDEO = /\.(mp4|webm|mov)$/i;
let items = [], base = '', cursor = null, view = [], current = -1;
const version = {}; // key -> timestamp, to show a replaced image instead of a cached copy

const $ = id => document.getElementById(id);
const urlFor = key => base + '/' + key.split('/').map(encodeURIComponent).join('/');
const fileName = key => key.split('/').pop();
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const monthOf = iso => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 1600);
}

async function load() {
  $('more').disabled = true;
  try {
    const r = await fetch('/api/list' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    if (r.status === 403) throw new Error('Not authorized. Is Cloudflare Access set up for this site?');
    if (!r.ok) throw new Error('Could not load the list (' + r.status + ').');
    const d = await r.json();
    base = d.base;
    items = items.concat(d.objects).sort((a, b) => b.uploaded.localeCompare(a.uploaded));
    cursor = d.cursor;
    render();
  } catch (e) {
    $('msg').style.display = 'block'; $('msg').textContent = e.message;
  }
  $('more').disabled = false;
}

function media(key, full) {
  const src = urlFor(key) + (version[key] ? '?v=' + version[key] : '');
  if (VIDEO.test(key)) {
    const v = document.createElement('video');
    v.src = src; v.preload = 'metadata'; v.playsInline = true;
    if (full) { v.controls = true; v.autoplay = true; } else { v.muted = true; }
    return v;
  }
  const img = document.createElement('img');
  img.src = src; img.alt = fileName(key); img.loading = full ? 'eager' : 'lazy'; img.decoding = 'async';
  return img;
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  view = q ? items.filter(o => o.key.toLowerCase().includes(q)) : items;
  $('count').textContent = view.length + (view.length === 1 ? ' item' : ' items') + (cursor ? '+' : '');
  $('msg').style.display = view.length ? 'none' : 'block';
  $('msg').textContent = items.length ? 'No matches.' : 'Nothing uploaded yet.';
  $('more').style.display = cursor ? 'block' : 'none';

  const g = $('gallery'); g.replaceChildren();
  let month = null, grid = null;
  view.forEach((o, i) => {
    const m = monthOf(o.uploaded);
    if (m !== month) {
      month = m;
      const h = document.createElement('h2'); h.textContent = m; g.append(h);
      grid = document.createElement('div'); grid.className = 'grid'; g.append(grid);
    }
    const tile = document.createElement('button');
    tile.className = 'tile'; tile.title = fileName(o.key) + ' · ' + fmtSize(o.size);
    tile.append(media(o.key, false));
    if (VIDEO.test(o.key)) {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'video'; tile.append(b);
    }
    tile.onclick = () => openLb(i);
    grid.append(tile);
  });
}

function openLb(i) {
  current = i;
  const o = view[i];
  $('lbName').textContent = fileName(o.key) + ' · ' + fmtSize(o.size) + ' · ' + new Date(o.uploaded).toLocaleString();
  $('lbStage').replaceChildren(media(o.key, true));
  $('lbAnnotate').hidden = VIDEO.test(o.key);
  $('lb').classList.add('open');
}
function closeLb() { $('lb').classList.remove('open'); $('lbStage').replaceChildren(); current = -1; }

$('lbCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(urlFor(view[current].key)); toast('Link copied'); }
  catch { toast('Copy failed'); }
};
$('lbAnnotate').onclick = () => {
  const o = view[current];
  window.ShotsAnnotate.open(o.key, { onSaved: saved => afterAnnotate(o, saved) });
};

async function afterAnnotate(original, saved) {
  if (saved.mode === 'replace') {
    version[saved.key] = Date.now();
    Object.assign(original, { size: saved.size });
  } else {
    items.unshift({ key: saved.key, size: saved.size, uploaded: saved.uploaded });
  }
  $('q').value = '';
  render();
  const i = view.findIndex(x => x.key === saved.key);
  if (i >= 0) openLb(i);
  try {
    await navigator.clipboard.writeText(urlFor(saved.key));
    toast(saved.mode === 'replace' ? 'Original replaced · link copied' : 'Saved as copy · link copied');
  } catch {
    toast(saved.mode === 'replace' ? 'Original replaced' : 'Saved as copy');
  }
}

$('lbOpen').onclick = () => window.open(urlFor(view[current].key), '_blank', 'noopener');
$('lbDel').onclick = async () => {
  const o = view[current];
  if (!confirm('Delete ' + fileName(o.key) + '? Its public link will stop working.')) return;
  const r = await fetch('/api/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: o.key })
  });
  if (!r.ok) { toast('Delete failed (' + r.status + ')'); return; }
  items = items.filter(x => x.key !== o.key);
  closeLb(); render(); toast('Deleted');
};
$('lbClose').onclick = closeLb;
$('lb').onclick = e => { if (e.target.id === 'lb' || e.target.id === 'lbStage') closeLb(); };
document.addEventListener('keydown', e => {
  if (current < 0) return;
  if (e.key === 'Escape') closeLb();
  if (e.key === 'ArrowRight' && current < view.length - 1) openLb(current + 1);
  if (e.key === 'ArrowLeft' && current > 0) openLb(current - 1);
});
$('q').addEventListener('input', render);
$('more').onclick = load;

load();
