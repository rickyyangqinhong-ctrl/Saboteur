'use strict';
/* BUILD & BETRAY — client */
const $ = s => document.querySelector(s);
const screens = ['#menu', '#lobby', '#game'];
const showScreen = id => screens.forEach(s => $(s).classList.toggle('hidden', s !== id));

/* ---------------- state ---------------- */
let ws = null, myId = null, isHost = false;
let map = null, role = 'crew', boot = '', mates = [];
let roster = {};                 // id -> {name,color}
let state = null;                // latest snapshot
const P = {};                    // render positions
let pings = [];
let notebook = [];
let mini = null, pendingTask = null;
let meetingOpen = false, meetingId = -1, lastMeeting = null;
const keys = {};
let lastInput = '0,0';

const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const myAlive = () => { const p = state && state.players.find(q => q.id === myId); return p ? !!p.a : true; };

/* ---------------- connection ---------------- */
function connect(then) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = then;
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => { menuMsg('Disconnected from the server.'); showScreen('#menu'); hideOverlays(); };
}
function menuMsg(t) { $('#menuMsg').textContent = t || ''; }
function joinRoom(create) {
  const name = $('#inName').value.trim() || 'Builder';
  const room = $('#inRoom').value.trim();
  if (!create && !room) return menuMsg('Enter a room code first.');
  localStorage.setItem('bb_name', name);
  menuMsg('');
  const go = () => send({ t: 'join', name, room, create });
  if (ws && ws.readyState === 1) go(); else connect(go);
}
$('#inName').value = localStorage.getItem('bb_name') || '';
$('#btnCreate').onclick = () => joinRoom(true);
$('#btnJoin').onclick = () => joinRoom(false);
$('#inRoom').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(false); });
$('#btnStart').onclick = () => send({ t: 'start' });
$('#btnBack').onclick = () => send({ t: 'toLobby' });

/* ---------------- messages ---------------- */
function onMsg(m) {
  switch (m.t) {
    case 'error': menuMsg(m.text); break;
    case 'joined': myId = m.id; break;
    case 'host': isHost = true; $('#btnBack').classList.remove('hidden'); $('#overWait').classList.add('hidden'); break;
    case 'lobby': renderLobby(m); break;
    case 'start': startGame(m); break;
    case 'state': state = m; onState(); break;
    case 'toast': toast(m.text); break;
    case 'alert': showAlert(m.text); break;
    case 'ping': pings.push({ x: m.x, y: m.y, t: 0 }); break;
    case 'clue': notebook.push(m); toast('📓 New clue added to your notebook (N)'); renderNotebook(); break;
    case 'taskOk': if (pendingTask === m.station) openMini(m.station); break;
    case 'meeting': onMeeting(m); break;
    case 'chat': addChat(m); break;
    case 'meetingEnd': meetingOpen = false; $('#meeting').classList.add('hidden'); break;
    case 'over': onOver(m); break;
  }
}

function renderLobby(m) {
  showScreen('#lobby'); hideOverlays();
  state = null; for (const k in P) delete P[k];
  $('#lobbyCode').textContent = m.room;
  const me = m.players.find(p => p.id === myId);
  isHost = !!(me && me.host);
  const ul = $('#lobbyList'); ul.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
    const n = document.createElement('span'); n.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.append(d, n);
    if (p.host) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'host'; li.append(b); }
    ul.append(li);
  }
  $('#btnStart').classList.toggle('hidden', !isHost);
  $('#btnStart').disabled = m.players.length < m.min;
  $('#lobbyHint').textContent = m.players.length < m.min
    ? `Waiting for players… (need at least ${m.min})`
    : (isHost ? 'Ready when you are.' : 'Waiting for the host to start.');
}

function startGame(m) {
  map = m.map; role = m.role; boot = m.boot; mates = m.mates; myId = m.meId;
  roster = {}; m.players.forEach(p => roster[p.id] = p);
  notebook = []; pings = []; state = null; for (const k in P) delete P[k];
  pendingTask = null; mini = null; meetingOpen = false; lastInput = '0,0';
  hideOverlays();
  showScreen('#game');
  buildHud(); buildBase();
  const sab = role === 'saboteur';
  $('#revTitle').textContent = sab ? 'You are a SABOTEUR' : 'You are a BUILDER';
  $('#revTitle').style.color = sab ? '#ff8b7d' : '#8fd6a0';
  $('#revSub').textContent = sab
    ? `Wreck the settlement without being caught.${mates.length ? ' Your partner: ' + mates.join(', ') + '.' : ''} Your boots: ${boot}.`
    : `Gather, build, and find the saboteur. Your boots: ${boot}.`;
  $('#reveal').classList.remove('hidden');
}
$('#reveal').onclick = () => $('#reveal').classList.add('hidden');

function hideOverlays() {
  ['#reveal', '#mini', '#notebook', '#meeting', '#over'].forEach(s => $(s).classList.add('hidden'));
  mini = null; meetingOpen = false;
}

/* ---------------- HUD ---------------- */
function buildHud() {
  $('#roleChip').className = role === 'saboteur' ? 'sab' : '';
  $('#roleChip').innerHTML = role === 'saboteur'
    ? `Saboteur <small>· ${mates.length ? 'partner: ' + mates.join(', ') : 'working alone'}</small>`
    : `Builder <small>· boots: ${boot}</small>`;
  const box = $('#sabBtns'); box.innerHTML = '';
  if (role !== 'saboteur') return;
  const defs = [
    ['damage', 'Q', 'Sabotage building'], ['steal', 'X', 'Steal'],
    ['fire', '1', 'Fire'], ['surge', '2', 'Power surge'], ['lights', '3', 'Lights out'],
  ];
  for (const [k, key, label] of defs) {
    const b = document.createElement('button');
    b.dataset.k = k; b.dataset.label = `[${key}] ${label}`; b.textContent = b.dataset.label;
    b.onclick = () => send({ t: 'sabotage', kind: k });
    box.append(b);
  }
}

function onState() {
  // sync render positions
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    const r = P[p.id] || (P[p.id] = { x: p.x, y: p.y, fx: 1 });
    if (Math.abs(p.x - r.tx) > 0.5) r.fx = p.x > r.tx ? 1 : -1;
    r.tx = p.x; r.ty = p.y; r.a = p.a; r.w = p.w; r.seen = true;
  }
  for (const id in P) if (!seen.has(+id)) P[id].seen = false;

  $('#integFill').style.width = state.integrity + '%';
  $('#integFill').style.background = state.integrity > 60 ? 'var(--pine)' : state.integrity > 30 ? 'var(--brass)' : 'var(--ember)';
  $('#integVal').textContent = state.integrity;
  $('#stock').textContent = `🪵 ${state.stock.wood}   🪨 ${state.stock.stone}   🌾 ${state.stock.food}`;
  $('#builds').innerHTML = map.plots.map(pl => {
    const s = state.steps[pl.id];
    return `<span class="chip ${s >= 3 ? 'done' : ''} ${state.damaged[pl.id] ? 'dmg' : ''}" title="${pl.name}">${pl.icon} ${s}/3</span>`;
  }).join('');

  const cb = $('#crisisbar');
  if (state.crisis) {
    cb.classList.remove('hidden');
    cb.innerHTML = `<b>${state.crisis.label}</b> · ${Math.ceil(state.crisis.left)}s left<div class="cbar"><i style="width:${Math.min(100, state.crisis.progress / 4 * 100)}%"></i></div>`;
  } else if (state.lights) {
    cb.classList.remove('hidden'); cb.innerHTML = '<b>💡 Lights out</b> · fix it at the Generator';
  } else cb.classList.add('hidden');

  if (role === 'saboteur' && state.cd) {
    const map2 = { damage: state.cd.damage, steal: state.cd.steal, fire: state.cd.mal, surge: state.cd.mal, lights: state.cd.mal };
    document.querySelectorAll('#sabBtns button').forEach(b => {
      const cd = map2[b.dataset.k];
      b.textContent = cd > 0.5 ? `${b.dataset.label} (${Math.ceil(cd)}s)` : b.dataset.label;
      b.disabled = cd > 0.5;
    });
  }
}

function toast(text) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = text;
  $('#toasts').append(d);
  setTimeout(() => d.remove(), 4600);
  while ($('#toasts').children.length > 5) $('#toasts').firstChild.remove();
}
let alertTimer = null;
function showAlert(text) {
  const a = $('#alertbar'); a.textContent = text; a.classList.remove('hidden');
  clearTimeout(alertTimer); alertTimer = setTimeout(() => a.classList.add('hidden'), 6000);
}

/* ---------------- notebook ---------------- */
function noteEl(n, withShare) {
  const d = document.createElement('div'); d.className = 'note';
  const b = document.createElement('b'); b.textContent = n.title;
  d.append(b, document.createTextNode('\n' + n.text));
  if (withShare) {
    const btn = document.createElement('button'); btn.textContent = 'Share in chat';
    btn.onclick = () => send({ t: 'share', id: n.id });
    d.append(document.createElement('br'), btn);
  }
  return d;
}
function renderNotebook() {
  const l = $('#nbList'); l.innerHTML = '';
  if (!notebook.length) l.textContent = 'No clues yet. Inspect sites with F.';
  notebook.slice().reverse().forEach(n => l.append(noteEl(n, false)));
  const ml = $('#mtNoteList'); ml.innerHTML = '';
  if (!notebook.length) ml.textContent = 'You have no clues.';
  notebook.slice().reverse().forEach(n => ml.append(noteEl(n, true)));
}
function toggleNotebook() {
  if (meetingOpen || mini) return;
  renderNotebook();
  $('#notebook').classList.toggle('hidden');
}

/* ---------------- input ---------------- */
function sendInput() {
  let dx = 0, dy = 0;
  if (!mini && !meetingOpen && !overlayBlocking()) {
    if (keys.a || keys.arrowleft) dx--;
    if (keys.d || keys.arrowright) dx++;
    if (keys.w || keys.arrowup) dy--;
    if (keys.s || keys.arrowdown) dy++;
  }
  const s = dx + ',' + dy;
  if (s !== lastInput) { lastInput = s; send({ t: 'input', dx, dy }); }
}
const overlayBlocking = () => !$('#reveal').classList.contains('hidden') || !$('#over').classList.contains('hidden');

function nd(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
const RES_LABEL = { forest: 'Chop wood', quarry: 'Mine stone', farm: 'Harvest food' };

function findInteract() {
  const me = P[myId];
  if (!state || !map || !me || !myAlive()) return null;
  const out = { lines: [], e: null };
  const cr = state.crisis;
  let hold = null;
  if (cr) for (const pt of cr.points) if (nd(me, pt) < 75) {
    hold = cr.type === 'fire' ? 'Hold E to put out the fire' : 'Hold E on the pylon (a partner must hold the other one!)';
  }
  if (state.lights && nd(me, map.stations.generator) < 75) hold = 'Hold E to restore the lights';
  if (hold) { out.e = { type: 'hold' }; out.lines.push('[E] ' + hold); }

  for (const k of ['forest', 'quarry', 'farm']) {
    if (!out.e && nd(me, map.stations[k]) <= 80) { out.e = { type: 'task', station: k }; out.lines.push('[E] ' + RES_LABEL[k]); }
  }
  let site = false;
  for (const pl of map.plots) if (nd(me, pl) <= 80) {
    site = true;
    const s = state.steps[pl.id];
    if (s < 3 && !out.e) {
      const cost = Object.entries(pl.step).map(([a, b]) => b + ' ' + a).join(', ');
      out.e = { type: 'task', station: 'plot:' + pl.id };
      out.lines.push(`[E] Build ${pl.name} — step ${s + 1}/3 (${cost})`);
    }
  }
  if (nd(me, map.stations.store) <= 100) { site = true; out.lines.push('[F] Read the ledger'); }
  if (nd(me, map.stations.bell) <= 90 && state.bell && !out.e) { out.e = { type: 'bell' }; out.lines.push('[E] Ring the bell — call an emergency meeting'); }
  if (site) out.lines.push('[F] Inspect   [R] Report sabotage');
  return out;
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ($('#game').classList.contains('hidden')) return;
  if (mini) { miniKey(e, k); return; }
  if (meetingOpen) return;
  if (k === 'n') { toggleNotebook(); return; }
  if (!$('#notebook').classList.contains('hidden') && k === 'escape') { toggleNotebook(); return; }
  if (overlayBlocking()) return;
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys[k] = true; e.preventDefault(); sendInput(); return; }
  if (e.repeat) return;
  if (k === 'e') {
    send({ t: 'hold', on: true });
    const it = findInteract();
    if (it && it.e) {
      if (it.e.type === 'task') { pendingTask = it.e.station; send({ t: 'taskStart', station: it.e.station }); }
      else if (it.e.type === 'bell') send({ t: 'bell' });
    }
  }
  else if (k === 'f') send({ t: 'inspect' });
  else if (k === 'r') send({ t: 'report' });
  else if (role === 'saboteur') {
    const m = { q: 'damage', x: 'steal', '1': 'fire', '2': 'surge', '3': 'lights' }[k];
    if (m) send({ t: 'sabotage', kind: m });
  }
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === 'e') send({ t: 'hold', on: false });
  sendInput();
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; send({ t: 'hold', on: false }); sendInput(); });

/* ---------------- mini-games (text + emoji) ---------------- */
const MINI_TITLE = { chop: '🌲 Chop the tree', mine: '🪨 Mine the stone', harvest: '🌾 Harvest the crops', hammer: '🔨 Hammer it together' };
const MINI_HELP = {
  chop: 'Press Space (or the button) when 🟧 is on the 🟩 zone. Land 3 hits.',
  mine: 'Stop 🟧 inside the 🟩 zone. 3 rounds, and the zone shrinks each time.',
  harvest: 'Click the numbers in order, 1️⃣ to 5️⃣. A wrong pick starts you over.',
  hammer: 'Repeat the arrows with the arrow keys / WASD, or click the buttons.',
};
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'], ARROWS = ['⬅️', '⬆️', '➡️', '⬇️'];
const rnd = (a, b) => a + Math.random() * (b - a);
function addMiniBtn(text, fn) { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; $('#miniBtns').append(b); }

function openMini(station) {
  pendingTask = null;
  const kind = station === 'forest' ? 'chop' : station === 'quarry' ? 'mine' : station === 'farm' ? 'harvest' : 'hammer';
  mini = { kind, station, flash: 0, ok: true, last: '' };
  $('#miniBtns').innerHTML = ''; $('#miniGrid').innerHTML = ''; $('#miniGrid').classList.add('hidden');
  if (kind === 'chop') { Object.assign(mini, { pos: 0, dir: 1, speed: 0.7, hits: 0 }); addMiniBtn('🪓 Chop (Space)', miniAction); }
  if (kind === 'mine') { Object.assign(mini, { pos: 0, dir: 1, round: 0 }); newZone(); addMiniBtn('⛏️ Strike (Space)', miniAction); }
  if (kind === 'harvest') {
    const all = Array.from({ length: 32 }, (_, i) => i).sort(() => Math.random() - 0.5);
    mini.nodes = all.slice(0, 5); mini.next = 1; mini.cells = [];
    const g = $('#miniGrid'); g.classList.remove('hidden');
    for (let c = 0; c < 32; c++) {
      const n = mini.nodes.indexOf(c);
      if (n >= 0) {
        const b = document.createElement('button'); b.className = 'cell'; b.textContent = NUM[n]; b.onclick = () => harvestClick(n);
        mini.cells[n] = b; g.append(b);
      } else { const sp = document.createElement('span'); sp.className = 'cell'; sp.textContent = '🟫'; g.append(sp); }
    }
  }
  if (kind === 'hammer') {
    mini.seq = Array.from({ length: 6 }, () => Math.floor(Math.random() * 4)); mini.i = 0;
    ARROWS.forEach((a, d) => addMiniBtn(a, () => hammerPress(d)));
  }
  $('#miniTitle').textContent = MINI_TITLE[kind];
  $('#miniHelp').textContent = MINI_HELP[kind];
  $('#mini').classList.remove('hidden');
  lastInput = ''; sendInput();
}
function newZone() { mini.zw = 5 - mini.round; mini.zs = 1 + Math.floor(Math.random() * (23 - mini.zw)); }
function closeMini(cancel) {
  if (!mini) return;
  if (cancel) send({ t: 'taskCancel' });
  mini = null; $('#mini').classList.add('hidden');
}
function miniWin() { const s = mini.station; closeMini(false); send({ t: 'taskDone', station: s }); }
function miniFlash(ok) { mini.flash = 0.25; mini.ok = ok; }
const miniIdx = () => Math.round(mini.pos * 24);

function miniAction() {
  if (!mini) return;
  const i = miniIdx();
  if (mini.kind === 'chop') {
    if (i >= 11 && i <= 13) { mini.hits++; mini.speed += 0.12; miniFlash(true); if (mini.hits >= 3) miniWin(); }
    else miniFlash(false);
  } else if (mini.kind === 'mine') {
    if (i >= mini.zs && i < mini.zs + mini.zw) { mini.round++; miniFlash(true); if (mini.round >= 3) miniWin(); else newZone(); }
    else miniFlash(false);
  }
}
function harvestClick(n) {
  if (!mini) return;
  if (n === mini.next - 1) {
    mini.cells[n].textContent = '✅'; mini.next++; miniFlash(true);
    if (mini.next > 5) miniWin();
  } else {
    mini.next = 1; mini.cells.forEach((b, i) => b.textContent = NUM[i]); miniFlash(false);
  }
}
function hammerPress(d) {
  if (!mini) return;
  if (d === mini.seq[mini.i]) { mini.i++; miniFlash(true); if (mini.i >= mini.seq.length) miniWin(); }
  else { mini.i = 0; miniFlash(false); }
}
function miniKey(e, k) {
  if (k === 'escape') { closeMini(true); return; }
  if (mini.kind === 'chop' || mini.kind === 'mine') {
    if (k === ' ' || k === 'enter') { e.preventDefault(); if (!e.repeat) miniAction(); }
  } else if (mini.kind === 'hammer') {
    const d = { arrowleft: 0, a: 0, arrowup: 1, w: 1, arrowright: 2, d: 2, arrowdown: 3, s: 3 }[k];
    if (d === undefined) return;
    e.preventDefault(); hammerPress(d);
  }
}

function updateMini(dt) {
  if (!mini) return;
  mini.flash = Math.max(0, mini.flash - dt);
  if (mini.kind === 'chop' || mini.kind === 'mine') {
    const sp = mini.kind === 'chop' ? mini.speed : 0.7 + mini.round * 0.25;
    mini.pos += mini.dir * sp * dt;
    if (mini.pos > 1) { mini.pos = 1; mini.dir = -1; }
    if (mini.pos < 0) { mini.pos = 0; mini.dir = 1; }
  }
  let s = '';
  const track = (i, a, b) => Array.from({ length: 25 }, (_, k) => k === i ? '🟧' : (k >= a && k <= b ? '🟩' : '⬜')).join('');
  if (mini.kind === 'chop') s = track(miniIdx(), 11, 13) + '\n🪓 ' + '✅'.repeat(mini.hits) + '⬜'.repeat(3 - mini.hits);
  else if (mini.kind === 'mine') s = track(miniIdx(), mini.zs, mini.zs + mini.zw - 1) + '\n⛏️ ' + '✅'.repeat(mini.round) + '⬜'.repeat(3 - mini.round);
  else if (mini.kind === 'harvest') s = 'Next: ' + (mini.next <= 5 ? NUM[mini.next - 1] : '✅');
  else if (mini.kind === 'hammer') s = mini.seq.map((d, i) => i < mini.i ? '✅' : i === mini.i ? '👉' + ARROWS[d] : ARROWS[d]).join(' ');
  const el = $('#miniLine');
  if (s !== mini.last) { mini.last = s; el.textContent = s; }
  const cls = mini.flash > 0 ? (mini.ok ? 'good' : 'bad') : '';
  if (el.className !== cls) el.className = cls;
}

/* ---------------- meeting ---------------- */
function onMeeting(m) {
  lastMeeting = m;
  if (m.id !== meetingId) {           // new meeting
    meetingId = m.id; $('#chatLog').innerHTML = '';
    closeMini(false); $('#notebook').classList.add('hidden');
    for (const k in keys) keys[k] = false; lastInput = ''; sendInput();
    addChat({ kind: 'sys', text: m.reason });
  }
  meetingOpen = true;
  $('#meeting').classList.remove('hidden');
  renderNotebook();
  $('#mtReason').textContent = m.reason;
  const label = { discuss: 'Discussion', vote: 'Voting', result: 'Results' }[m.stage];
  $('#mtStage').textContent = `${label} · ${m.left}s`;
  const me = m.players.find(p => p.id === myId);
  const alive = me && me.alive;

  const rb = $('#btnReady');
  rb.classList.toggle('hidden', !(m.stage === 'discuss' && alive));
  rb.textContent = me && me.ready ? 'Waiting… (click to undo)' : 'Ready to vote';
  rb.onclick = () => send({ t: 'ready' });
  $('#chatInput').disabled = !alive; $('#btnChat').disabled = !alive;

  const box = $('#mtPlayers'); box.innerHTML = '';
  for (const p of m.players) {
    const d = document.createElement('div'); d.className = 'mp' + (p.alive ? '' : ' dead');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
    const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    d.append(dot, nm);
    if (m.stage === 'vote' && alive && p.alive) {
      const b = document.createElement('button'); b.textContent = m.myVote === p.id ? 'Voted' : 'Vote';
      if (m.myVote === p.id) b.className = 'sel';
      b.onclick = () => send({ t: 'vote', target: p.id });
      d.append(b);
    } else if (m.stage !== 'result') {
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = !p.alive ? 'out' : m.stage === 'vote' ? (p.voted ? 'voted' : 'thinking…') : (p.ready ? 'ready' : '');
      d.append(st);
    }
    box.append(d);
  }
  if (m.stage === 'vote' && alive) {
    const s = document.createElement('div'); s.className = 'mp';
    s.append(document.createTextNode('Skip vote'));
    const b = document.createElement('button'); b.textContent = m.myVote === 'skip' ? 'Skipping' : 'Skip';
    if (m.myVote === 'skip') b.className = 'sel';
    b.onclick = () => send({ t: 'vote', target: 'skip' });
    s.append(b); box.append(s);
  }

  const rs = $('#mtResult');
  if (m.stage === 'result' && m.result) {
    rs.classList.remove('hidden'); rs.innerHTML = '';
    const h = document.createElement('h3');
    const e = m.result.ejected;
    h.textContent = e ? `${e.name} was ${e.role === 'saboteur' ? 'a SABOTEUR' : 'a Builder (not a saboteur)'}.` : 'Nobody was voted out.';
    if (e && e.role === 'saboteur') h.className = 'role-sab';
    rs.append(h);
    m.result.votes.forEach(v => { const l = document.createElement('div'); l.textContent = `${v.voter} → ${v.target}`; rs.append(l); });
  } else rs.classList.add('hidden');
}
function addChat(m) {
  const log = $('#chatLog'); const d = document.createElement('div');
  if (m.kind === 'sys') { d.className = 'sys'; d.textContent = m.text; }
  else if (m.kind === 'clue') {
    d.className = 'clue';
    const b = document.createElement('b'); b.textContent = m.name + ' '; b.style.color = m.color;
    d.append(b, document.createTextNode(m.text));
  } else {
    const b = document.createElement('b'); b.textContent = m.name + ': '; b.style.color = m.color;
    d.append(b, document.createTextNode(m.text));
  }
  log.append(d); log.scrollTop = log.scrollHeight;
}
function sendChat() {
  const i = $('#chatInput'); const t = i.value.trim();
  if (t) send({ t: 'chat', text: t });
  i.value = '';
}
$('#btnChat').onclick = sendChat;
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function onOver(m) {
  closeMini(false); meetingOpen = false;
  $('#meeting').classList.add('hidden'); $('#notebook').classList.add('hidden'); $('#reveal').classList.add('hidden');
  const crewWin = m.winner === 'crew';
  const iWin = (role === 'crew') === crewWin;
  $('#overTitle').textContent = crewWin ? 'Builders win!' : 'Saboteurs win!';
  $('#overTitle').style.color = crewWin ? '#8fd6a0' : '#ff8b7d';
  $('#overReason').textContent = m.reason + (iWin ? ' You won.' : ' You lost.');
  const ul = $('#overList'); ul.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
    const n = document.createElement('span'); n.textContent = p.name;
    const r = document.createElement('span'); r.className = 'badge' + (p.role === 'saboteur' ? ' role-sab' : '');
    r.textContent = p.role === 'saboteur' ? 'Saboteur' : 'Builder';
    li.append(d, n, r); ul.append(li);
  }
  $('#btnBack').classList.toggle('hidden', !isHost);
  $('#overWait').classList.toggle('hidden', isHost);
  $('#over').classList.remove('hidden');
  send({ t: 'input', dx: 0, dy: 0 }); send({ t: 'hold', on: false });
}

/* ---------------- rendering (emoji text grid) ---------------- */
const CELL = 40, GW = 25, GH = 16;
const CIRCLE = { '#e74c3c': '🔴', '#3498db': '🔵', '#2ecc71': '🟢', '#f1c40f': '🟡', '#9b59b6': '🟣', '#e67e22': '🟠', '#1abc9c': '🟤', '#fd79a8': '🌸', '#95a5a6': '🔘', '#ecf0f1': '⚪' };
const circle = c => CIRCLE[c] || '🔵';
const cellOf = (x, y) => [Math.min(GW - 1, Math.max(0, Math.floor(x / CELL))), Math.min(GH - 1, Math.max(0, Math.floor(y / CELL)))];
let base = [];

function buildBase() {
  base = Array(GW * GH).fill('🟩');
  for (const o of map.obstacles) {
    const [x0, y0] = cellOf(o.x, o.y), [x1, y1] = cellOf(o.x + o.w - 1, o.y + o.h - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) base[y * GW + x] = '🪨';
  }
  for (const k in map.stations) { const s = map.stations[k]; const [x, y] = cellOf(s.x, s.y); base[y * GW + x] = s.icon; }
  for (const p of map.pylons) { const [x, y] = cellOf(p.x, p.y); base[y * GW + x] = '📡'; }
  $('#legendKey').textContent = Object.values(map.stations).map(s => `${s.icon} ${s.label}`).join('   ')
    + "   📡 Pylon   🚧 Build site   🏗️ In progress   💥 Sabotaged   🪨 Rock   ⬛ Can't see";
}

function renderGrid() {
  if (!map || !state) return;
  const me = P[myId], alive = myAlive();
  const cells = base.slice();

  // build sites
  for (const pl of map.plots) {
    const [x, y] = cellOf(pl.x, pl.y);
    const st = state.steps[pl.id];
    cells[y * GW + x] = state.damaged[pl.id] ? '💥' : st >= 3 ? pl.icon : st > 0 ? '🏗️' : '🚧';
  }

  // fog of war
  if (alive && me) {
    const rad = state.lights && role === 'crew' ? 120 : 290;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      if (Math.hypot((x + 0.5) * CELL - me.tx, (y + 0.5) * CELL - me.ty) > rad) cells[y * GW + x] = '⬛';
    }
  }

  // players (server only sends the ones we can see)
  let selfIdx = -1;
  const others = [];
  for (const id in P) {
    const r = P[id]; if (!r.seen || +id === myId) continue;
    const [x, y] = cellOf(r.tx, r.ty);
    const info = roster[id] || { name: '?', color: '#888' };
    cells[y * GW + x] = r.a ? circle(info.color) : '👻';
    others.push(`${circle(info.color)} ${info.name}${mates.includes(info.name) ? ' 😈' : ''}${r.w ? ' 🔨' : ''}${r.a ? '' : ' 👻'}`);
  }
  if (me) {
    const [x, y] = cellOf(me.tx, me.ty);
    selfIdx = y * GW + x;
    cells[selfIdx] = alive ? circle((roster[myId] || {}).color) : '👻';
  }

  // always-visible alerts
  if (state.crisis) for (const pt of state.crisis.points) { const [x, y] = cellOf(pt.x, pt.y); cells[y * GW + x] = state.crisis.type === 'fire' ? '🔥' : '⚡'; }
  if (state.lights) { const g = map.stations.generator; const [x, y] = cellOf(g.x, g.y); cells[y * GW + x] = '💡'; }
  for (const p of pings) { const [x, y] = cellOf(p.x, p.y); cells[y * GW + x] = '❗'; }

  $('#grid').innerHTML = cells.map((c, i) => `<i${i === selfIdx ? ' class="me"' : ''}>${c}</i>`).join('');

  const ri = roster[myId] || { name: '?', color: '#888' };
  $('#legendNow').textContent = `You: ${circle(ri.color)} ${ri.name}${alive ? '' : ' (out — spectating)'}` + (others.length ? `   ·   Nearby: ${others.join('   ')}` : '   ·   Nobody in sight');

  // prompt
  const it = findInteract();
  const pr = $('#prompt'); pr.innerHTML = '';
  if (it && !mini && !meetingOpen) for (const l of it.lines) { const d = document.createElement('div'); d.textContent = l; pr.append(d); }
  if (state && !alive) { const d = document.createElement('div'); d.textContent = 'You are out. You can still watch. Keep quiet!'; pr.append(d); }
}

let last = performance.now(), lastGrid = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!$('#game').classList.contains('hidden')) {
    updateMini(dt);
    pings = pings.filter(p => (p.t += dt) < 3.5);
    if (now - lastGrid > 60) { lastGrid = now; renderGrid(); }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
