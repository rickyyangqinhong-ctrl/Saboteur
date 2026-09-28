'use strict';
/**
 * BUILD & BETRAY — server
 * Run:  npm i ws   then   node server.js      (open http://localhost:3000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
const R = 14, SPEED = 170, VISION = 290, DARK_VISION = 120, INTERACT = 80;
const MIN_PLAYERS = 3, MAX_PLAYERS = 10;
const STEPS_PER_BUILDING = 3, STOCK_CAP = 30;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#fd79a8', '#95a5a6', '#ecf0f1'];
const BOOTS = ['Small', 'Medium', 'Large'];
const RES = { forest: 'wood', quarry: 'stone', farm: 'food' };

const MAP = {
  W: 1000, H: 640,
  stations: {
    forest:    { x: 130, y: 120, label: 'Forest',     icon: '🌲' },
    quarry:    { x: 130, y: 520, label: 'Quarry',     icon: '⛏️' },
    farm:      { x: 870, y: 120, label: 'Farm',       icon: '🌾' },
    generator: { x: 870, y: 520, label: 'Generator',  icon: '⚡' },
    store:     { x: 500, y: 320, label: 'Storehouse', icon: '📦' },
    bell:      { x: 500, y: 480, label: 'Town Bell',  icon: '🔔' },
  },
  plots: [
    { id: 0, x: 300, y: 190, name: 'House',      icon: '🏠', step: { wood: 2 } },
    { id: 1, x: 700, y: 190, name: 'Well',       icon: '⛲', step: { stone: 2 } },
    { id: 2, x: 300, y: 450, name: 'Barn',       icon: '🛖', step: { wood: 1, food: 1 } },
    { id: 3, x: 700, y: 450, name: 'Watchtower', icon: '🗼', step: { stone: 1, wood: 1 } },
    { id: 4, x: 500, y: 110, name: 'Town Hall',  icon: '🏛️', step: { wood: 1, stone: 1, food: 1 } },
  ],
  pylons: [{ x: 200, y: 320 }, { x: 800, y: 320 }],
  obstacles: [
    { x: 400, y: 240, w: 50, h: 36 }, { x: 590, y: 240, w: 50, h: 36 },
    { x: 360, y: 390, w: 44, h: 44 }, { x: 600, y: 390, w: 44, h: 44 },
    { x: 80, y: 300, w: 60, h: 50 },  { x: 860, y: 300, w: 60, h: 50 },
  ],
};
// Places where clues can be left / found
const SITES = [
  ...MAP.plots.map(p => ({ key: 'plot:' + p.id, x: p.x, y: p.y, label: p.name })),
  { key: 'store', x: MAP.stations.store.x, y: MAP.stations.store.y, label: 'Storehouse' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b, r = INTERACT) => dist(a, b) <= r;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function genCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function bcast(room, obj) { const s = JSON.stringify(obj); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
const toast = (p, text) => send(p, { t: 'toast', text });
const list = room => [...room.players.values()];

function collide(p) {
  for (const o of MAP.obstacles) {
    const cx = clamp(p.x, o.x, o.x + o.w), cy = clamp(p.y, o.y, o.y + o.h);
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
    if (d < R) {
      if (d === 0) { p.y = o.y - R; continue; }
      p.x = cx + dx / d * R; p.y = cy + dy / d * R;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */
const rooms = new Map();

function newRoom(code) {
  return {
    code, players: new Map(), phase: 'lobby', time: 0, tickN: 0,
    stock: {}, steps: [], damaged: [], integrity: 100, crisis: null, lights: 0, lightsFix: 0,
    ledger: [], clues: {}, clueId: 0, meeting: null, meetingId: 0,
  };
}

function sendLobby(room) {
  const msg = {
    t: 'lobby', room: room.code, min: MIN_PLAYERS,
    players: list(room).map(p => ({ id: p.id, name: p.name, color: p.color, host: p.host })),
  };
  bcast(room, msg);
}

let nextId = 1;
function join(ws, m) {
  if (ws.player) return;
  const err = text => ws.send(JSON.stringify({ t: 'error', text }));
  let base = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || 'Builder';
  let room;
  if (m.create) {
    let code; do { code = genCode(); } while (rooms.has(code));
    room = newRoom(code); rooms.set(code, room);
  } else {
    const code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    room = rooms.get(code);
    if (!room) return err('Room not found. Check the code.');
  }
  if (room.phase !== 'lobby') return err('That game has already started.');
  if (room.players.size >= MAX_PLAYERS) return err('Room is full (max ' + MAX_PLAYERS + ').');

  let name = base, n = 2;
  const taken = () => list(room).some(q => q.name.toLowerCase() === name.toLowerCase());
  while (taken()) name = base.slice(0, 10) + n++;

  const used = new Set(list(room).map(q => q.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[0];
  const p = {
    id: nextId++, ws, room, name, color, host: room.players.size === 0, connected: true,
    x: 0, y: 0, dx: 0, dy: 0, role: 'crew', alive: true, boot: 'Medium', bellUsed: false,
    task: null, hold: false, cd: { damage: 0, steal: 0, mal: 0 }, notebook: [], gatherCd: {},
  };
  ws.player = p;
  room.players.set(p.id, p);
  send(p, { t: 'joined', id: p.id, room: room.code });
  sendLobby(room);
}

function leave(ws) {
  const p = ws.player; if (!p) return;
  const room = p.room;
  p.connected = false; p.dx = p.dy = 0; p.hold = false;
  if (room.phase === 'lobby') room.players.delete(p.id);
  else {
    p.alive = false;
    if (room.meeting) { delete room.meeting.votes[p.id]; room.meeting.ready.delete(p.id); }
    bcast(room, { t: 'toast', text: p.name + ' left the settlement.' });
  }
  const conn = list(room).filter(q => q.connected);
  if (!conn.length) { rooms.delete(room.code); return; }
  if (p.host) { p.host = false; conn[0].host = true; send(conn[0], { t: 'host' }); }
  if (room.phase === 'lobby') sendLobby(room);
  else if (room.phase === 'play') checkWin(room);
}

/* ------------------------------------------------------------------ */
/* Game start / end                                                    */
/* ------------------------------------------------------------------ */
function startGame(room) {
  const ps = list(room);
  room.phase = 'play'; room.time = 0;
  room.stock = { wood: 4, stone: 3, food: 2 };
  room.steps = MAP.plots.map(() => 0);
  room.damaged = MAP.plots.map(() => false);
  room.integrity = 100; room.crisis = null; room.lights = 0; room.lightsFix = 0;
  room.ledger = []; room.clues = {}; room.clueId = 0; room.meeting = null;

  shuffle(ps);
  const nSab = ps.length >= 7 ? 2 : 1;
  ps.forEach((p, i) => {
    p.role = i < nSab ? 'saboteur' : 'crew';
    p.alive = true; p.boot = pick(BOOTS); p.bellUsed = false;
    p.task = null; p.hold = false; p.dx = p.dy = 0; p.notebook = []; p.gatherCd = {};
    p.cd = { damage: 15, steal: 15, mal: 20 };
    const a = i / ps.length * Math.PI * 2;
    p.x = 500 + Math.cos(a) * 70; p.y = 400 + Math.sin(a) * 36;
  });
  const roster = list(room).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const sabNames = list(room).filter(p => p.role === 'saboteur').map(p => p.name);
  for (const p of list(room)) {
    send(p, {
      t: 'start', meId: p.id, role: p.role, boot: p.boot, map: MAP, players: roster,
      mates: p.role === 'saboteur' ? sabNames.filter(n => n !== p.name) : [],
    });
  }
}

function endGame(room, winner, reason) {
  if (room.phase === 'over') return true;
  room.phase = 'over'; room.meeting = null;
  bcast(room, {
    t: 'over', winner, reason,
    players: list(room).map(p => ({ name: p.name, color: p.color, role: p.role, alive: p.alive })),
  });
  return true;
}

function checkWin(room) {
  if (room.phase === 'over') return true;
  const alive = list(room).filter(p => p.alive);
  const sab = alive.filter(p => p.role === 'saboteur').length;
  const crew = alive.length - sab;
  if (room.steps.every(s => s >= STEPS_PER_BUILDING)) return endGame(room, 'crew', 'The settlement is complete!');
  if (sab === 0) return endGame(room, 'crew', 'Every saboteur has been voted out!');
  if (room.integrity <= 0) return endGame(room, 'saboteurs', 'The settlement fell apart.');
  if (sab >= crew) return endGame(room, 'saboteurs', 'The saboteurs took over the settlement.');
  return false;
}

function toLobby(room) {
  room.phase = 'lobby'; room.meeting = null;
  for (const p of [...room.players.values()]) {
    if (!p.connected) room.players.delete(p.id);
    else { p.role = 'crew'; p.alive = true; p.dx = p.dy = 0; p.hold = false; p.task = null; }
  }
  sendLobby(room);
}

/* ------------------------------------------------------------------ */
/* Clues / ledger                                                      */
/* ------------------------------------------------------------------ */
function recordClue(room, key, label, actor, what) {
  const names = shuffle(list(room).filter(q => q.alive && dist(q, actor) <= 320).map(q => q.name));
  room.clues[key] = { key, label, what, t: room.time, boot: actor.boot, names, reported: false };
}
function clueText(room, c) {
  const ago = Math.round(room.time - c.t);
  let s = `${c.what} at the ${c.label}, ${ago}s ago. Boot prints: ${c.boot}. `;
  s += c.names.length >= 2
    ? 'People seen nearby: ' + c.names.join(', ') + '.'
    : 'The ground is too scuffed to tell who else was around.';
  return s;
}
function giveClue(room, p, title, text) {
  const id = 'c' + (++room.clueId);
  p.notebook.push({ id, title, text });
  if (p.notebook.length > 30) p.notebook.shift();
  send(p, { t: 'clue', id, title, text });
}
function addLedger(room, who, text) {
  room.ledger.push({ t: room.time, who, text });
  if (room.ledger.length > 14) room.ledger.shift();
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */
function validateTask(room, p, station) {
  if (RES[station]) {
    if (!near(p, MAP.stations[station])) return 'Too far away.';
    if ((p.gatherCd[station] || 0) > room.time) return 'That spot needs a moment to recover.';
    if (room.stock[RES[station]] >= STOCK_CAP) return 'The storehouse is full of ' + RES[station] + '.';
    return null;
  }
  if (station.startsWith('plot:')) {
    const plot = MAP.plots[+station.split(':')[1]];
    if (!plot) return 'Unknown site.';
    if (!near(p, plot)) return 'Too far away.';
    if (room.steps[plot.id] >= STEPS_PER_BUILDING) return 'Already complete.';
    if (room.crisis && room.crisis.type === 'fire' && room.crisis.plotId === plot.id) return 'Put out the fire first!';
    for (const k in plot.step) if (room.stock[k] < plot.step[k]) {
      return 'Not enough resources: needs ' + Object.entries(plot.step).map(([a, b]) => b + ' ' + a).join(', ') + '.';
    }
    return null;
  }
  return 'Unknown task.';
}

function finishTask(room, p, station) {
  const crew = p.role === 'crew';
  if (RES[station]) {
    const r = RES[station];
    if (crew) room.stock[r] = Math.min(STOCK_CAP, room.stock[r] + 2);
    addLedger(room, p.name, `delivered 2 ${r}`);
    p.gatherCd[station] = room.time + 6;
    toast(p, crew ? `+2 ${r}` : `You pretend to gather ${r}. (Nothing is delivered.)`);
    return;
  }
  const plot = MAP.plots[+station.split(':')[1]];
  addLedger(room, p.name, `built a step of the ${plot.name}`);
  if (crew) {
    for (const k in plot.step) room.stock[k] -= plot.step[k];
    room.steps[plot.id]++;
    room.integrity = Math.min(100, room.integrity + 4);
    if (room.steps[plot.id] >= STEPS_PER_BUILDING) bcast(room, { t: 'alert', text: `${plot.icon} ${plot.name} is complete!` });
    else toast(p, `${plot.name}: step ${room.steps[plot.id]}/${STEPS_PER_BUILDING}`);
    checkWin(room);
  } else {
    toast(p, `You pretend to build the ${plot.name}. (No resources used.)`);
  }
}

/* ------------------------------------------------------------------ */
/* Sabotage                                                            */
/* ------------------------------------------------------------------ */
function doSabotage(room, p, kind) {
  if (p.role !== 'saboteur' || !p.alive) return;
  const cd = p.cd;
  if (kind === 'damage') {
    if (cd.damage > 0) return toast(p, `Damage ready in ${Math.ceil(cd.damage)}s`);
    const plot = MAP.plots.find(pl => near(p, pl, 90) && room.steps[pl.id] > 0);
    if (!plot) return toast(p, 'Stand next to a building that has progress.');
    const watch = room.steps[3] >= STEPS_PER_BUILDING;
    room.steps[plot.id]--; room.damaged[plot.id] = true;
    room.integrity = Math.max(0, room.integrity - 18);
    recordClue(room, 'plot:' + plot.id, plot.name, p, 'Sabotage');
    cd.damage = 22;
    toast(p, `You sabotaged the ${plot.name}.`);
    if (watch) {
      const fx = clamp(plot.x + rnd(-80, 80), 0, MAP.W), fy = clamp(plot.y + rnd(-80, 80), 0, MAP.H);
      for (const q of list(room)) if (q.alive && q.role === 'crew') { send(q, { t: 'ping', x: fx, y: fy }); toast(q, '🗼 The Watchtower lookout spotted movement!'); }
    }
    checkWin(room);
  } else if (kind === 'steal') {
    if (cd.steal > 0) return toast(p, `Steal ready in ${Math.ceil(cd.steal)}s`);
    if (!near(p, MAP.stations.store, 100)) return toast(p, 'Stand next to the Storehouse.');
    const res = Object.keys(room.stock).sort((a, b) => room.stock[b] - room.stock[a])[0];
    const amt = Math.min(3, room.stock[res]);
    if (amt <= 0) return toast(p, 'The storehouse is empty.');
    room.stock[res] -= amt;
    room.integrity = Math.max(0, room.integrity - 6);
    addLedger(room, null, `Stockpile shrank by ${amt} ${res} — nobody signed for it!`);
    recordClue(room, 'store', 'Storehouse', p, 'Theft');
    cd.steal = 25;
    toast(p, `You stole ${amt} ${res}.`);
    checkWin(room);
  } else if (kind === 'fire' || kind === 'surge' || kind === 'lights') {
    if (cd.mal > 0) return toast(p, `Malfunctions ready in ${Math.ceil(cd.mal)}s`);
    if (kind !== 'lights' && room.crisis) return toast(p, 'A crisis is already active.');
    if (kind === 'lights' && room.lights > 0) return toast(p, 'The lights are already out.');
    if (kind === 'fire') {
      const cands = MAP.plots.filter(pl => room.steps[pl.id] > 0);
      const plot = pick(cands.length ? cands : MAP.plots);
      room.crisis = { type: 'fire', plotId: plot.id, label: `Fire at the ${plot.name}`, points: [{ x: plot.x, y: plot.y }], left: 45, progress: 0 };
      bcast(room, { t: 'alert', text: `🔥 Fire at the ${plot.name}! Hold E next to it to put it out!` });
    } else if (kind === 'surge') {
      room.crisis = { type: 'surge', label: 'Power surge', points: MAP.pylons.map(q => ({ x: q.x, y: q.y })), left: 55, progress: 0 };
      bcast(room, { t: 'alert', text: '⚡ Power surge! Two builders must hold E at BOTH pylons at the same time!' });
    } else {
      room.lights = 45; room.lightsFix = 0;
      bcast(room, { t: 'alert', text: '💡 Lights out! Hold E at the Generator to restore power.' });
    }
    cd.mal = 40;
  }
}

/* ------------------------------------------------------------------ */
/* Meetings                                                            */
/* ------------------------------------------------------------------ */
function startMeeting(room, reason) {
  room.phase = 'meeting';
  room.meeting = {
    id: ++room.meetingId, stage: 'discuss', left: 45, reason,
    votes: {}, ready: new Set(), result: null, acc: 0,
  };
  const ps = list(room);
  ps.forEach((p, i) => {
    p.task = null; p.hold = false; p.dx = p.dy = 0;
    const a = i / ps.length * Math.PI * 2;
    p.x = 500 + Math.cos(a) * 90; p.y = 470 + Math.sin(a) * 60;
  });
  sendMeeting(room);
}

function sendMeeting(room) {
  const m = room.meeting; if (!m) return;
  const players = list(room).map(p => ({
    id: p.id, name: p.name, color: p.color, alive: p.alive,
    voted: m.votes[p.id] !== undefined, ready: m.ready.has(p.id),
  }));
  for (const p of list(room)) {
    send(p, { t: 'meeting', id: m.id, stage: m.stage, left: Math.max(0, Math.ceil(m.left)), reason: m.reason, players, myVote: m.votes[p.id] ?? null, result: m.result });
  }
}

function tally(room) {
  const m = room.meeting;
  const counts = {}; let skips = 0;
  const votes = [];
  for (const p of list(room)) {
    if (!p.alive) continue;
    const v = m.votes[p.id];
    if (v === undefined) continue;
    const target = list(room).find(q => q.id === v);
    votes.push({ voter: p.name, target: v === 'skip' || !target ? 'Skip' : target.name });
    if (v === 'skip' || !target) skips++; else counts[v] = (counts[v] || 0) + 1;
  }
  let best = 0, bestIds = [];
  for (const id in counts) { if (counts[id] > best) { best = counts[id]; bestIds = [id]; } else if (counts[id] === best) bestIds.push(id); }
  let ejected = null;
  if (bestIds.length === 1 && best > skips) {
    const p = room.players.get(+bestIds[0]);
    if (p) { p.alive = false; ejected = { id: p.id, name: p.name, color: p.color, role: p.role }; }
  }
  m.stage = 'result'; m.left = 7; m.result = { ejected, votes };
  sendMeeting(room);
}

function tickMeeting(room, dt) {
  const m = room.meeting; if (!m) return;
  const alive = list(room).filter(p => p.alive && p.connected);
  m.left -= dt; m.acc += dt;
  if (m.stage === 'discuss') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.ready.has(p.id)))) { m.stage = 'vote'; m.left = 30; sendMeeting(room); m.acc = 0; }
  } else if (m.stage === 'vote') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.votes[p.id] !== undefined))) { tally(room); m.acc = 0; }
  } else if (m.stage === 'result') {
    if (m.left <= 0) {
      room.meeting = null;
      bcast(room, { t: 'meetingEnd' });
      if (checkWin(room)) return;
      room.phase = 'play';
      room.damaged = room.damaged.map(() => false);
      for (const p of list(room)) if (p.role === 'saboteur') for (const k in p.cd) p.cd[k] = Math.max(p.cd[k], 15);
      return;
    }
  }
  if (m.acc >= 1) { m.acc = 0; sendMeeting(room); }
}

/* ------------------------------------------------------------------ */
/* Main tick                                                           */
/* ------------------------------------------------------------------ */
function tickPlay(room, dt) {
  room.time += dt;
  for (const p of room.players.values()) {
    if ((p.dx || p.dy) && !p.task) {
      const l = Math.hypot(p.dx, p.dy);
      const sp = (p.alive ? SPEED : SPEED * 1.2) * dt;
      p.x = clamp(p.x + p.dx / l * sp, R, MAP.W - R);
      p.y = clamp(p.y + p.dy / l * sp, R, MAP.H - R);
      if (p.alive) collide(p);
    }
    for (const k in p.cd) p.cd[k] = Math.max(0, p.cd[k] - dt);
  }
  const holders = list(room).filter(p => p.alive && p.role === 'crew' && p.hold && !p.task);

  const c = room.crisis;
  if (c) {
    c.left -= dt;
    if (c.type === 'fire') {
      const n = holders.filter(p => near(p, c.points[0], 75)).length;
      if (n) c.progress += dt * (n > 1 ? 1.5 : 1);
    } else {
      const a = holders.some(p => near(p, c.points[0], 75));
      const b = holders.some(p => near(p, c.points[1], 75));
      if (a && b) c.progress += dt; else c.progress = Math.max(0, c.progress - dt * 0.5);
    }
    if (c.progress >= 4) { room.crisis = null; bcast(room, { t: 'alert', text: '✅ Crisis resolved. Nice work!' }); }
    else if (c.left <= 0) { room.crisis = null; endGame(room, 'saboteurs', 'The crisis was not fixed in time!'); return; }
  }
  if (room.lights > 0) {
    room.lights -= dt;
    if (holders.some(p => near(p, MAP.stations.generator, 75))) room.lightsFix += dt; else room.lightsFix = Math.max(0, room.lightsFix - dt * 0.5);
    if (room.lightsFix >= 3) { room.lights = 0; bcast(room, { t: 'alert', text: '💡 The lights are back on.' }); }
    if (room.lights <= 0) room.lights = 0;
  }

  if (++room.tickN % 2 === 0) snapshot(room);
}

function snapshot(room) {
  const ps = list(room);
  const crisis = room.crisis ? { type: room.crisis.type, label: room.crisis.label, points: room.crisis.points, left: room.crisis.left, progress: room.crisis.progress } : null;
  const base = {
    t: 'state', stock: room.stock, steps: room.steps, damaged: room.damaged,
    integrity: Math.round(room.integrity), crisis, lights: room.lights > 0, time: Math.floor(room.time),
  };
  for (const r of ps) {
    const ghost = !r.alive;
    const vis = ghost ? Infinity : (room.lights > 0 && r.role === 'crew' ? DARK_VISION : VISION);
    const players = ps
      .filter(q => q === r || (ghost ? true : q.alive && dist(q, r) <= vis))
      .map(q => ({ id: q.id, x: Math.round(q.x), y: Math.round(q.y), a: q.alive ? 1 : 0, w: q.task ? q.task.station : null }));
    send(r, { ...base, players, bell: !r.bellUsed, cd: r.role === 'saboteur' ? r.cd : undefined });
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  for (const room of rooms.values()) {
    if (room.phase === 'play') tickPlay(room, dt);
    else if (room.phase === 'meeting') tickMeeting(room, dt);
  }
}, 33);

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */
function handle(ws, m) {
  if (m.t === 'join') return join(ws, m);
  const p = ws.player; if (!p) return;
  const room = p.room;
  const playing = room.phase === 'play' && p.alive;

  switch (m.t) {
    case 'start':
      if (p.host && room.phase === 'lobby') {
        if (room.players.size < MIN_PLAYERS) return toast(p, `You need at least ${MIN_PLAYERS} players.`);
        startGame(room);
      }
      break;
    case 'toLobby':
      if (p.host && room.phase === 'over') toLobby(room);
      break;
    case 'input':
      p.dx = clamp(+m.dx || 0, -1, 1); p.dy = clamp(+m.dy || 0, -1, 1);
      break;
    case 'hold':
      p.hold = !!m.on;
      break;
    case 'taskStart': {
      if (!playing) return;
      const err = validateTask(room, p, String(m.station));
      if (err) return toast(p, err);
      p.task = { station: String(m.station), start: Date.now() };
      send(p, { t: 'taskOk', station: p.task.station });
      break;
    }
    case 'taskCancel':
      p.task = null; break;
    case 'taskDone': {
      if (!playing || !p.task || p.task.station !== m.station) return;
      const ok = Date.now() - p.task.start >= 1200;
      const station = p.task.station;
      p.task = null;
      if (!ok) return;
      if (validateTask(room, p, station)) return; // state changed while working
      finishTask(room, p, station);
      break;
    }
    case 'sabotage':
      if (playing) doSabotage(room, p, String(m.kind));
      break;
    case 'inspect': {
      if (!playing) return;
      const site = SITES.filter(s => near(p, s, 90)).sort((a, b) => dist(p, a) - dist(p, b))[0];
      if (!site) return toast(p, 'Nothing to inspect here.');
      let found = false;
      if (site.key === 'store') {
        const lines = room.ledger.slice(-8).map(e => `${Math.round(room.time - e.t)}s ago — ${e.who ? e.who + ' ' : ''}${e.text}`);
        giveClue(room, p, 'Storehouse ledger', lines.length ? lines.join('\n') : 'The ledger is empty.');
        found = true;
      }
      const clue = room.clues[site.key];
      if (clue) { giveClue(room, p, `Clue: ${site.label}`, clueText(room, clue)); found = true; }
      if (!found) toast(p, 'Nothing suspicious here.');
      break;
    }
    case 'report': {
      if (!playing) return;
      const site = SITES.find(s => near(p, s, 90) && room.clues[s.key] && !room.clues[s.key].reported);
      if (!site) return toast(p, 'No fresh sabotage to report here.');
      const clue = room.clues[site.key];
      clue.reported = true;
      giveClue(room, p, `Clue: ${site.label}`, clueText(room, clue));
      startMeeting(room, `${p.name} reported sabotage at the ${site.label}!`);
      break;
    }
    case 'bell':
      if (!playing) return;
      if (p.bellUsed) return toast(p, 'You already used your emergency meeting.');
      if (!near(p, MAP.stations.bell, 90)) return toast(p, 'Stand next to the Town Bell.');
      p.bellUsed = true;
      startMeeting(room, `${p.name} rang the Town Bell!`);
      break;

    /* ---- meeting ---- */
    case 'chat': {
      const mt = room.meeting;
      if (!mt || !p.alive) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140);
      if (text) bcast(room, { t: 'chat', name: p.name, color: p.color, text, kind: 'say' });
      break;
    }
    case 'share': {
      const mt = room.meeting;
      if (!mt || !p.alive) return;
      const note = p.notebook.find(n => n.id === m.id);
      if (note) bcast(room, { t: 'chat', name: p.name, color: p.color, text: `📎 ${note.title}: ${note.text}`, kind: 'clue' });
      break;
    }
    case 'ready': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'discuss' || !p.alive) return;
      if (mt.ready.has(p.id)) mt.ready.delete(p.id); else mt.ready.add(p.id);
      sendMeeting(room);
      break;
    }
    case 'vote': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'vote' || !p.alive) return;
      if (m.target === 'skip') mt.votes[p.id] = 'skip';
      else {
        const t = room.players.get(+m.target);
        if (!t || !t.alive) return;
        mt.votes[p.id] = t.id;
      }
      sendMeeting(room);
      break;
    }
  }
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => console.log(`Build & Betray running → http://localhost:${PORT}`));
