import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { Pool } from 'pg';
// HOLLOW_STAGE_4_5_IN_PERSON_NIGHT_FLOW: the server owns every In-Person phase transition.
import {
  IN_PERSON_NIGHT_STEP_SECONDS,
  IN_PERSON_VOTE_SECONDS,
  getInPersonDiscussionSeconds,
  getInPersonMafiaDecision,
  getInPersonMafiaStepOutcome,
  getInPersonNextNightStep,
  allConnectedPlayersReady,
} from './inPersonRules.js';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  getDiscussionSeconds,
  getMafiaCap,
  resolveVote,
  getWinner,
  getNightActionProgress,
  allPlayersVoted,
  allPlayersReady,
  canTargetSelf,
} from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || !isProduction || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin is not allowed by this game server.'));
      }
    },
    methods: ['GET', 'POST'],
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    const allowed = !origin || !isProduction || allowedOrigins.includes(origin);
    callback(allowed ? null : new Error('Origin is not allowed by this game server.'), allowed);
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'The Hollow Table', time: Date.now() }));

const rooms = new Map();
const socketByPlayer = new Map();
const joinAttempts = new Map();
const chatAttempts = new Map();
let pool = null;
let livekitRoomService = null;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AVATAR_IDS = new Set(['raven','skull','ghost','bat','wolf','cat','owl','spider','moth','snake','candle','rose','moon','pumpkin','key','crow','coffin','crystal','mask','poison','blackheart','eye','rose2','moon2']);
const NIGHT_SECONDS = 90;
const VOTE_SECONDS = 100;
const TIE_SECONDS = 100;
const MURDER_TRANSITION_MS = 7200;
const QUIET_TRANSITION_MS = 5000;
const ELIMINATION_TRANSITION_MS = 13200;
const TIE_TRANSITION_MS = 9800;
const NO_ELIMINATION_TRANSITION_MS = 10800;
const MAFIA_CONFLICT_WINDOW_MS = 8000;
const MAFIA_CONFLICT_EXTENSION_MS = 15000;
const RECONNECT_GRACE_MS = 45_000;
const ROOM_TTL_HOURS = 24;
const IN_PERSON_SKIP_SECONDS = 1.25;
// Enabled by the narrator-audio stage after the bundled voice pack is installed.
const IN_PERSON_VOICE_READY = false;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function makeCode() {
  let code = '';
  for (let index = 0; index < 4; index += 1) {
    code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  }
  return code;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001F]/g, '').trim().replace(/\s+/g, ' ').slice(0, 18);
}

function cleanMessage(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, 350);
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function error(message) {
  return { ok: false, error: message };
}

function success(payload = {}) {
  return { ok: true, ...payload };
}

function randomFrom(list) {
  return list[randomBytes(2).readUInt16BE(0) % list.length];
}

function freshActions() {
  return {
    mafiaVotes: {},
    sheriffTarget: null,
    angelTarget: null,
    dayVotes: {},
    dayReady: {},
  };
}

function playerById(room, playerId) {
  return room.players.find((player) => player.id === playerId) ?? null;
}

// HOLLOW_STAGE_3_IN_PERSON_LOBBY: only one connected seat is designated to speak publicly.
function repairNarrator(room, force = false) {
  if (room.gameMode !== 'in_person') {
    room.narratorId = null;
    return;
  }
  const assigned = playerById(room, room.narratorId);
  if (assigned?.connected) return;
  if (assigned && !force) return; // Preserve a saved assignment during the server-restart reconnect grace period.
  const host = playerById(room, room.hostId);
  const fallback = (host?.connected ? host : null) || room.players.find((player) => player.connected) || null;
  room.narratorId = fallback?.id ?? null;
}

function livingPlayers(room) {
  return room.players.filter((player) => player.alive);
}

function makeAnnouncement(kind, title, text, accent = 'red', extra = {}) {
  return { id: randomUUID(), kind, title, text, accent, ...extra, createdAt: Date.now() };
}

const IN_PERSON_NIGHT_CUES = {
  role_reveal: ['THE HOUSE DEALS YOUR FATE', 'Study your secret card. The night begins when everyone has entered.', 'gold'],
  town_sleep: ['TOWN, CLOSE YOUR EYES', 'The candles are dying. Keep your eyes closed until the house calls your role.', 'red'],
  mafia: ['MAFIAS, AWAKEN', 'Mafias, agree on one living soul who will not see the dawn. The night advances when every connected Mafia chooses the same target.', 'red'],
  mafia_clash: ['CLASH OF OPINIONS', 'The Mafia choices are divided. You have one final 15-second window to agree on the same target. If disagreement remains, no one is murdered.', 'gold'],
  mafia_sleep: ['MAFIAS, RETURN TO THE DARK', 'The choice is sealed. Mafias, close your eyes.', 'muted'],
  angel: ['ANGEL, AWAKEN', 'Choose one living soul to protect. Confirm once; your protection cannot be changed tonight.', 'gold'],
  angel_sleep: ['THE HOUSE FALLS QUIET', 'The next secret is being called. Keep your eyes closed.', 'muted'],
  sheriff: ['SHERIFF, AWAKEN', 'Choose one living soul to investigate. Your result will be shown only on your phone.', 'gold'],
  sheriff_sleep: ['THE HOUSE FALLS QUIET', 'The last secret of the night is being sealed. Keep your eyes closed.', 'muted'],
  town_wake: ['TOWN, OPEN YOUR EYES', 'The house has finished its work. Dawn is breaking.', 'red'],
};

function enterInPersonNightStep(room, step, durationSeconds = IN_PERSON_NIGHT_STEP_SECONDS[step]) {
  if (room.status !== 'playing' || room.phase !== 'night') return false;
  const cue = IN_PERSON_NIGHT_CUES[step];
  if (!cue) throw new Error(`Unknown In-Person night step: ${step}`);
  room.nightStep = step;
  room.nightStepId = randomUUID();
  room.phaseEndsAt = Date.now() + Math.max(0, durationSeconds) * 1000;
  room.nightCue = makeAnnouncement('night-step', cue[0], cue[1], cue[2], { step, cueId: room.nightStepId });
  room.announcement = null;
  return true;
}

function livingConnectedMafia(room) {
  return room.players.filter((entry) => entry.alive && entry.connected && entry.role === 'mafia');
}

function inPersonMafiaDecision(room) {
  const livingMafia = room.players.filter((entry) => entry.alive && entry.role === 'mafia');
  const connectedMafia = livingConnectedMafia(room);
  const livingTargets = livingPlayers(room).map((entry) => entry.id);
  return getInPersonMafiaDecision(
    room.actions.mafiaVotes,
    livingMafia.map((entry) => entry.id),
    connectedMafia.map((entry) => entry.id),
    livingTargets,
  );
}

function inPersonMafiaDecisionSnapshot(room) {
  return inPersonMafiaDecision(room);
}

function beginMafiaSleep(room, targetId = null) {
  room.inPersonMafiaTargetId = targetId && playerById(room, targetId)?.alive ? targetId : null;
  enterInPersonNightStep(room, 'mafia_sleep');
}

function progressInPersonMafia(room, { timedOut = false } = {}) {
  if (room.status !== 'playing' || room.phase !== 'night' || !['mafia', 'mafia_clash'].includes(room.nightStep)) return false;
  const decision = inPersonMafiaDecision(room);
  const outcome = getInPersonMafiaStepOutcome(room.nightStep, decision, { timedOut });
  if (!outcome) return false;

  if (outcome.nextStep === 'mafia_clash') {
    enterInPersonNightStep(room, 'mafia_clash');
    return true;
  }
  beginMafiaSleep(room, outcome.targetId);
  return true;
}

function reconcileInPersonNightProgress(room) {
  if (room.gameMode !== 'in_person' || room.status !== 'playing' || room.phase !== 'night') return false;
  if (room.nightStep === 'role_reveal') {
    const connectedLivingIds = livingPlayers(room).filter((entry) => entry.connected).map((entry) => entry.id);
    if (allConnectedPlayersReady(connectedLivingIds, room.identityReady)) {
      enterInPersonNightStep(room, 'town_sleep');
      return true;
    }
    return false;
  }
  if (room.nightStep === 'mafia' || room.nightStep === 'mafia_clash') {
    return progressInPersonMafia(room);
  }
  if (room.nightStep === 'angel' && !room.players.some((entry) => entry.alive && entry.connected && entry.role === 'angel')) {
    enterInPersonNightStep(room, 'angel_sleep', IN_PERSON_SKIP_SECONDS);
    return true;
  }
  if (room.nightStep === 'sheriff' && !room.players.some((entry) => entry.alive && entry.connected && entry.role === 'sheriff')) {
    enterInPersonNightStep(room, 'sheriff_sleep', IN_PERSON_SKIP_SECONDS);
    return true;
  }
  return false;
}

function advanceInPersonNightStep(room, { timedOut = false } = {}) {
  if (room.status !== 'playing' || room.phase !== 'night') return false;
  switch (room.nightStep) {
    case 'role_reveal':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep));
      return true;
    case 'town_sleep': {
      const nextStep = getInPersonNextNightStep(room.nightStep, { hasConnectedMafia: livingConnectedMafia(room).length > 0 });
      if (nextStep === 'mafia_sleep') beginMafiaSleep(room);
      else enterInPersonNightStep(room, nextStep);
      return true;
    }
    case 'mafia':
    case 'mafia_clash':
      return progressInPersonMafia(room, { timedOut });
    case 'mafia_sleep': {
      const hasAngel = room.players.some((entry) => entry.alive && entry.connected && entry.role === 'angel');
      const nextStep = getInPersonNextNightStep(room.nightStep, { hasConnectedAngel: hasAngel });
      if (nextStep === 'angel_sleep') enterInPersonNightStep(room, nextStep, IN_PERSON_SKIP_SECONDS);
      else enterInPersonNightStep(room, nextStep);
      return true;
    }
    case 'angel':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep));
      return true;
    case 'angel_sleep': {
      const hasSheriff = room.players.some((entry) => entry.alive && entry.connected && entry.role === 'sheriff');
      const nextStep = getInPersonNextNightStep(room.nightStep, { hasConnectedSheriff: hasSheriff });
      if (nextStep === 'sheriff_sleep') enterInPersonNightStep(room, nextStep, IN_PERSON_SKIP_SECONDS);
      else enterInPersonNightStep(room, nextStep);
      return true;
    }
    case 'sheriff':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep));
      return true;
    case 'sheriff_sleep':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep));
      return true;
    case 'town_wake':
      resolveNight(room);
      return true;
    default:
      return false;
  }
}

const murderStories = [
  (name) => `At 3:13 a.m., the cellar door opened by itself. ${name} went down. Only their shadow came back.`,
  (name) => `${name} heard someone calling from the locked attic. By morning, the bed was cold and the key was still inside the room.`,
  (name) => `A candle went out. Something moved behind the curtains. When the lights returned, ${name} was gone.`,
  (name) => `The house clock stopped at 3:13. A slow knock came from beneath the floor. ${name} never answered roll call.`,
  (name) => `The fog closed around ${name} beneath the courtyard arch. Their footsteps returned alone.`,
  (name) => `${name}'s chair was empty. Three fresh scratches marked the table, pointing toward the dark below.`,
];

const eliminationStories = [
  (name) => `The table called ${name} to the front of the room. The lights died. When they returned, the chair was empty.`,
  (name) => `${name} followed a pale figure through the red door. It closed quietly. No footsteps returned.`,
  (name) => `The lift carried ${name} below the house. The floor indicator kept descending long after the basement.`,
  (name) => `A voice whispered ${name}'s name from the winter garden. They answered. The mist closed behind them.`,
  (name) => `A final invitation waited for ${name}. The music stopped as soon as they crossed the threshold.`,
  (name) => `The staircase groaned under ${name}'s feet. A second set of footsteps followed. Only one person reached the bottom.`,
];

function roleDescription(role, gameMode = 'online') {
  const inPerson = gameMode === 'in_person';
  const descriptions = {
    mafia: inPerson
      ? 'Choose a living target with your team. Every connected Mafia must agree on the same person. A 15-second clash is the final chance to settle a disagreement; if it remains unresolved, there is no murder.'
      : 'Choose a victim with your team. A single submitted target counts; conflicting choices trigger one final 15-second window.',
    sheriff: inPerson
      ? 'Investigate one living player when the house calls you. Your first choice locks immediately, and the result is shown only on this phone.'
      : 'Inspect one player each night. Your first choice locks permanently, and your result is shown only to you.',
    angel: inPerson
      ? 'Protect one living player, including yourself, when the house calls you. Your first confirmation locks immediately. You cannot protect the same person on consecutive nights.'
      : 'Protect one player each night, including yourself. You may change your choice until the night ends. Your protection is never revealed.',
    citizen: 'Listen, discuss, and vote to find the Mafia.',
  };
  return descriptions[role] ?? '';
}


function makeSnapshot(room, playerId) {
  const me = playerById(room, playerId);
  if (!me) return null;
  const revealAll = room.status === 'finished';
  const narrator = room.gameMode === 'in_person' ? playerById(room, room.narratorId || room.hostId) : null;
  const mafiaTeam = me.role === 'mafia' && me.alive
    ? room.players.filter((p) => p.role === 'mafia').map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, alive: p.alive }))
    : [];
  const myActionSubmitted = room.phase === 'night'
    ? (me.role === 'mafia' ? Boolean(room.actions.mafiaVotes[me.id])
      : me.role === 'sheriff' ? Boolean(room.actions.sheriffTarget)
        : me.role === 'angel' ? Boolean(room.actions.angelTarget) : false)
    : ['voting', 'tieVoting'].includes(room.phase) ? Object.hasOwn(room.actions.dayVotes, me.id) : false;
  const inPersonMafiaDecision = room.gameMode === 'in_person' && room.phase === 'night'
    ? inPersonMafiaDecisionSnapshot(room) : null;
  const chat = room.chat.filter((message) => message.scope === 'public' || (message.scope === 'mafia' && me.role === 'mafia' && me.alive));
  const dayReady = room.actions.dayReady ?? {};
  const nightProgress = room.phase === 'night' ? getNightActionProgress(room) : null;
  const maySeeMafiaChoices = room.gameMode !== 'in_person' || ['mafia', 'mafia_clash'].includes(room.nightStep);
  const mafiaChoices = me.role === 'mafia' && me.alive && maySeeMafiaChoices
    ? room.players.filter((player) => player.alive && player.role === 'mafia').map((player) => {
        const targetId = room.actions.mafiaVotes?.[player.id];
        const target = targetId ? playerById(room, targetId) : null;
        return { id: player.id, name: player.name, avatar: player.avatar, connected: player.connected, targetName: target?.alive ? target.name : null, submitted: Boolean(targetId) };
      })
    : [];
  return {
    code: room.code,
    gameMode: room.gameMode === 'in_person' ? 'in_person' : 'online',
    narratorId: narrator?.id ?? null,
    narrator: narrator ? { id: narrator.id, name: narrator.name, avatar: narrator.avatar, connected: narrator.connected } : null,
    serverNow: Date.now(),
    status: room.status,
    hostId: room.hostId,
    settings: { ...room.settings },
    playerCount: room.players.length,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      alive: player.alive,
      connected: player.connected,
      isHost: player.id === room.hostId,
      isNarrator: room.gameMode === 'in_person' && player.id === (room.narratorId || room.hostId),
      role: revealAll ? player.role : null,
    })),
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    nightStep: room.gameMode === 'in_person' && room.phase === 'night' ? (room.nightStep ?? null) : null,
    nightCue: room.gameMode === 'in_person' && room.phase === 'night' ? (room.nightCue ?? null) : null,
    identityReadiness: room.gameMode === 'in_person' && room.nightStep === 'role_reveal' ? {
      ready: livingPlayers(room).filter((entry) => entry.connected && room.identityReady?.[entry.id]).length,
      required: livingPlayers(room).filter((entry) => entry.connected).length,
    } : null,
    transition: room.transition ? {
      id: room.transition.id,
      kind: room.transition.kind,
      startedAt: room.transition.startedAt,
      durationMs: room.transition.durationMs,
      victimName: room.transition.victimName ?? null,
      victimAvatar: room.transition.victimAvatar ?? null,
    } : null,
    voteReveal: room.phase === 'transition' ? (room.voteReveal ?? null) : null,
    announcement: room.announcement,
    lastDeathAnnouncement: room.lastDeathAnnouncement ?? null,
    winner: room.winner,
    tieCandidates: room.tieCandidates.map((id) => {
      const target = playerById(room, id);
      return target ? { id: target.id, name: target.name, avatar: target.avatar } : null;
    }).filter(Boolean),
    discussionReadiness: {
      ready: (room.gameMode === 'in_person' ? livingPlayers(room).filter((player) => player.connected) : livingPlayers(room)).filter((player) => dayReady[player.id]).length,
      required: (room.gameMode === 'in_person' ? livingPlayers(room).filter((player) => player.connected) : livingPlayers(room)).length,
    },
    mafiaChoices,
    chat,
    me: {
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      role: me.role ?? null,
      roleDescription: me.role ? roleDescription(me.role, room.gameMode) : '',
      alive: me.alive,
      connected: me.connected,
      isHost: me.id === room.hostId,
      isNarrator: room.gameMode === 'in_person' && me.id === (room.narratorId || room.hostId),
      myActionSubmitted,
      readyToVote: Boolean(dayReady[me.id]),
      mafiaTeam,
      privateResults: me.privateResults ?? [],
    },
    actionProgress: room.phase === 'night'
      ? me.role === 'mafia' && me.alive ? (room.gameMode === 'in_person' ? {
          submitted: inPersonMafiaDecision?.submitted ?? 0,
          required: inPersonMafiaDecision?.required ?? 0,
          mafiaAgreed: Boolean(inPersonMafiaDecision?.winnerId),
          conflicting: Boolean(inPersonMafiaDecision?.conflict),
          mafiaTargetState: inPersonMafiaDecision?.conflict ? 'conflict' : inPersonMafiaDecision?.winnerId ? 'single' : 'none',
          conflictExtensionUsed: room.nightStep === 'mafia_clash',
        } : {
          submitted: nightProgress.mafiaSubmitted,
          required: nightProgress.mafiaRequired,
          mafiaAgreed: nightProgress.mafiaDone,
          conflicting: getMafiaVoteState(room).kind === 'conflict',
          mafiaTargetState: getMafiaVoteState(room).kind,
          conflictExtensionUsed: Boolean(room.mafiaConflictExtensionUsed),
        }) : { submitted: 0, required: 0, mafiaAgreed: false }
      : ['voting', 'tieVoting'].includes(room.phase) ? {
          submitted: Object.keys(room.actions.dayVotes ?? {}).length,
          required: livingPlayers(room).length,
        } : { submitted: 0, required: 0 },
  };
}

async function saveRoom(room) {
  if (!pool || !room) return;
  try {
    const expiresAt = new Date(Date.now() + ROOM_TTL_HOURS * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO hollow_rooms (code, state, updated_at, expires_at)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [room.code, JSON.stringify(room), expiresAt],
    );
  } catch (err) {
    console.error('Could not persist room:', err.message);
  }
}

async function deleteRoom(code) {
  rooms.delete(code);
  if (pool) {
    try { await pool.query('DELETE FROM hollow_rooms WHERE code = $1', [code]); }
    catch (err) { console.error('Could not delete room:', err.message); }
  }
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Room state will be in memory only.');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hollow_rooms (
      code CHAR(4) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hollow_rooms_expires_at_idx ON hollow_rooms (expires_at);
  `);
  const { rows } = await pool.query('SELECT state FROM hollow_rooms WHERE expires_at > NOW()');
  for (const row of rows) {
    const room = row.state;
    if (!room || !room.code || !Array.isArray(room.players)) continue;
    // HOLLOW_STAGE_2_MODE_SELECTION: rooms saved before this update remain Online.
    room.gameMode = room.gameMode === 'in_person' ? 'in_person' : 'online';
    room.narratorId = room.gameMode === 'in_person'
      ? (playerById(room, room.narratorId) ? room.narratorId : room.hostId)
      : null;
    room.nightStep ??= null;
    room.nightCue ??= null;
    room.identityReady ??= {};
    room.inPersonMafiaTargetId ??= null;
    for (const player of room.players) { player.connected = false; player.disconnectAt = Date.now(); }
    // Give the original host a reconnect window after a server restart/deploy.
    // Without this, the first guest to resume can accidentally take host ownership.
    room.hostGraceUntil = Date.now() + RECONNECT_GRACE_MS;
    rooms.set(room.code, room);
  }
  await pool.query('DELETE FROM hollow_rooms WHERE expires_at <= NOW()');
  console.log(`Restored ${rooms.size} game room(s) from PostgreSQL.`);
}

function attachSocket(room, player, socket) {
  const currentHost = playerById(room, room.hostId);
  if (!currentHost || (!currentHost.connected && (!room.hostGraceUntil || Date.now() >= room.hostGraceUntil))) {
    room.hostId = player.id;
    room.hostGraceUntil = null;
  }

  // Claim the new socket before disconnecting the old one. Otherwise the old
  // socket's asynchronous disconnect event can mark this reconnected player offline.
  const previousSocketId = socketByPlayer.get(player.id);
  player.connected = true;
  player.disconnectAt = null;
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(`table:${room.code}`);
  socketByPlayer.set(player.id, socket.id);
  if (room.gameMode === 'in_person' && (!room.narratorId || !playerById(room, room.narratorId))) repairNarrator(room);

  if (previousSocketId && previousSocketId !== socket.id) {
    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (previousSocket) {
      previousSocket.emit('session:replaced');
      previousSocket.data.code = null;
      previousSocket.data.playerId = null;
      previousSocket.disconnect(true);
    }
  }
}

function emitRoom(room) {
  for (const player of room.players) {
    if (!player.connected) continue;
    const socketId = socketByPlayer.get(player.id);
    if (!socketId) continue;
    const snapshot = makeSnapshot(room, player.id);
    if (snapshot) io.to(socketId).emit('room:state', snapshot);
  }
}

async function commit(room) {
  room.lastActivityAt = Date.now();
  emitRoom(room);
  await saveRoom(room);
}

function addPrivateResult(player, text, kind = 'info', details = {}) {
  player.privateResults ??= [];
  player.privateResults.unshift({ id: randomUUID(), text, kind, ...details, at: Date.now() });
  player.privateResults = player.privateResults.slice(0, 12);
}

function setDiscussion(room) {
  room.phase = 'discussion';
  const durationSeconds = room.gameMode === 'in_person'
    ? getInPersonDiscussionSeconds(livingPlayers(room).length)
    : getDiscussionSeconds(room.round);
  room.phaseEndsAt = Date.now() + durationSeconds * 1000;
  room.tieCandidates = [];
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
  room.transition = null;
  room.voteReveal = null;
  room.announcement = null;
  room.nightStep = null;
  room.nightCue = null;
}

function votingPlayers(room) {
  return room.gameMode === 'in_person'
    ? livingPlayers(room).filter((player) => player.connected)
    : livingPlayers(room);
}

function everyoneVoted(room) {
  const eligibleIds = votingPlayers(room).map((player) => player.id);
  return allPlayersVoted(eligibleIds, room.actions.dayVotes ?? {});
}

function everyoneReady(room) {
  const eligibleIds = votingPlayers(room).map((player) => player.id);
  return allPlayersReady(eligibleIds, room.actions.dayReady ?? {});
}

function reconcileInPersonDayProgress(room) {
  if (room.gameMode !== 'in_person' || room.status !== 'playing') return false;
  if (room.phase === 'discussion' && everyoneReady(room)) {
    beginVoting(room);
    return true;
  }
  if (room.phase === 'voting' && everyoneVoted(room)) {
    resolveDayVoting(room, false);
    return true;
  }
  if (room.phase === 'tieVoting' && everyoneVoted(room)) {
    resolveDayVoting(room, true);
    return true;
  }
  return false;
}

function beginVoting(room) {
  room.phase = 'voting';
  const durationSeconds = room.gameMode === 'in_person' ? IN_PERSON_VOTE_SECONDS : VOTE_SECONDS;
  room.phaseEndsAt = Date.now() + durationSeconds * 1000;
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
  room.transition = null;
  room.voteReveal = null;
  room.nightStep = null;
  room.nightCue = null;
  room.announcement = makeAnnouncement('phase', 'THE VOTE BEGINS', 'Choose the name you believe is hiding in the dark. The vote is private.', 'gold');
}

function beginNextNight(room) {
  room.round += 1;
  room.phase = 'night';
  room.actions = freshActions();
  room.tieCandidates = [];
  room.transition = null;
  room.voteReveal = null;
  room.mafiaConflictExtensionUsed = false;
  room.inPersonMafiaTargetId = null;
  room.announcement = null;
  if (room.gameMode === 'in_person') {
    room.identityReady = {};
    enterInPersonNightStep(room, 'town_sleep');
  } else {
    room.phaseEndsAt = Date.now() + NIGHT_SECONDS * 1000;
    room.nightStep = null;
    room.nightCue = null;
  }
}

function finishGame(room, winner) {
  room.status = 'finished';
  room.phase = 'finished';
  room.phaseEndsAt = null;
  room.nightStep = null;
  room.nightCue = null;
  room.transition = null;
  room.voteReveal = null;
  room.winner = winner;
  room.finishedAt = Date.now();
  room.announcement = makeAnnouncement(
    'victory',
    winner === 'mafia' ? 'THE MAFIA CLAIM THE HOUSE' : 'THE TOWN SURVIVES THE NIGHT',
    winner === 'mafia'
      ? 'The last candle gutters out. The Mafia have taken the table, and the house belongs to them.'
      : 'The final shadow retreats beyond the gates. Every member of the Mafia has been unmasked. The town survives.',
    winner === 'mafia' ? 'red' : 'gold',
  );
}

function checkVictory(room) {
  const winner = getWinner(room.players);
  if (!winner) return false;
  finishGame(room, winner);
  return true;
}

function reconcileAfterRosterChange(room) {
  const winner = getWinner(room.players);
  if (winner) {
    finishGame(room, winner);
    return true;
  }
  if (room.phase === 'transition' && room.transition?.pendingWinner) {
    room.transition.pendingWinner = null;
    room.transition.nextPhase = ['murder', 'quiet'].includes(room.transition.kind) ? 'discussion' : 'night';
  }
  return false;
}

function startTransition(room, kind, durationMs, nextPhase, pendingWinner = null) {
  const startedAt = Date.now();
  room.phase = 'transition';
  room.phaseEndsAt = startedAt + durationMs;
  room.nightStep = null;
  room.nightCue = null;
  room.transition = {
    id: randomUUID(),
    kind,
    startedAt,
    durationMs,
    nextPhase,
    pendingWinner,
    victimName: room.announcement?.victimName ?? null,
    victimAvatar: room.announcement?.victimAvatar ?? null,
  };
}

function completeTransition(room) {
  const transition = room.transition;
  if (!transition) {
    beginNextNight(room);
    return;
  }
  if (transition.pendingWinner) {
    finishGame(room, transition.pendingWinner);
    return;
  }
  if (transition.nextPhase === 'discussion') {
    setDiscussion(room);
    return;
  }
  if (transition.nextPhase === 'tieVoting') {
    room.phase = 'tieVoting';
    room.phaseEndsAt = Date.now() + (room.gameMode === 'in_person' ? IN_PERSON_VOTE_SECONDS : TIE_SECONDS) * 1000;
    room.transition = null;
    room.voteReveal = null;
    room.actions.dayVotes = {};
    return;
  }
  beginNextNight(room);
}

function createVoteReveal(room) {
  const rows = livingPlayers(room).map((voter) => {
    const targetId = room.actions.dayVotes?.[voter.id] ?? null;
    const target = targetId ? playerById(room, targetId) : null;
    return {
      voterId: voter.id,
      voterName: voter.name,
      voterAvatar: voter.avatar,
      targetId,
      targetName: target?.name ?? null,
      targetAvatar: target?.avatar ?? null,
    };
  });
  return { id: randomUUID(), rows, createdAt: Date.now() };
}

function getMafiaVoteState(room) {
  const livingMafia = room.players.filter((player) => player.alive && player.role === 'mafia');
  const votes = livingMafia
    .map((player) => ({ playerId: player.id, targetId: room.actions.mafiaVotes?.[player.id] }))
    .filter((vote) => vote.targetId && playerById(room, vote.targetId)?.alive);
  const targets = [...new Set(votes.map((vote) => vote.targetId))];
  if (targets.length === 0) return { kind: 'none', targetId: null, votes, counts: new Map() };
  const counts = new Map();
  for (const vote of votes) counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  if (targets.length === 1) return { kind: 'single', targetId: targets[0], votes, counts };
  return { kind: 'conflict', targetId: null, votes, counts };
}

function chooseMafiaTargetAtDeadline(room) {
  const state = getMafiaVoteState(room);
  if (state.kind === 'single') return state.targetId;
  if (state.kind !== 'conflict') return null;
  const ranked = [...state.counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0]?.[0] ?? null;
}

function extendForMafiaConflict(room, now) {
  if (room.mafiaConflictExtensionUsed || room.phase !== 'night') return false;
  const remaining = (room.phaseEndsAt ?? 0) - now;
  if (remaining > MAFIA_CONFLICT_WINDOW_MS) return false;
  if (getMafiaVoteState(room).kind !== 'conflict') return false;
  room.phaseEndsAt += MAFIA_CONFLICT_EXTENSION_MS;
  room.mafiaConflictExtensionUsed = true;
  return true;
}

function clearPlayerActions(room, player) {
  delete room.actions.mafiaVotes?.[player.id];
  delete room.actions.dayVotes?.[player.id];
  delete room.actions.dayReady?.[player.id];
  const inPersonNight = room.gameMode === 'in_person' && room.phase === 'night';
  if (player.role === 'sheriff' && (!inPersonNight || room.nightStep === 'sheriff')) room.actions.sheriffTarget = null;
  if (player.role === 'angel' && (!inPersonNight || room.nightStep === 'angel')) room.actions.angelTarget = null;
  if (room.actions.angelTarget === player.id) room.actions.angelTarget = null;
  if (room.inPersonMafiaTargetId === player.id) room.inPersonMafiaTargetId = null;
  for (const [voterId, targetId] of Object.entries(room.actions.mafiaVotes ?? {})) {
    if (targetId === player.id) delete room.actions.mafiaVotes[voterId];
  }
  for (const [voterId, targetId] of Object.entries(room.actions.dayVotes ?? {})) {
    if (targetId === player.id) delete room.actions.dayVotes[voterId];
  }
  room.tieCandidates = (room.tieCandidates ?? []).filter((id) => id !== player.id);
}

function removeEliminatedPlayerFromVoice(room, player) {
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return;
  try {
    if (!livekitRoomService) {
      const httpUrl = process.env.LIVEKIT_URL.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
      livekitRoomService = new RoomServiceClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    }
    const mode = room.phase === 'night' ? 'night' : 'day';
    const voiceRoom = `hollow-${room.code}-${mode}-${room.round}`;
    livekitRoomService.removeParticipant(voiceRoom, player.id, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) })
      .catch((err) => console.warn('LiveKit participant removal:', err.message));
  } catch (err) {
    console.warn('LiveKit participant removal could not start:', err.message);
  }
}

function forfeitPlayer(room, player) {
  if (!player || !player.alive) return false;
  player.alive = false;
  player.connected = false;
  player.eliminatedAt = Date.now();
  removeEliminatedPlayerFromVoice(room, player);
  room.announcement = makeAnnouncement(
    'departure',
    'A SEAT FALLS SILENT',
    `${player.name} has abandoned the table. Their chair remains empty, and the house counts the silence as a final confession.`,
    'muted',
    { victimName: player.name, victimAvatar: player.avatar },
  );
  room.lastDeathAnnouncement = room.announcement;
  return true;
}

function eliminatePlayer(room, targetId, type) {
  const target = playerById(room, targetId);
  if (!target || !target.alive) return false;
  target.alive = false;
  removeEliminatedPlayerFromVoice(room, target);
  target.eliminatedAt = Date.now();
  if (type === 'murder') {
    room.announcement = makeAnnouncement(
      'murder',
      'A MURDER IN THE DARK',
      randomFrom(murderStories)(target.name),
      'red',
      { victimName: target.name, victimAvatar: target.avatar },
    );
  } else {
    room.announcement = makeAnnouncement(
      'elimination',
      'THE TABLE HAS PASSED ITS JUDGEMENT',
      randomFrom(eliminationStories)(target.name),
      'gold',
      { victimName: target.name, victimAvatar: target.avatar },
    );
  }
  room.lastDeathAnnouncement = room.announcement;
  return true;
}

function resolveNight(room) {
  if (room.status !== 'playing' || room.phase !== 'night') return;
  const murderTargetId = room.gameMode === 'in_person'
    ? (room.inPersonMafiaTargetId && playerById(room, room.inPersonMafiaTargetId)?.alive ? room.inPersonMafiaTargetId : null)
    : chooseMafiaTargetAtDeadline(room);
  const protectedTargetId = room.actions.angelTarget;
  // Remember the target selected for this completed night so the Angel cannot
  // protect the same player in two consecutive rounds. This is room state and
  // is persisted with the normal room commit.
  // The consecutive-round restriction only remembers the immediately prior night.
  room.angelLastProtectedTargetId = protectedTargetId ?? null;
  const sheriff = room.players.find((player) => player.alive && player.role === 'sheriff');

  if (murderTargetId && murderTargetId !== protectedTargetId) {
    eliminatePlayer(room, murderTargetId, 'murder');
    const winner = getWinner(room.players);
    startTransition(room, 'murder', MURDER_TRANSITION_MS, winner ? 'finished' : 'discussion', winner);
    return;
  }

  // A saved target and a night with no valid target are deliberately indistinguishable.
  room.announcement = makeAnnouncement(
    'quiet',
    'THE NIGHT LEFT NO TRACE',
    'No one was found at dawn. Whatever moved through the house kept its secret.',
    'muted',
  );
  const winner = getWinner(room.players);
  startTransition(room, 'quiet', QUIET_TRANSITION_MS, winner ? 'finished' : 'discussion', winner);
}

function resolveDayVoting(room, isTieBreak = false) {
  const allowed = isTieBreak ? new Set(room.tieCandidates) : null;
  room.voteReveal = createVoteReveal(room);
  const result = resolveVote(room.actions.dayVotes, allowed, isTieBreak);

  if (result.type === 'eliminate') {
    eliminatePlayer(room, result.targetId, 'elimination');
    const winner = getWinner(room.players);
    startTransition(room, 'elimination', ELIMINATION_TRANSITION_MS, winner ? 'finished' : 'night', winner);
    return;
  }

  if (result.type === 'tie') {
    room.tieCandidates = result.candidates;
    room.actions.dayVotes = {};
    const names = result.candidates.map((id) => playerById(room, id)?.name).filter(Boolean).join(' and ');
    room.announcement = makeAnnouncement(
      'tie',
      'THE TABLE CANNOT AGREE',
      `${names} stand accused. The living have up to ${room.gameMode === 'in_person' ? '30 seconds' : '100 seconds'} to reconsider their votes. Only the tied candidates may receive votes.`,
      'gold',
    );
    startTransition(room, 'tie', TIE_TRANSITION_MS, 'tieVoting');
    return;
  }

  room.tieCandidates = [];
  room.announcement = makeAnnouncement(
    'no-elimination',
    'NO ONE LEAVES THE TABLE',
    'The votes remain divided. The table has reached no verdict, and no one is eliminated.',
    'muted',
  );
  startTransition(room, 'no-elimination', NO_ELIMINATION_TRANSITION_MS, 'night');
}

async function tickRooms() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    let changed = false;

    // A brief grace period lets someone recover from a refresh, network dip, or accidental tab close.
    for (const player of [...room.players]) {
      if (player.connected || !player.disconnectAt || now - player.disconnectAt < RECONNECT_GRACE_MS) continue;
      player.disconnectAt = null;
      player.tokenHash = null;
      if (room.status === 'lobby') {
        room.players = room.players.filter((entry) => entry.id !== player.id);
      } else if (room.status === 'playing' && player.alive) {
        forfeitPlayer(room, player);
        clearPlayerActions(room, player);
        if (room.gameMode === 'in_person') {
          reconcileInPersonNightProgress(room);
          reconcileInPersonDayProgress(room);
        }
      }
      if (room.hostId === player.id) {
        room.hostId = room.players.find((entry) => entry.connected && entry.id !== player.id)?.id
          ?? room.players.find((entry) => entry.id !== player.id)?.id
          ?? null;
        room.hostGraceUntil = null;
      }
      if (room.gameMode === 'in_person') repairNarrator(room, true);
      changed = true;
    }

    if (room.status === 'lobby' && room.players.length === 0) {
      await deleteRoom(room.code);
      continue;
    }
    if (changed && room.status === 'playing') {
      if (reconcileAfterRosterChange(room)) {
        // A disconnect can change the faction balance; publish the final verdict.
      } else if (room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
        startTransition(room, 'no-elimination', NO_ELIMINATION_TRANSITION_MS, 'night');
      } else if (['voting', 'tieVoting'].includes(room.phase) && everyoneVoted(room)) {
        resolveDayVoting(room, room.phase === 'tieVoting');
      }
    }

    if (room.hostGraceUntil && now >= room.hostGraceUntil) {
      const nextHost = room.players.find((player) => player.connected)?.id;
      if (nextHost) room.hostId = nextHost;
      room.hostGraceUntil = null;
      changed = true;
    }

    if (room.status === 'playing' && room.gameMode === 'in_person' && room.phase === 'night' && room.phaseEndsAt && now >= room.phaseEndsAt) {
      advanceInPersonNightStep(room, { timedOut: true });
      changed = true;
    } else if (room.status === 'playing' && room.phase === 'night' && room.gameMode !== 'in_person' && extendForMafiaConflict(room, now)) {
      changed = true;
    } else if (room.status === 'playing' && room.phaseEndsAt && now >= room.phaseEndsAt) {
      if (room.phase === 'night') resolveNight(room);
      else if (room.phase === 'discussion') beginVoting(room);
      else if (room.phase === 'voting') resolveDayVoting(room, false);
      else if (room.phase === 'tieVoting') resolveDayVoting(room, true);
      else if (room.phase === 'transition') completeTransition(room);
      changed = true;
    }

    if (now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL_HOURS * 60 * 60 * 1000) {
      await deleteRoom(room.code);
      continue;
    }
    if (changed) await commit(room);
  }
}

function ipAllowed(ip) {
  const now = Date.now();
  const item = joinAttempts.get(ip) ?? { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + 5 * 60 * 1000;
  }
  item.count += 1;
  joinAttempts.set(ip, item);
  return item.count <= 18;
}

function chatAllowed(playerId) {
  const now = Date.now();
  const entries = (chatAttempts.get(playerId) ?? []).filter((time) => now - time < 5000);
  if (entries.length >= 8) return false;
  entries.push(now);
  chatAttempts.set(playerId, entries);
  return true;
}

function socketPlayer(socket) {
  const room = rooms.get(socket.data.code);
  const player = room ? playerById(room, socket.data.playerId) : null;
  if (!room || !player) return null;
  return { room, player };
}

function withPlayer(socket, callback, handler) {
  return async (payload = {}, ack) => {
    try {
      const context = socketPlayer(socket);
      if (!context) return reply(ack, error('Your table session has expired. Rejoin using your table code.'));
      const result = await handler(context.room, context.player, payload);
      reply(ack, result ?? success());
    } catch (err) {
      console.error(`Socket action ${callback} failed:`, err);
      reply(ack, error('Something went wrong. Please try again.'));
    }
  };
}

io.on('connection', (socket) => {
  socket.on('room:create', async (payload = {}, ack) => {
    try {
      if (socket.data.code && socket.data.playerId) return reply(ack, error('Leave your current table before creating another.'));
      const ip = socket.handshake.address || 'unknown';
      if (!ipAllowed(ip)) return reply(ack, error('Too many room attempts. Please wait a few minutes and try again.'));
      const name = cleanName(payload.name);
      const avatar = AVATAR_IDS.has(String(payload.avatar)) ? String(payload.avatar) : 'raven';
      const maxPlayers = Math.min(16, Math.max(5, Number(payload.maxPlayers) || 10));
      const gameMode = payload.gameMode === 'in_person' ? 'in_person' : 'online';
      if (name.length < 2) return reply(ack, error('Choose a nickname with at least two characters.'));
      let code = makeCode();
      let attempts = 0;
      while (rooms.has(code) && attempts < 100) { code = makeCode(); attempts += 1; }
      if (rooms.has(code)) return reply(ack, error('Could not create a unique table code. Try again.'));
      const id = randomUUID();
      const token = randomBytes(32).toString('hex');
      const room = {
        code,
        gameMode,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'lobby',
        hostId: id,
        narratorId: gameMode === 'in_person' ? id : null,
        hostGraceUntil: null,
        settings: { maxPlayers, mafiaCount: Math.min(2, getMafiaCap(maxPlayers)) },
        players: [{ id, name, avatar, tokenHash: hashToken(token), role: null, alive: true, connected: true, joinedAt: Date.now(), privateResults: [] }],
        phase: 'lobby',
        round: 0,
        phaseEndsAt: null,
        actions: freshActions(),
        tieCandidates: [],
        transition: null,
        voteReveal: null,
        mafiaConflictExtensionUsed: false,
        announcement: makeAnnouncement('welcome', 'THE HOLLOW TABLE', 'The house has opened its doors. Invite only those you trust.', 'gold'),
        chat: [],
        winner: null,
      };
      rooms.set(code, room);
      attachSocket(room, room.players[0], socket);
      await commit(room);
      reply(ack, success({ code, token, snapshot: makeSnapshot(room, id) }));
    } catch (err) {
      console.error('Create room failed:', err);
      reply(ack, error('The table could not be created. Please try again.'));
    }
  });

  socket.on('room:join', async (payload = {}, ack) => {
    try {
      if (socket.data.code && socket.data.playerId) return reply(ack, error('Leave your current table before joining another.'));
      const ip = socket.handshake.address || 'unknown';
      if (!ipAllowed(ip)) return reply(ack, error('Too many join attempts. Please wait a few minutes and try again.'));
      const code = String(payload.code || '').trim().toUpperCase();
      const name = cleanName(payload.name);
      let avatar = AVATAR_IDS.has(String(payload.avatar)) ? String(payload.avatar) : 'raven';
      if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return reply(ack, error('Enter a valid four-character table code.'));
      const room = rooms.get(code);
      if (!room) return reply(ack, error('No table was found with that code. Check the code and try again.'));
      const requestedMode = payload.gameMode === 'in_person' || payload.gameMode === 'online' ? payload.gameMode : null;
      const roomMode = room.gameMode === 'in_person' ? 'in_person' : 'online';
      if (roomMode === 'in_person' && !requestedMode) return reply(ack, error('Update your game before joining this In-Person gathering.'));
      if (requestedMode && requestedMode !== roomMode) return reply(ack, error(roomMode === 'in_person' ? 'This code belongs to an In-Person gathering. Choose Gather at the Table first.' : 'This code belongs to an Online table. Choose Summon from Afar first.'));
      if (room.status !== 'lobby') return reply(ack, error('This game has already started. New players cannot join.'));
      if (room.players.length >= room.settings.maxPlayers) return reply(ack, error('This table is full.'));
      if (name.length < 2) return reply(ack, error('Choose a nickname with at least two characters.'));
      if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return reply(ack, error('That nickname is already taken at this table.'));
      if (room.players.some((player) => player.avatar === avatar)) {
        avatar = [...AVATAR_IDS].find((candidate) => !room.players.some((player) => player.avatar === candidate));
      }
      if (!avatar) return reply(ack, error('All portraits at this table are taken.'));
      const id = randomUUID();
      const token = randomBytes(32).toString('hex');
      const player = { id, name, avatar, tokenHash: hashToken(token), role: null, alive: true, connected: true, joinedAt: Date.now(), privateResults: [] };
      room.players.push(player);
      attachSocket(room, player, socket);
      await commit(room);
      reply(ack, success({ code, token, snapshot: makeSnapshot(room, id) }));
    } catch (err) {
      console.error('Join room failed:', err);
      reply(ack, error('Could not join this table. Please try again.'));
    }
  });

  socket.on('room:resume', async (payload = {}, ack) => {
    try {
      const code = String(payload.code || '').trim().toUpperCase();
      const token = String(payload.token || '');
      const room = rooms.get(code);
      if (!room || !token) return reply(ack, error('Saved table session not found.'));
      const tokenHash = hashToken(token);
      const player = room.players.find((entry) => entry.tokenHash && entry.tokenHash === tokenHash);
      if (!player) return reply(ack, error('This reconnect code is no longer valid.'));
      attachSocket(room, player, socket);
      if (room.hostId === player.id) room.hostGraceUntil = null;
      await commit(room);
      reply(ack, success({ code, snapshot: makeSnapshot(room, player.id) }));
    } catch (err) {
      console.error('Resume room failed:', err);
      reply(ack, error('Could not restore your seat. Please try again.'));
    }
  });

  socket.on('lobby:update', withPlayer(socket, 'lobby:update', async (room, player, payload) => {
    if (room.status !== 'lobby') return error('Table settings are locked after the game starts.');
    if (room.hostId !== player.id) return error('Only the host can change table settings.');
    const maxPlayers = Number(payload.maxPlayers);
    const mafiaCount = Number(payload.mafiaCount);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 5 || maxPlayers > 16) return error('Player limit must be between 5 and 16.');
    if (maxPlayers < room.players.length) return error('Player limit cannot be lower than the number of people already seated.');
    if (!Number.isInteger(mafiaCount) || mafiaCount < 1 || mafiaCount > getMafiaCap(maxPlayers)) return error(`Mafia count must be between 1 and ${getMafiaCap(maxPlayers)} for this player limit.`);
    room.settings.maxPlayers = maxPlayers;
    room.settings.mafiaCount = mafiaCount;
    await commit(room);
    return success();
  }));

  socket.on('lobby:narrator:set', withPlayer(socket, 'lobby:narrator:set', async (room, host, payload) => {
    if (room.status !== 'lobby') return error('The narrator device is locked after the game begins.');
    if (room.gameMode !== 'in_person') return error('A narrator device is only used for In-Person gatherings.');
    if (room.hostId !== host.id) return error('Only the host can assign the narrator device.');
    const target = playerById(room, String(payload.playerId || ''));
    if (!target) return error('That player is no longer at the table.');
    if (!target.connected) return error('The narrator device must be connected to the table.');
    room.narratorId = target.id;
    await commit(room);
    return success({ narratorId: target.id });
  }));

  socket.on('lobby:start', withPlayer(socket, 'lobby:start', async (room, player) => {
    if (room.status !== 'lobby') return error('This game has already started.');
    if (room.hostId !== player.id) return error('Only the host can start the game.');
    if (room.gameMode === 'in_person' && !IN_PERSON_VOICE_READY) {
      return error('The In-Person night sequence is prepared, but the narrator voice system must be installed before the first gathering can begin.');
    }
    if (room.players.length < 5) return error('At least five players are required to begin.');
    const mafiaCap = getMafiaCap(room.players.length);
    if (room.settings.mafiaCount > mafiaCap) return error(`With ${room.players.length} players, the maximum Mafia count is ${mafiaCap}.`);
    if (room.gameMode === 'in_person') {
      repairNarrator(room);
      const narrator = playerById(room, room.narratorId);
      if (!narrator?.connected) return error('Connect or assign a narrator phone before beginning the gathering.');
    }
    const shuffled = [...room.players];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = randomBytes(2).readUInt16BE(0) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((entry, index) => {
      entry.role = index < room.settings.mafiaCount ? 'mafia' : null;
    });
    let remaining = shuffled.filter((entry) => !entry.role);
    const sheriff = remaining.splice(randomBytes(2).readUInt16BE(0) % remaining.length, 1)[0];
    sheriff.role = 'sheriff';
    const angel = remaining.splice(randomBytes(2).readUInt16BE(0) % remaining.length, 1)[0];
    angel.role = 'angel';
    remaining.forEach((entry) => { entry.role = 'citizen'; });
    room.status = 'playing';
    room.round = 1;
    room.angelLastProtectedTargetId = null;
    room.phase = 'night';
    room.actions = freshActions();
    room.tieCandidates = [];
    room.transition = null;
    room.voteReveal = null;
    room.mafiaConflictExtensionUsed = false;
    room.inPersonMafiaTargetId = null;
    room.nightStep = null;
    room.nightCue = null;
    room.identityReady = {};
    room.announcement = makeAnnouncement('phase', 'NIGHT 1 · THE HOUSE GOES SILENT', 'Your role has been chosen. The doors are locked. The Mafia may now choose their victim.', 'red');
    room.players.forEach((entry) => { entry.privateResults = []; });
    if (room.gameMode === 'in_person') {
      enterInPersonNightStep(room, 'role_reveal');
    } else {
      room.phaseEndsAt = Date.now() + NIGHT_SECONDS * 1000;
    }
    await commit(room);
    return success();
  }));

  socket.on('identity:ready', withPlayer(socket, 'identity:ready', async (room, player) => {
    if (room.gameMode !== 'in_person' || room.status !== 'playing' || room.phase !== 'night' || room.nightStep !== 'role_reveal') {
      return error('The private identity check is not open.');
    }
    if (!player.alive) return error('The fallen cannot confirm an identity card.');
    room.identityReady ??= {};
    room.identityReady[player.id] = true;
    reconcileInPersonNightProgress(room);
    await commit(room);
    return success({ ready: true, started: room.nightStep !== 'role_reveal' });
  }));

  socket.on('night:act', withPlayer(socket, 'night:act', async (room, player, payload) => {
    if (room.status !== 'playing' || room.phase !== 'night') return error('Night actions are not open.');
    if (!player.alive) return error('Ghosts cannot perform night actions.');
    const target = playerById(room, String(payload.targetId || ''));
    if (!target || !target.alive) return error('Choose a living player.');
    // Mafia may deliberately select themselves; Angel may protect themselves.
    if (target.id === player.id && player.role !== 'mafia' && !canTargetSelf(player.role)) {
      return error('You cannot choose yourself.');
    }

    if (room.gameMode === 'in_person') {
      if (player.role === 'mafia') {
        if (!['mafia', 'mafia_clash'].includes(room.nightStep)) return error('The Mafias are not being summoned right now.');
        room.actions.mafiaVotes[player.id] = target.id;
        progressInPersonMafia(room);
      } else if (player.role === 'angel') {
        if (room.nightStep !== 'angel') return error('The Angel is not being summoned right now.');
        if (room.actions.angelTarget) return error('Your protection is already sealed for this night.');
        if (target.id === room.angelLastProtectedTargetId) {
          return error('You cannot protect the same player in consecutive rounds. Choose someone else this night.');
        }
        room.actions.angelTarget = target.id;
        enterInPersonNightStep(room, 'angel_sleep');
      } else if (player.role === 'sheriff') {
        if (room.nightStep !== 'sheriff') return error('The Sheriff is not being summoned right now.');
        if (room.actions.sheriffTarget) return error('Your investigation is already locked for this night.');
        if (target.id === player.id) return error('You cannot investigate yourself.');
        room.actions.sheriffTarget = target.id;
        const isMafia = target.role === 'mafia';
        addPrivateResult(
          player,
          `${target.name} is ${isMafia ? 'MAFIA' : 'NOT MAFIA'}.`,
          isMafia ? 'danger' : 'success',
          { targetName: target.name, targetAvatar: target.avatar },
        );
        enterInPersonNightStep(room, 'sheriff_sleep');
      } else {
        return error('Your role has no night action.');
      }
      await commit(room);
      return success({ submitted: true, locked: player.role !== 'mafia' });
    }

    // Original Online mode: simultaneous night actions and its existing timing remain unchanged.
    if (player.role === 'mafia') {
      room.actions.mafiaVotes[player.id] = target.id;
    } else if (player.role === 'sheriff') {
      if (room.actions.sheriffTarget) return error('Your investigation is already locked for this night.');
      room.actions.sheriffTarget = target.id;
      const isMafia = target.role === 'mafia';
      addPrivateResult(
        player,
        `${target.name} is ${isMafia ? 'MAFIA' : 'NOT MAFIA'}.`,
        isMafia ? 'danger' : 'success',
        { targetName: target.name, targetAvatar: target.avatar },
      );
    } else if (player.role === 'angel') {
      if (target.id === room.angelLastProtectedTargetId) {
        return error('You cannot protect the same player in consecutive rounds. Choose someone else this night.');
      }
      room.actions.angelTarget = target.id;
    } else {
      return error('Your role has no night action.');
    }
    await commit(room);
    return success({ submitted: true });
  }));

  socket.on('day:ready', withPlayer(socket, 'day:ready', async (room, player) => {
    if (room.status !== 'playing' || room.phase !== 'discussion') return error('The discussion phase is closed.');
    if (!player.alive) return error('Ghosts cannot ready the vote.');
    room.actions.dayReady ??= {};
    const ready = !Boolean(room.actions.dayReady[player.id]);
    if (ready) room.actions.dayReady[player.id] = true;
    else delete room.actions.dayReady[player.id];
    const living = votingPlayers(room);
    const readyCount = living.filter((member) => room.actions.dayReady[member.id]).length;
    // In-Person disconnected seats cannot press Ready; they do not hold the table open.
    const started = living.length > 0 && readyCount === living.length;
    if (started) beginVoting(room);
    await commit(room);
    return success({ ready, readyCount, required: living.length, started });
  }));

  socket.on('day:vote', withPlayer(socket, 'day:vote', async (room, player, payload) => {
    if (room.status !== 'playing' || !['voting', 'tieVoting'].includes(room.phase)) return error('Voting is not open.');
    if (!player.alive) return error('Ghosts cannot vote.');
    const target = playerById(room, String(payload.targetId || ''));
    if (!target || !target.alive || target.id === player.id) return error('Choose another living player.');
    if (room.phase === 'tieVoting' && !room.tieCandidates.includes(target.id)) return error('You can only vote for one of the tied candidates.');
    room.actions.dayVotes[player.id] = target.id;
    const tieBreak = room.phase === 'tieVoting';
    if (everyoneVoted(room)) resolveDayVoting(room, tieBreak);
    await commit(room);
    return success({ submitted: true, resolved: room.phase !== (tieBreak ? 'tieVoting' : 'voting') });
  }));

  socket.on('room:kick', withPlayer(socket, 'room:kick', async (room, host, payload) => {
    if (room.hostId !== host.id) return error('Only the host can remove a guest.');
    if (room.status === 'finished') return error('The game has already finished.');
    const target = playerById(room, String(payload.playerId || ''));
    if (!target) return error('That guest is no longer at the table.');
    if (target.id === host.id) return error('The host cannot remove their own seat.');

    const targetSocketId = socketByPlayer.get(target.id);
    const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
    target.tokenHash = null;
    target.connected = false;
    target.disconnectAt = null;
    socketByPlayer.delete(target.id);

    if (room.status === 'lobby') {
      room.players = room.players.filter((entry) => entry.id !== target.id);
    } else if (room.status === 'playing') {
      if (target.alive) forfeitPlayer(room, target);
      clearPlayerActions(room, target);
      const wonByRosterChange = reconcileAfterRosterChange(room);
      if (!wonByRosterChange && room.gameMode === 'in_person') {
        reconcileInPersonNightProgress(room);
        reconcileInPersonDayProgress(room);
      }
      if (!wonByRosterChange && room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
        startTransition(room, 'no-elimination', NO_ELIMINATION_TRANSITION_MS, 'night');
      } else if (!wonByRosterChange && ['voting', 'tieVoting'].includes(room.phase) && everyoneVoted(room)) {
        resolveDayVoting(room, room.phase === 'tieVoting');
      }
    }

    if (room.gameMode === 'in_person' && room.narratorId === target.id) {
      room.narratorId = null;
      repairNarrator(room, true);
    }
    if (targetSocket) {
      targetSocket.emit('session:kicked', { reason: 'The host removed your seat from this table.' });
      targetSocket.data.code = null;
      targetSocket.data.playerId = null;
      targetSocket.leave(`table:${room.code}`);
      targetSocket.disconnect(true);
    }
    await commit(room);
    return success({ removed: true, playerName: target.name });
  }));

  socket.on('chat:send', withPlayer(socket, 'chat:send', async (room, player, payload) => {
    if (room.gameMode === 'in_person') return error('In-Person players speak at the physical table; phone chat is disabled.');
    if (!player.alive) return error('The dead cannot speak at the table.');
    const text = cleanMessage(payload.text);
    if (!text) return error('Write a message before sending.');
    if (!chatAllowed(player.id)) return error('Slow down. The house is listening.');
    let scope = 'public';
    if (room.phase === 'night') {
      if (player.role !== 'mafia') return error('The town is silent during the night.');
      scope = 'mafia';
    } else if (!['discussion', 'voting', 'tieVoting'].includes(room.phase)) {
      return error('Chat is closed during this phase.');
    }
    room.chat.push({ id: randomUUID(), playerId: player.id, playerName: player.name, avatar: player.avatar, text, scope, at: Date.now() });
    room.chat = room.chat.slice(-100);
    await commit(room);
    return success();
  }));

  socket.on('room:leave', withPlayer(socket, 'room:leave', async (room, player) => {
    socketByPlayer.delete(player.id);
    player.tokenHash = null;
    socket.leave(`table:${room.code}`);
    socket.data.code = null;
    socket.data.playerId = null;

    if (room.status === 'lobby') {
      room.players = room.players.filter((entry) => entry.id !== player.id);
      if (room.players.length === 0) {
        await deleteRoom(room.code);
        return success({ left: true, deleted: true });
      }
      if (room.hostId === player.id) room.hostId = room.players.find((entry) => entry.connected)?.id ?? room.players[0].id;
      if (room.gameMode === 'in_person') repairNarrator(room, true);
      await commit(room);
      return success({ left: true });
    }

    if (room.status === 'playing') {
      forfeitPlayer(room, player);
      player.connected = false;
      player.disconnectAt = null;
      clearPlayerActions(room, player);
      if (room.gameMode === 'in_person') {
        reconcileInPersonNightProgress(room);
        reconcileInPersonDayProgress(room);
      }
      if (room.hostId === player.id) {
        room.hostId = room.players.find((entry) => entry.connected && entry.id !== player.id)?.id ?? room.hostId;
        room.hostGraceUntil = null;
      }
      if (room.gameMode === 'in_person') repairNarrator(room, true);
      if (reconcileAfterRosterChange(room)) {
        // The departure itself may decide the game.
      } else if (room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        beginNextNight(room);
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
      } else if (['voting', 'tieVoting'].includes(room.phase) && everyoneVoted(room)) {
        resolveDayVoting(room, room.phase === 'tieVoting');
      }
    } else {
      player.connected = false;
      player.disconnectAt = Date.now();
    }
    await commit(room);
    return success({ left: true });
  }));

  socket.on('disconnect', async () => {
    const { code, playerId } = socket.data;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    const player = room ? playerById(room, playerId) : null;
    if (!player) return;
    if (socketByPlayer.get(playerId) && socketByPlayer.get(playerId) !== socket.id) return;
    if (socketByPlayer.get(playerId) === socket.id) socketByPlayer.delete(playerId);
    player.connected = false;
    player.disconnectAt = Date.now();
    if (room.hostId === player.id) room.hostGraceUntil = Date.now() + RECONNECT_GRACE_MS;
    if (room.gameMode === 'in_person' && room.narratorId === player.id) repairNarrator(room, true);
    if (room.gameMode === 'in_person') {
      reconcileInPersonNightProgress(room);
      reconcileInPersonDayProgress(room);
    }
    await commit(room);
  });
});

app.post('/api/voice-token', async (req, res) => {
  try {
    const { code, phase } = req.body ?? {};
    const token = String(req.headers['x-player-token'] || '');
    if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      return res.status(503).json({ error: 'Voice chat is not configured on this deployment yet.' });
    }
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || !token) return res.status(401).json({ error: 'Your table session could not be verified.' });
    if (room.gameMode === 'in_person') return res.status(403).json({ error: 'In-Person gatherings use the shared physical room, not LiveKit voice chat.' });
    const player = room.players.find((entry) => entry.tokenHash === hashToken(token));
    if (!player || !player.alive || !player.connected) return res.status(403).json({ error: 'Only living, connected players can use voice chat.' });
    const allowedPhase = ['discussion', 'voting', 'tieVoting'].includes(room.phase)
      || (room.phase === 'night' && player.role === 'mafia');
    if (!allowedPhase) return res.status(403).json({ error: 'Voice chat is closed during this phase.' });
    const voiceRoom = room.phase === 'night' ? `hollow-${room.code}-night-${room.round}` : `hollow-${room.code}-day-${room.round}`;
    const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: player.id,
      name: player.name,
      ttl: '15m',
    });
    accessToken.addGrant({ roomJoin: true, room: voiceRoom, canPublish: true, canSubscribe: true });
    const jwt = await accessToken.toJwt();
    res.json({ token: jwt, serverUrl: process.env.LIVEKIT_URL, room: voiceRoom });
  } catch (err) {
    console.error('LiveKit token error:', err);
    res.status(500).json({ error: 'Could not start voice chat.' });
  }
});

if (isProduction) {
  const distPath = path.resolve(__dirname, '../client/dist');
  app.use(express.static(distPath));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

await initializeDatabase();
setInterval(() => { tickRooms().catch((err) => console.error('Game clock error:', err)); }, 500);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Hollow Table server is listening on port ${PORT}`);
});
