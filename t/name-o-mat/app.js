(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  // ---------- shared helpers ----------
  const randInt = (n) => {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  };
  const randFloat = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;

  // ---------- shared confetti ----------
  const fx = $('fx'), fctx = fx.getContext('2d');
  let particles = [], fxRunning = false;
  const CONFETTI = ['#1f4e8c', '#4b86d1', '#2a7f8e', '#d4a72c', '#a23e48', '#6b5b95', '#ffffff'];

  function sizeFx() {
    const dpr = window.devicePixelRatio || 1;
    fx.width = innerWidth * dpr; fx.height = innerHeight * dpr;
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function celebrate(originEl) {
    sizeFx();
    const rect = originEl.getBoundingClientRect();
    const ox = rect.left + rect.width / 2, oy = rect.top + rect.height * 0.12;
    for (let i = 0; i < 140; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const sp = 6 + Math.random() * 9;
      particles.push({
        x: ox, y: oy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
        rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.4,
        color: CONFETTI[randInt(CONFETTI.length)], life: 0, max: 110 + Math.random() * 50,
      });
    }
    if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxFrame); }
  }

  function fxFrame() {
    fctx.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => p.life < p.max);
    for (const p of particles) {
      p.life++;
      p.vy += 0.28; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      fctx.save();
      fctx.globalAlpha = Math.min(1, (p.max - p.life) / 30);
      fctx.translate(p.x, p.y);
      fctx.rotate(p.rot);
      fctx.fillStyle = p.color;
      fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fctx.restore();
    }
    if (particles.length) requestAnimationFrame(fxFrame);
    else { fxRunning = false; fctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  addEventListener('resize', () => { if (fxRunning) sizeFx(); });

  // ===================================================================
  // Rad-Variante
  // ===================================================================
  (() => {
    const COLORS = ['#1f4e8c', '#2a7f8e', '#4a6fa5', '#3d8b6f', '#6b5b95', '#b5651d', '#7a8ba3', '#a23e48'];
    const canvas = $('wheel'), ctx = canvas.getContext('2d');
    const spinBtn = $('spin'), resetBtn = $('reset'), fileInput = $('file');
    const statusEl = $('status'), emptyEl = $('empty'), wrap = $('wheelWrap');

    let allNames = [], names = [], done = [], rotation = 0, busy = false;

    const setStatus = (msg, isError = false) => {
      statusEl.textContent = msg;
      statusEl.classList.toggle('error', isError);
    };

    function sizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.round(wrap.clientWidth * dpr);
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
      return size;
    }

    function fitText(text, maxWidth) {
      if (ctx.measureText(text).width <= maxWidth) return text;
      let t = text;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
      return t.trimEnd() + '…';
    }

    function draw() {
      const size = sizeCanvas();
      const c = size / 2, r = c - size * 0.012;
      ctx.clearRect(0, 0, size, size);
      if (!names.length) return;

      const n = names.length, seg = TAU / n;
      for (let i = 0; i < n; i++) {
        const a0 = rotation + i * seg;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.arc(c, c, r, a0, a0 + seg);
        ctx.closePath();
        let ci = i % COLORS.length;
        if (i === n - 1 && n > 1 && ci === 0) ci = 4;
        ctx.fillStyle = COLORS[ci];
        ctx.fill();
        ctx.lineWidth = Math.max(1, size * 0.003);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.stroke();
      }

      const fontPx = Math.max(10 * (size / 640), Math.min(size * 0.045, (r * seg) * 0.55));
      ctx.font = `600 ${fontPx}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fff';
      const textEnd = r - size * 0.04, textStart = size * 0.09;
      for (let i = 0; i < n; i++) {
        const mid = rotation + (i + 0.5) * seg;
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(mid);
        ctx.fillText(fitText(names[i], textEnd - textStart), textEnd, 0);
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(c, c, size * 0.05, 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = size * 0.006;
      ctx.strokeStyle = 'rgba(0,0,0,.15)';
      ctx.stroke();
    }

    function makeRemovableItem(name, index) {
      const li = document.createElement('li');
      li.className = 'removable';
      const span = document.createElement('span');
      span.className = 'name-text';
      span.textContent = name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remove-btn';
      btn.textContent = '✕';
      btn.setAttribute('aria-label', `${name} entfernen (nicht anwesend)`);
      btn.title = 'Nicht anwesend — vom Rad entfernen';
      btn.disabled = busy;
      btn.addEventListener('click', () => removeName(index));
      li.append(span, btn);
      return li;
    }

    function removeName(index) {
      if (busy) return;
      const [name] = names.splice(index, 1);
      if (name === undefined) return;
      setStatus(`${name} entfernt (nicht anwesend).`);
      refresh();
    }

    function renderLists() {
      const rem = $('remainingList'), dn = $('doneList');
      rem.replaceChildren(...(names.length
        ? names.map((nm, i) => makeRemovableItem(nm, i))
        : [Object.assign(document.createElement('li'), { textContent: 'Keine Namen übrig', className: 'empty-note' })]));
      dn.replaceChildren(...(done.length
        ? done.map((nm) => Object.assign(document.createElement('li'), { textContent: nm }))
        : [Object.assign(document.createElement('li'), { textContent: 'Noch niemand', className: 'empty-note' })]));
      $('remainingCount').textContent = names.length;
      $('doneCount').textContent = done.length;
    }

    function refresh() {
      renderLists();
      emptyEl.hidden = allNames.length > 0;
      spinBtn.disabled = busy || names.length === 0;
      resetBtn.disabled = busy || allNames.length === 0;
      if (allNames.length && !names.length) spinBtn.textContent = 'Alle Namen ausgewählt';
      else spinBtn.textContent = busy ? 'Wähle aus…' : 'Namen auswählen';
      draw();
    }

    function loadText(text) {
      const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { setStatus('Die Datei enthält keine Namen.', true); return; }
      const MAX = 500;
      allNames = lines.slice(0, MAX);
      names = allNames.slice();
      done = [];
      rotation = randFloat() * TAU;
      $('winnerCard').hidden = true;
      setStatus(lines.length > MAX
        ? `Die ersten ${MAX} von ${lines.length} Namen wurden geladen.`
        : `${names.length} Name${names.length === 1 ? '' : 'n'} geladen.`);
      refresh();
    }

    function loadFile(file) {
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setStatus('Die Datei ist zu groß (max. 2 MB).', true); return; }
      const reader = new FileReader();
      reader.onload = () => loadText(String(reader.result));
      reader.onerror = () => setStatus('Datei konnte nicht gelesen werden.', true);
      reader.readAsText(file);
    }

    fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove('dragover'); }));
    wrap.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
    resetBtn.addEventListener('click', () => {
      if (busy) return;
      names = allNames.slice(); done = [];
      $('winnerCard').hidden = true;
      setStatus('Rad zurückgesetzt.');
      refresh();
    });

    const easeOut = (t) => 1 - Math.pow(1 - t, 4);

    function spin() {
      if (busy || !names.length) return;
      busy = true;
      $('winnerCard').hidden = true;
      setStatus('');
      refresh();

      const n = names.length, seg = TAU / n;
      const winner = randInt(n);
      const within = 0.15 + randFloat() * 0.7;
      const target = -Math.PI / 2 - (winner + within) * seg;
      const start = rotation;
      const delta = ((target - start) % TAU + TAU) % TAU + TAU * (reduceMotion ? 1 : 2 + randInt(2));
      const duration = reduceMotion ? 600 : 1000;
      const t0 = performance.now();

      function frame(now) {
        const t = Math.min(1, (now - t0) / duration);
        rotation = start + delta * easeOut(t);
        draw();
        if (t < 1) requestAnimationFrame(frame);
        else finish(winner);
      }
      requestAnimationFrame(frame);
    }

    function finish(index) {
      rotation %= TAU;
      const name = names[index];
      $('winnerName').textContent = name;
      $('winnerCard').hidden = false;
      if (!reduceMotion) celebrate(wrap);

      setTimeout(() => {
        names.splice(index, 1);
        done.push(name);
        busy = false;
        refresh();
        if (!names.length) setStatus('Alle wurden ausgewählt. Mit „Zurücksetzen“ neu starten.');
      }, reduceMotion ? 600 : 2600);
    }

    spinBtn.addEventListener('click', spin);
    refresh();
  })();

  // ===================================================================
  // Liste-Variante
  // ===================================================================
  (() => {
    const genBtn = $('generate2'), resetBtn = $('reset2'), fileInput = $('file2');
    const statusEl = $('status2'), emptyEl = $('empty2'), wrap = $('uploadWrap2'), listEl = $('orderList2');

    let allNames = [];

    const setStatus = (msg, isError = false) => {
      statusEl.textContent = msg;
      statusEl.classList.toggle('error', isError);
    };

    function shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function refresh() {
      emptyEl.hidden = allNames.length > 0;
      genBtn.disabled = allNames.length === 0;
      resetBtn.disabled = allNames.length === 0;
    }

    function loadText(text) {
      const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { setStatus('Die Datei enthält keine Namen.', true); return; }
      const MAX = 500;
      allNames = lines.slice(0, MAX);
      listEl.hidden = true;
      listEl.replaceChildren();
      setStatus(lines.length > MAX
        ? `Die ersten ${MAX} von ${lines.length} Namen wurden geladen.`
        : `${allNames.length} Name${allNames.length === 1 ? '' : 'n'} geladen.`);
      refresh();
    }

    function loadFile(file) {
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setStatus('Die Datei ist zu groß (max. 2 MB).', true); return; }
      const reader = new FileReader();
      reader.onload = () => loadText(String(reader.result));
      reader.onerror = () => setStatus('Datei konnte nicht gelesen werden.', true);
      reader.readAsText(file);
    }

    fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove('dragover'); }));
    wrap.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
    resetBtn.addEventListener('click', () => {
      allNames = [];
      listEl.hidden = true;
      listEl.replaceChildren();
      setStatus('Zurückgesetzt.');
      refresh();
    });

    function makeOrderItem(name, i) {
      const li = document.createElement('li');
      li.style.animationDelay = reduceMotion ? '0s' : `${i * 45}ms`;
      const span = document.createElement('span');
      span.className = 'name-text';
      span.textContent = name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remove-btn';
      btn.textContent = '✕';
      btn.setAttribute('aria-label', `${name} entfernen (fertig)`);
      btn.title = 'Fertig — aus der Liste entfernen';
      btn.addEventListener('click', () => {
        li.remove();
        setStatus(`${name} entfernt.`);
        if (!listEl.children.length) setStatus('Alle Namen sind durch.');
      });
      li.append(span, btn);
      return li;
    }

    function generate() {
      if (!allNames.length) return;
      const order = shuffle(allNames);
      listEl.replaceChildren(...order.map((name, i) => makeOrderItem(name, i)));
      listEl.hidden = false;
      setStatus(`Reihenfolge für ${order.length} Namen erstellt.`);
      if (!reduceMotion) celebrate(wrap);
    }

    genBtn.addEventListener('click', generate);
    refresh();
  })();

  // ===================================================================
  // Tab switching
  // ===================================================================
  const tabRad = $('tabRad'), tabListe = $('tabListe');
  const panelRad = $('panelRad'), panelListe = $('panelListe');

  function showTab(tab) {
    const isRad = tab === 'rad';
    panelRad.hidden = !isRad;
    panelListe.hidden = isRad;
    tabRad.classList.toggle('active', isRad);
    tabListe.classList.toggle('active', !isRad);
    tabRad.setAttribute('aria-pressed', String(isRad));
    tabListe.setAttribute('aria-pressed', String(!isRad));
  }

  tabRad.addEventListener('click', () => showTab('rad'));
  tabListe.addEventListener('click', () => showTab('liste'));
})();
