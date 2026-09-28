'use strict';
/**
 * BUILD & BETRAY — round-based, text-only, Mafia-style.
 * Run:  npm install && npm start   →  http://localhost:3000
 *
 * Every round:
 *   1. ACT     everyone secretly picks a location (saboteurs also pick a secret move)
 *   2. RESOLVE tasks / sabotage / repairs are worked out
 *   3. MEETING everyone learns what happened, talks, then votes someone out
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const MIN_PLAYERS = 3, MAX_PLAYERS = 10;
const MAX_ROUNDS = 15, START_HP = 10;
const ACT_TIME = 35, DISCUSS_TIME = 45, VOTE_TIME = 30, RESULT_TIME = 7;
const COLORS = ['🔴', '🔵', '🟢', '🟡', '🟣', '🟠', '🟤', '⚪', '🌸', '🔘'];

const LOCS = {
  forest:   { name: 'Forest',     icon: '🌲', desc: 'Chop wood (+3 🪵)' },
  quarry:   { name: 'Quarry',     icon: '⛏️', desc: 'Mine stone (+3 🪨)' },
  farm:     { name: 'Farm',       icon: '🌾', desc: 'Harvest food (+3 🌾)' },
  workshop: { name: 'Workshop',   icon: '🔨', desc: 'Build: uses 1 🪵 1 🪨 1 🌾 → +1 progress' },
  store:    { name: 'Storehouse', icon: '📦', desc: 'Audit: count who arrived vs. who delivered' },
};
const RES = { forest: 'wood', quarry: 'stone', farm: 'food' };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const list = room => [...room.players.values()];
const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const bcast = (room, o) => { const s = JSON.stringify(o); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const toast = (p, text) => send(p, { t: 'toast', text });
const pick = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function genCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
const aliveCrew = room => list(room).filter(p => p.alive && p.role === 'crew');
const need = room => Math.max(1, Math.min(2, aliveCrew(room).length));

/* ------------------------------------------------------------------ */
/* Rooms / lobby                                                       */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const newRoom = code => ({ code, players: new Map(), phase: 'lobby', round: 0, meetingId: 0, meeting: null, choices: {}, left: 0 });

function sendLobby(room) {
  bcast(room, { t: 'lobby', room: room.code, min: MIN_PLAYERS, players: list(room).map(p => ({ id: p.id, name: p.name, color: p.color, host: p.host })) });
}

let nextId = 1;
function join(ws, m) {
  if (ws.player) return;
  const err = text => ws.send(JSON.stringify({ t: 'error', text }));
  const base = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || 'Builder';
  let room;
  if (m.create) {
    let code; do { code = genCode(); } while (rooms.has(code));
    room = newRoom(code); rooms.set(code, room);
  } else {
    room = rooms.get(String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5));
    if (!room) return err('Room not found. Check the code.');
  }
  if (room.phase !== 'lobby') return err('That game has already started.');
  if (room.players.size >= MAX_PLAYERS) return err('Room is full.');
  let name = base, n = 2;
  while (list(room).some(q => q.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 10) + n++;
  const used = new Set(list(room).map(q => q.color));
  const p = {
    id: nextId++, ws, room, name, color: COLORS.find(c => !used.has(c)) || '🔵', host: room.players.size === 0,
    connected: true, role: 'crew', alive: true, cd: {}, notes: [],
  };
  ws.player = p; room.players.set(p.id, p);
  send(p, { t: 'joined', id: p.id, room: room.code });
  sendLobby(room);
}

function leave(ws) {
  const p = ws.player; if (!p) return;
  const room = p.room; p.connected = false;
  if (room.phase === 'lobby') room.players.delete(p.id);
  else {
    p.alive = false;
    if (room.meeting) { delete room.meeting.votes[p.id]; room.meeting.ready.delete(p.id); }
    bcast(room, { t: 'toast', text: p.name + ' left the game.' });
  }
  const conn = list(room).filter(q => q.connected);
  if (!conn.length) { rooms.delete(room.code); return; }
  if (p.host) { p.host = false; conn[0].host = true; send(conn[0], { t: 'host' }); }
  if (room.phase === 'lobby') sendLobby(room);
  else if (room.phase === 'act') checkWin(room);
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */
function snap(room) {
  return {
    round: room.round, maxRounds: MAX_ROUNDS, hp: room.hp, maxHp: START_HP,
    progress: room.progress, goal: room.goal, stock: room.stock, broken: room.broken,
    crisis: room.crisis ? { loc: room.crisis.loc, left: room.crisis.left, need: need(room) } : null,
    players: list(room).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive })),
  };
}

function startGame(room) {
  const ps = shuffle(list(room));
  const nSab = ps.length >= 7 ? 2 : 1;
  ps.forEach((p, i) => { p.role = i < nSab ? 'saboteur' : 'crew'; p.alive = true; p.cd = { break: 0, steal: 0, crisis: 2 }; p.notes = []; });
  room.round = 0; room.hp = START_HP; room.progress = 0;
  room.goal = Math.max(6, Math.min(20, 2 * (ps.length - nSab)));
  room.stock = { wood: 2, stone: 2, food: 2 };
  room.broken = { forest: false, quarry: false, farm: false, workshop: false, store: false };
  room.crisis = null; room.meeting = null; room.choices = {};
  const roster = list(room).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const sabNames = ps.filter(p => p.role === 'saboteur').map(p => p.name);
  for (const p of list(room)) {
    send(p, { t: 'start', meId: p.id, role: p.role, mates: p.role === 'saboteur' ? sabNames.filter(n => n !== p.name) : [], players: roster, locs: LOCS, goal: room.goal });
  }
  beginRound(room);
}

function beginRound(room) {
  room.round++;
  if (room.round > MAX_ROUNDS) return endGame(room, 'saboteurs', 'Winter arrived before the settlement was finished.');
  room.phase = 'act'; room.left = ACT_TIME; room.choices = {};
  const total = list(room).filter(p => p.alive && p.connected).length;
  for (const p of list(room)) {
    send(p, { t: 'act', ...snap(room), left: room.left, total, cd: p.role === 'saboteur' ? p.cd : null });
  }
}

function endGame(room, winner, reason, events) {
  if (room.phase === 'over') return true;
  room.phase = 'over'; room.meeting = null;
  bcast(room, { t: 'over', winner, reason, events: events || [], players: list(room).map(p => ({ name: p.name, color: p.color, role: p.role, alive: p.alive })) });
  return true;
}

function checkWin(room, events) {
  if (room.phase === 'over') return true;
  const alive = list(room).filter(p => p.alive);
  const sab = alive.filter(p => p.role === 'saboteur').length, crew = alive.length - sab;
  if (room.progress >= room.goal) return endGame(room, 'crew', 'The settlement is complete!', events);
  if (sab === 0) return endGame(room, 'crew', 'Every saboteur has been voted out!', events);
  if (room.hp <= 0) return endGame(room, 'saboteurs', 'The settlement collapsed (health reached 0).', events);
  if (room.crisis && room.crisis.left <= 0) return endGame(room, 'saboteurs', 'The fire was not put out in time.', events);
  if (sab >= crew) return endGame(room, 'saboteurs', 'The saboteurs outnumber the builders.', events);
  return false;
}

function giveNote(room, p, title, text) {
  const id = `n${room.round}-${p.notes.length}`;
  const note = { id, round: room.round, title, text };
  p.notes.push(note);
  send(p, { t: 'note', ...note });
}

/* ------------------------------------------------------------------ */
/* Resolving a round                                                   */
/* ------------------------------------------------------------------ */
function resolveRound(room) {
  const all = list(room), alive = all.filter(p => p.alive);
  const crew = alive.filter(p => p.role === 'crew'), sabs = alive.filter(p => p.role === 'saboteur');
  const ch = p => room.choices[p.id] || { loc: null, act: 'fake' };
  const priv = {}; all.forEach(p => priv[p.id] = []);
  const events = [];
  const hpStart = room.hp;
  const wasBroken = { ...room.broken };
  const crisisActive = room.crisis;
  const newBroken = new Set();
  let newCrisis = null;

  // 1. Sabotage: breaks and theft happen first
  for (const s of sabs) {
    const c = ch(s);
    if (!c.loc) { priv[s.id].push('You stayed home this round.'); continue; }
    const L = LOCS[c.loc];
    if (c.act === 'break') {
      if (c.loc !== 'store' && !room.broken[c.loc] && s.cd.break <= 0) {
        room.broken[c.loc] = true; newBroken.add(c.loc); s.cd.break = 2;
        events.push(`🔧 The ${L.name} broke down!`);
        priv[s.id].push(`You sabotaged the ${L.name}.`);
      } else priv[s.id].push('Your sabotage did not work.');
    } else if (c.act === 'steal') {
      const res = Object.keys(room.stock).sort((a, b) => room.stock[b] - room.stock[a])[0];
      const amt = Math.min(3, room.stock[res]);
      if (c.loc === 'store' && s.cd.steal <= 0 && amt > 0) {
        room.stock[res] -= amt; room.hp -= 1; s.cd.steal = 3;
        events.push(`📦 ${amt} ${res} vanished from the Storehouse!`);
        priv[s.id].push(`You stole ${amt} ${res}.`);
      } else priv[s.id].push('Your theft did not work.');
    } else if (c.act === 'crisis') {
      if (!room.crisis && !newCrisis && s.cd.crisis <= 0) {
        newCrisis = { loc: c.loc }; s.cd.crisis = 5;
        priv[s.id].push(`You will start a fire at the ${L.name}.`);
      } else priv[s.id].push('Your fire did not start.');
    } else priv[s.id].push(`You pretended to work at the ${L.name}.`);
  }

  // 2. Repairs of places that were already broken at the start of the round
  for (const k in LOCS) {
    if (!wasBroken[k]) continue;
    const reps = crew.filter(p => ch(p).loc === k);
    if (reps.length) {
      room.broken[k] = false;
      events.push(`✅ The ${LOCS[k].name} was repaired.`);
      reps.forEach(p => priv[p.id].push(`You repaired the ${LOCS[k].name}.`));
    }
  }

  // 3. Fire fighting
  if (crisisActive) {
    const here = crew.filter(p => ch(p).loc === crisisActive.loc);
    const n = need(room);
    if (here.length >= n) {
      room.crisis = null;
      events.push(`✅ The fire at the ${LOCS[crisisActive.loc].name} was put out!`);
      here.forEach(p => priv[p.id].push('You helped put out the fire.'));
    } else {
      crisisActive.left--;
      here.forEach(p => priv[p.id].push(`The fire needs ${n} builders together, but only ${here.length} came.`));
    }
  }

  // 4. Work (halted completely while a fire burns)
  const deliv = { forest: 0, quarry: 0, farm: 0, workshop: 0 };
  let built = 0;
  const workers = [];
  for (const p of crew) {
    const loc = ch(p).loc;
    if (!loc) { priv[p.id].push('You stayed home this round.'); continue; }
    const L = LOCS[loc];
    if (crisisActive) { if (loc !== crisisActive.loc) priv[p.id].push('🔥 A fire is burning. All tasks are halted!'); continue; }
    if (wasBroken[loc]) continue;
    if (newBroken.has(loc)) { priv[p.id].push(`The ${L.name} broke down while you were working. Nothing done.`); continue; }
    if (RES[loc]) {
      room.stock[RES[loc]] = Math.min(30, room.stock[RES[loc]] + 3); deliv[loc]++;
      priv[p.id].push(`You delivered +3 ${RES[loc]}.`);
    } else workers.push([p, loc]);
  }
  for (const [p, loc] of workers) {
    if (loc === 'workshop') {
      const s = room.stock;
      if (s.wood >= 1 && s.stone >= 1 && s.food >= 1) { s.wood--; s.stone--; s.food--; room.progress++; built++; deliv.workshop++; priv[p.id].push('You built +1 progress.'); }
      else priv[p.id].push('Not enough resources to build (needs 1 wood, 1 stone, 1 food).');
    }
  }
  const arrived = {};
  for (const k in LOCS) arrived[k] = alive.filter(p => ch(p).loc === k).length;
  for (const [p, loc] of workers) {
    if (loc === 'store') {
      const lines = ['forest', 'quarry', 'farm', 'workshop'].map(k => {
        const L = LOCS[k];
        if (wasBroken[k] || newBroken.has(k)) return `${L.icon} ${L.name}: closed (broken)`;
        return `${L.icon} ${L.name}: ${arrived[k]} arrived, ${deliv[k]} delivered`;
      });
      giveNote(room, p, 'Storehouse audit', lines.join('\n'));
      priv[p.id].push('You audited the storehouse (see notebook).');
    }
  }

  // 5. Fire starts after work (takes effect next round)
  if (newCrisis) {
    room.crisis = { loc: newCrisis.loc, left: 2 };
    events.push(`🔥 FIRE at the ${LOCS[newCrisis.loc].name}! All tasks stop until ${need(room)} builder(s) put it out together. You have 2 rounds!`);
  }

  // 6. Damage over time
  let drain = 0;
  for (const k in room.broken) if (room.broken[k]) drain++;
  if (crisisActive && room.crisis) drain += 2;
  room.hp = Math.max(0, room.hp - drain);
  if (built) events.push(`🏗️ Built ${built} this round. Progress ${room.progress}/${room.goal}.`);
  if (hpStart - room.hp > 0) events.push(`❤️ Settlement health ${hpStart} → ${room.hp}.`);
  const brokenNow = Object.keys(room.broken).filter(k => room.broken[k]).map(k => LOCS[k].name);
  if (brokenNow.length) events.push(`🔧 Still broken: ${brokenNow.join(', ')} (−1 ❤️ each round).`);
  if (!events.length) events.push('Nothing unusual happened.');

  // 7. Who saw whom (private)
  for (const p of alive) {
    const c = ch(p);
    if (!c.loc) continue;
    const names = alive.filter(q => q !== p && ch(q).loc === c.loc).map(q => q.name);
    priv[p.id].push(names.length ? `👀 You saw ${names.join(', ')} at the ${LOCS[c.loc].name}.` : `👀 You were alone at the ${LOCS[c.loc].name}.`);
  }
  // ghosts see everything
  const reveal = Object.keys(LOCS).map(k => `${LOCS[k].icon} ${LOCS[k].name}: ${alive.filter(p => ch(p).loc === k).map(p => p.name).join(', ') || '—'}`).join('\n');
  for (const p of all) if (!p.alive && p.connected) giveNote(room, p, 'Full reveal (spectator)', reveal);
  for (const p of alive) giveNote(room, p, `Round ${room.round}: what you saw`, priv[p.id].join('\n'));

  for (const s of all) for (const k in s.cd) s.cd[k] = Math.max(0, s.cd[k] - 1);

  if (checkWin(room, events)) return;
  startMeeting(room, events);
}

/* ------------------------------------------------------------------ */
/* Meeting                                                             */
/* ------------------------------------------------------------------ */
function startMeeting(room, events) {
  room.phase = 'meeting';
  room.meeting = { id: ++room.meetingId, stage: 'discuss', left: DISCUSS_TIME, votes: {}, ready: new Set(), result: null, events, acc: 0 };
  sendMeeting(room);
}
function sendMeeting(room) {
  const m = room.meeting; if (!m) return;
  const players = list(room).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, voted: m.votes[p.id] !== undefined, ready: m.ready.has(p.id) }));
  for (const p of list(room)) {
    send(p, { t: 'meeting', ...snap(room), id: m.id, stage: m.stage, left: Math.max(0, Math.ceil(m.left)), events: m.events, players, myVote: m.votes[p.id] ?? null, result: m.result });
  }
}
function tally(room) {
  const m = room.meeting, counts = {}, votes = [];
  let skips = 0;
  for (const p of list(room)) {
    if (!p.alive) continue;
    const v = m.votes[p.id]; if (v === undefined) continue;
    const t = room.players.get(v);
    votes.push({ voter: p.name, target: v === 'skip' || !t ? 'Skip' : t.name });
    if (v === 'skip' || !t) skips++; else counts[v] = (counts[v] || 0) + 1;
  }
  let best = 0, ids = [];
  for (const id in counts) { if (counts[id] > best) { best = counts[id]; ids = [id]; } else if (counts[id] === best) ids.push(id); }
  let ejected = null;
  if (ids.length === 1 && best > skips) {
    const p = room.players.get(+ids[0]);
    if (p) { p.alive = false; ejected = { id: p.id, name: p.name, role: p.role }; }
  }
  m.stage = 'result'; m.left = RESULT_TIME; m.result = { ejected, votes };
  sendMeeting(room);
}
function tickMeeting(room, dt) {
  const m = room.meeting; if (!m) return;
  const alive = list(room).filter(p => p.alive && p.connected);
  m.left -= dt;
  if (m.stage === 'discuss') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.ready.has(p.id)))) { m.stage = 'vote'; m.left = VOTE_TIME; sendMeeting(room); }
  } else if (m.stage === 'vote') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.votes[p.id] !== undefined))) tally(room);
  } else if (m.left <= 0) {
    room.meeting = null;
    bcast(room, { t: 'meetingEnd' });
    if (checkWin(room)) return;
    beginRound(room);
  }
}

/* ------------------------------------------------------------------ */
/* Tick                                                                */
/* ------------------------------------------------------------------ */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(1, (now - lastTick) / 1000); lastTick = now;
  for (const room of rooms.values()) {
    if (room.phase === 'act') {
      room.left -= dt;
      const alive = list(room).filter(p => p.alive && p.connected);
      if (room.left <= 0 || (alive.length && alive.every(p => room.choices[p.id]))) resolveRound(room);
    } else if (room.phase === 'meeting') tickMeeting(room, dt);
  }
}, 250);

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */
function handle(ws, m) {
  if (m.t === 'join') return join(ws, m);
  const p = ws.player; if (!p) return;
  const room = p.room;

  switch (m.t) {
    case 'start':
      if (p.host && room.phase === 'lobby') {
        if (room.players.size < MIN_PLAYERS) return toast(p, `You need at least ${MIN_PLAYERS} players.`);
        startGame(room);
      }
      break;
    case 'toLobby':
      if (p.host && room.phase === 'over') {
        room.phase = 'lobby'; room.meeting = null;
        for (const q of [...room.players.values()]) { if (!q.connected) room.players.delete(q.id); else { q.alive = true; q.role = 'crew'; } }
        sendLobby(room);
      }
      break;
    case 'pick': {
      if (room.phase !== 'act' || !p.alive) return;
      const loc = String(m.loc);
      if (!LOCS[loc]) return;
      let act = 'work';
      if (p.role === 'saboteur') {
        act = ['fake', 'break', 'steal', 'crisis'].includes(m.act) ? m.act : 'fake';
        if (act === 'break' && (loc === 'store' || room.broken[loc])) return toast(p, 'You can only break a working place (not the Storehouse).');
        if (act === 'steal' && loc !== 'store') return toast(p, 'You can only steal at the Storehouse.');
        if (act === 'crisis' && room.crisis) return toast(p, 'A fire is already burning.');
        if (act !== 'fake' && p.cd[act] > 0) return toast(p, `That move is not ready (${p.cd[act]} round(s)).`);
      }
      room.choices[p.id] = { loc, act };
      send(p, { t: 'myChoice', loc, act: p.role === 'saboteur' ? act : 'fake' });
      bcast(room, { t: 'picked', n: Object.keys(room.choices).length, total: list(room).filter(q => q.alive && q.connected).length });
      break;
    }
    case 'chat': {
      if (!room.meeting || !p.alive) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160);
      if (text) bcast(room, { t: 'chat', name: p.name, color: p.color, text, kind: 'say' });
      break;
    }
    case 'share': {
      if (!room.meeting || !p.alive) return;
      const n = p.notes.find(x => x.id === m.id);
      if (n) bcast(room, { t: 'chat', name: p.name, color: p.color, text: `📎 ${n.title}\n${n.text}`, kind: 'clue' });
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
      else { const t = room.players.get(+m.target); if (!t || !t.alive) return; mt.votes[p.id] = t.id; }
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
