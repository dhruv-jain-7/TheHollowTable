import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import { getDatabaseConnectionOptions } from './databaseConfig.js';
import { cleanDisplayName, cleanChatText, displayNameSkeleton } from './identitySafety.js';
import { migrateRoomState, roomExpiresAt, roomHasExpired, ROOM_SCHEMA_VERSION } from './roomPersistence.js';
// HOLLOW_STAGE_4_5_IN_PERSON_NIGHT_FLOW: the server owns every In-Person phase transition.
// HOLLOW_STAGE_8_UNDERTAKER_ROLE: a private, one-use identity transfer shared by both game modes.
import {
  IN_PERSON_NIGHT_STEP_SECONDS,
  IN_PERSON_NIGHT_STEP_MINIMUM_SECONDS,
  IN_PERSON_VOTE_SECONDS,
  getInPersonDiscussionSeconds,
  getInPersonMafiaDecision,
  getInPersonMafiaStepOutcome,
  getInPersonNextNightStep,
  getInPersonActionCompletionDeadline,
  allConnectedPlayersReady,
} from './inPersonRules.js';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  UNDERTAKER_MAX_PER_GAME,
  getUndertakerCandidates,
  canUndertakerAct,
  resolveUndertakerChoice,
  toUndertakerPrivateOptions,
  isRoleActive,
  hasPendingMafiaInheritance,
} from './undertakerRules.js';
import {
  getDiscussionSeconds,
  getMafiaCap,
  resolveVote,
  getWinner,
  getNightActionProgress,
  allPlayersVoted,
  allPlayersReady,
  canTargetSelf,
  isMafiaFactionMember,
} from './rules.js';
import {
  createBooleanReadinessCache,
  createNonOverlappingTask,
  createTokenBucket,
  runRoomBatchSafely,
  shiftRestoredRoomTimers,
  reconcileNarratorClockPause,
} from './runtimeSafety.js';
import { prepareRoomRematch } from './rematchRules.js';

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
  // Game events are small JSON payloads. A 16 KB ceiling limits oversized packets.
  maxHttpBufferSize: 16 * 1024,
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'https:', 'wss:'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      workerSrc: ["'self'", 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'The Hollow Table', time: Date.now() }));

const rooms = new Map();
const socketByPlayer = new Map();
const joinAttempts = new Map();
const chatAttempts = new Map();
const pendingRoomSaves = new Map();
let pool = null;
let livekitRoomService = null;
let lastDatabaseHeartbeatAt = 0;
let roomTickTimer = null;
let activeRoomTickPromise = null;
let shuttingDown = false;
const ROOM_SAVE_DEBOUNCE_MS = 350;
const ROOM_SAVE_RETRY_MS = 2_000;
const DATABASE_HEARTBEAT_INTERVAL_MS = 10_000;
const SOCKET_EVENT_RATE = Math.max(1, Number(process.env.SOCKET_EVENT_RATE) || 15);
const SOCKET_EVENT_BURST = Math.max(SOCKET_EVENT_RATE, Number(process.env.SOCKET_EVENT_BURST) || 30);

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
const IN_PERSON_PHASE_MINIMUM_SECONDS = Object.freeze({ discussion: 9, voting: 9, tieVoting: 9 });
const IN_PERSON_TRANSITION_MINIMUM_MS = Object.freeze({ murder: 12_000, quiet: 10_000, elimination: 13_200, tie: 11_000, 'no-elimination': 11_000 });
// HOLLOW_STAGE_6_NARRATOR_AUDIO: the In-Person mode is enabled only when the complete approved voice pack is present.
const NARRATOR_VOICE_ID = 'bvopWwMi3nfE38bLXN5w';
const REQUIRED_NARRATION_CLIPS = [
  'narrator_test', 'role_reveal', 'town_sleep', 'mafia_awaken', 'mafia_clash',
  'mafia_sleep', 'angel_awaken', 'angel_sleep', 'sheriff_awaken', 'sheriff_sleep',
  'undertaker_awaken', 'town_wake', 'day_discussion', 'voting_begins', 'tie_announcement', 'tie_voting',
  'murder_report', 'quiet_report', 'elimination_report', 'no_elimination',
  'departure_report', 'mafia_victory', 'town_victory',
];

function inspectInPersonVoicePack() {
  const audioDir = path.resolve(__dirname, '../client/public/audio');
  try {
    const pack = JSON.parse(readFileSync(path.join(audioDir, 'pack-manifest.json'), 'utf8'));
    if (pack.voiceId !== NARRATOR_VOICE_ID || pack.complete !== true) return false;
    return REQUIRED_NARRATION_CLIPS.every((clipId) => {
      const clip = pack.clips?.[clipId];
      if (!clip || clip.file !== `${clipId}.mp3`) return false;
      const filePath = path.join(audioDir, clip.file);
      return existsSync(filePath) && statSync(filePath).size > 2048;
    });
  } catch {
    return false;
  }
}

// H6: check the shipped voice pack once at startup, not synchronously for every player snapshot.
const narratorVoicePackReadiness = createBooleanReadinessCache(inspectInPersonVoicePack);
function isInPersonVoicePackReady() {
  return narratorVoicePackReadiness.read();
}

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
    // One private decision per night; never included in public room snapshots.
    undertakerDecision: null,
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

function syncNarratorClockPause(room, now = Date.now()) {
  const narrator = room?.gameMode === 'in_person' ? playerById(room, room.narratorId) : null;
  const ready = Boolean(narrator?.connected && room.narratorReadyId === narrator.id);
  return reconcileNarratorClockPause(room, ready, now);
}

function livingPlayers(room) {
  return room.players.filter((player) => player.alive);
}

function roleIsActive(player, room) {
  return isRoleActive(player, room.round);
}

function undertakerCandidates(room) {
  return getUndertakerCandidates(room.players);
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
  // This is the only public Undertaker cue. There is deliberately no public
  // follow-up announcing acceptance, a selected identity, or whether the power was used.
  undertaker: ['UNDERTAKER, AWAKEN', 'Undertaker, awaken. The house has one more secret to keep.', 'gold'],
  town_wake: ['TOWN, OPEN YOUR EYES', 'The house has finished its work. Dawn is breaking.', 'red'],
};

function enterInPersonNightStep(room, step, durationSeconds = IN_PERSON_NIGHT_STEP_SECONDS[step]) {
  if (room.status !== 'playing' || room.phase !== 'night') return false;
  const cue = IN_PERSON_NIGHT_CUES[step];
  if (!cue) throw new Error(`Unknown In-Person night step: ${step}`);
  room.nightStep = step;
  room.nightStepId = randomUUID();
  const now = Date.now();
  const narrationHoldSeconds = IN_PERSON_NIGHT_STEP_MINIMUM_SECONDS[step] ?? 0;
  room.nightStepMinUntil = now + narrationHoldSeconds * 1000;
  room.phaseEndsAt = now + (Math.max(0, durationSeconds) + narrationHoldSeconds) * 1000;
  room.nightCue = makeAnnouncement('night-step', cue[0], cue[1], cue[2], { step, cueId: room.nightStepId });
  room.announcement = null;
  return true;
}

function livingConnectedMafia(room) {
  return room.players.filter((entry) => entry.alive && entry.connected && entry.role === 'mafia' && roleIsActive(entry, room));
}

function inPersonMafiaDecision(room) {
  const livingMafia = room.players.filter((entry) => entry.alive && entry.role === 'mafia' && roleIsActive(entry, room));
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

function shortenConfirmedRoleActionWindow(room, actionDelaySeconds) {
  if (room.gameMode !== 'in_person' || room.phase !== 'night' || !room.phaseEndsAt) return;
  room.phaseEndsAt = getInPersonActionCompletionDeadline({
    now: Date.now(),
    minimumUntil: room.nightStepMinUntil,
    actionDelaySeconds,
    currentDeadline: room.phaseEndsAt,
  });
}

function beginMafiaSleep(room, targetId = null) {
  room.inPersonMafiaTargetId = targetId && playerById(room, targetId)?.alive ? targetId : null;
  enterInPersonNightStep(room, 'mafia_sleep');
}

function progressInPersonMafia(room, { timedOut = false } = {}) {
  if (room.status !== 'playing' || room.phase !== 'night' || !['mafia', 'mafia_clash'].includes(room.nightStep)) return false;
  if (!timedOut && room.nightStepMinUntil && Date.now() < room.nightStepMinUntil) return false;
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
    if (allConnectedPlayersReady(connectedLivingIds, room.identityReady) && (!room.nightStepMinUntil || Date.now() >= room.nightStepMinUntil)) {
      enterInPersonNightStep(room, 'town_sleep');
      return true;
    }
    return false;
  }
  if (room.nightStep === 'mafia' || room.nightStep === 'mafia_clash') {
    return progressInPersonMafia(room);
  }
  // Angel, Sheriff and Undertaker windows always run to their fixed deadline.
  // This keeps public cue order and timing identical whether a role is absent,
  // dead, disconnected, has no eligible target, or has already used its power.
  return false;
}

function advanceInPersonNightStep(room, { timedOut = false } = {}) {
  if (room.status !== 'playing' || room.phase !== 'night') return false;
  switch (room.nightStep) {
    case 'role_reveal':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep, { round: room.round }));
      return true;
    case 'town_sleep': {
      const nextStep = getInPersonNextNightStep(room.nightStep, { round: room.round, hasConnectedMafia: livingConnectedMafia(room).length > 0 });
      if (nextStep === 'mafia_sleep') beginMafiaSleep(room);
      else enterInPersonNightStep(room, nextStep);
      return true;
    }
    case 'mafia':
    case 'mafia_clash':
      return progressInPersonMafia(room, { timedOut });
    case 'mafia_sleep':
    case 'angel':
    case 'angel_sleep':
    case 'sheriff':
    case 'sheriff_sleep':
    case 'undertaker':
      enterInPersonNightStep(room, getInPersonNextNightStep(room.nightStep, { round: room.round }));
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
    undertaker: 'Once per game, from Round 2 onward and when a previous player has fallen, privately inherit one departed player’s role. Their seat stays empty; you keep your own name and seat. The inherited role becomes active on the following night. Declining or timing out preserves your unused power.',
    citizen: 'Listen, discuss, and vote to find the Mafia.',
  };
  return descriptions[role] ?? '';
}


function makeSnapshot(room, playerId) {
  const me = playerById(room, playerId);
  if (!me) return null;
  const revealAll = room.status === 'finished';
  const narrator = room.gameMode === 'in_person' ? playerById(room, room.narratorId || room.hostId) : null;
  const meRoleActive = roleIsActive(me, room);
  const undertakerOptions = room.status === 'playing' && room.phase === 'night'
    && canUndertakerAct(me, room.round, undertakerCandidates(room), { phase: room.phase, nightStep: room.nightStep, gameMode: room.gameMode })
    ? toUndertakerPrivateOptions(undertakerCandidates(room)) : [];
  const mafiaTeam = me.role === 'mafia' && me.alive && meRoleActive
    ? room.players.filter((p) => p.role === 'mafia' && roleIsActive(p, room)).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, alive: p.alive }))
    : [];
  const myActionSubmitted = room.phase === 'night'
    ? (me.role === 'mafia' ? Boolean(room.actions.mafiaVotes[me.id])
      : me.role === 'sheriff' ? Boolean(room.actions.sheriffTarget)
        : me.role === 'angel' ? Boolean(room.actions.angelTarget)
          : me.role === 'undertaker' ? Boolean(room.actions.undertakerDecision) : false)
    : ['voting', 'tieVoting'].includes(room.phase) ? Object.hasOwn(room.actions.dayVotes, me.id) : false;
  const inPersonMafiaDecision = room.gameMode === 'in_person' && room.phase === 'night'
    ? inPersonMafiaDecisionSnapshot(room) : null;
  const chat = room.chat.filter((message) => message.scope === 'public' || (message.scope === 'mafia' && me.role === 'mafia' && me.alive && meRoleActive));
  const dayReady = room.actions.dayReady ?? {};
  const nightProgress = room.phase === 'night' ? getNightActionProgress(room) : null;
  const maySeeMafiaChoices = room.gameMode !== 'in_person' || ['mafia', 'mafia_clash'].includes(room.nightStep);
  const mafiaChoices = me.role === 'mafia' && me.alive && meRoleActive && maySeeMafiaChoices
    ? room.players.filter((player) => player.alive && player.role === 'mafia' && roleIsActive(player, room)).map((player) => {
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
    voicePackReady: room.gameMode === 'in_person' ? isInPersonVoicePackReady() : false,
    clockQuarantined: Boolean(room.clockQuarantined),
    narratorAudioReady: room.gameMode === 'in_person' && Boolean(narrator && room.narratorReadyId === narrator.id),
    narratorPaused: Boolean(room.narratorPausedAt),
    serverNow: Date.now(),
    status: room.status,
    hostId: room.hostId,
    settings: { ...room.settings, undertakerCount: room.settings.undertakerCount === 1 ? 1 : 0 },
    playerCount: room.players.length,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      alive: player.alive,
      connected: player.connected,
      reconnectDeadline: !player.connected && player.disconnectAt ? player.disconnectAt + RECONNECT_GRACE_MS : null,
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
      roleActive: meRoleActive,
      undertakerUsed: Boolean(me.undertakerUsed),
      undertakerOptions,
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
      ? me.role === 'mafia' && me.alive && meRoleActive ? (room.gameMode === 'in_person' ? {
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

function scheduleRoomSave(code, delayMs = ROOM_SAVE_DEBOUNCE_MS) {
  const entry = pendingRoomSaves.get(code);
  if (!entry || !pool) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flushRoomSave(code);
  }, delayMs);
  entry.timer.unref?.();
}

async function flushRoomSave(code) {
  const entry = pendingRoomSaves.get(code);
  if (!entry || !pool) return;
  if (entry.flushPromise) return entry.flushPromise;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.flushPromise = (async () => {
    while (entry.snapshot && pool) {
      const snapshot = entry.snapshot;
      entry.snapshot = null;
      const savedRoom = JSON.parse(snapshot);
      const expiresAt = roomExpiresAt(savedRoom);
      try {
        await pool.query(
          `INSERT INTO hollow_rooms (code, state, updated_at, expires_at)
           VALUES ($1, $2::jsonb, NOW(), $3)
           ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW(), expires_at = EXCLUDED.expires_at`,
          [code, snapshot, expiresAt],
        );
      } catch (err) {
        // Keep the newest snapshot queued and retry. A stale write must never win over a newer one.
        entry.snapshot = entry.snapshot ?? snapshot;
        console.error(`Could not persist room ${code}:`, err.message);
        break;
      }
    }
  })();

  try {
    await entry.flushPromise;
  } finally {
    entry.flushPromise = null;
  }

  if (entry.snapshot) scheduleRoomSave(code, ROOM_SAVE_RETRY_MS);
  else pendingRoomSaves.delete(code);
}

async function saveRoom(room) {
  if (!pool || !room) return;
  try {
    let entry = pendingRoomSaves.get(room.code);
    if (!entry) {
      entry = { snapshot: null, timer: null, flushPromise: null };
      pendingRoomSaves.set(room.code, entry);
    }
    // Trailing debounce coalesces bursts; a running flush serializes any newer snapshot after the current write.
    entry.snapshot = JSON.stringify({ ...room, schemaVersion: ROOM_SCHEMA_VERSION });
    scheduleRoomSave(room.code);
  } catch (err) {
    console.error(`Could not queue room ${room.code} for persistence:`, err.message);
  }
}

async function flushAllRoomSaves() {
  const codes = [...pendingRoomSaves.keys()];
  await Promise.all(codes.map(async (code) => {
    const entry = pendingRoomSaves.get(code);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await flushRoomSave(code);
  }));
}

async function deleteRoom(code) {
  const room = rooms.get(code);
  if (room) {
    for (const player of room.players) {
      const socketId = socketByPlayer.get(player.id);
      const activeSocket = socketId ? io.sockets.sockets.get(socketId) : null;
      if (activeSocket?.data?.code === code) {
        activeSocket.data.code = null;
        activeSocket.data.playerId = null;
        activeSocket.emit('session:kicked', { reason: 'This table has expired. Return to the entrance to join or create another table.' });
      }
      socketByPlayer.delete(player.id);
      chatAttempts.delete(player.id);
    }
  }
  rooms.delete(code);
  const entry = pendingRoomSaves.get(code);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.snapshot = null;
    if (entry.flushPromise) await entry.flushPromise;
    pendingRoomSaves.delete(code);
  }
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
  // M2: validate the server certificate by default. Local development can opt
  // out with DATABASE_SSL=disable; a provider CA can be supplied when required.
  pool = new Pool({ ...getDatabaseConnectionOptions(), max: 5 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hollow_rooms (
      code CHAR(4) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hollow_rooms_expires_at_idx ON hollow_rooms (expires_at);
  `);
  const { rows } = await pool.query('SELECT state, updated_at FROM hollow_rooms WHERE expires_at > NOW()');
  for (const row of rows) {
    const room = migrateRoomState(row.state);
    if (!room || !room.code || !Array.isArray(room.players)) continue;
    room.matchId ??= randomUUID();
    const restoredAt = Date.now();
    const downtimeMs = shiftRestoredRoomTimers(room, row.updated_at, restoredAt);
    if (downtimeMs > 0) {
      console.log(`Restored table ${room.code} with ${Math.round(downtimeMs / 1000)}s of paused downtime.`);
    }
    // HOLLOW_STAGE_2_MODE_SELECTION: rooms saved before this update remain Online.
    room.gameMode = room.gameMode === 'in_person' ? 'in_person' : 'online';
    room.narratorId = room.gameMode === 'in_person'
      ? (playerById(room, room.narratorId) ? room.narratorId : room.hostId)
      : null;
    room.narratorReadyId = null;
    room.narratorPausedAt = room.status === 'playing' && room.gameMode === 'in_person' ? restoredAt : null;
    room.actions ??= freshActions();
    room.actions.undertakerDecision ??= null;
    room.settings ??= {};
    room.settings.undertakerCount = room.settings.undertakerCount === 1 ? 1 : 0;
    for (const player of room.players) { player.undertakerUsed = Boolean(player.undertakerUsed); }
    room.nightStep ??= null;
    room.nightCue ??= null;
    room.identityReady ??= {};
    room.inPersonMafiaTargetId ??= null;
    for (const player of room.players) { player.connected = false; player.disconnectAt = Date.now(); }
    // Give the original host a reconnect window after a server restart/deploy.
    // Without this, the first guest to resume can accidentally take host ownership.
    room.hostGraceUntil = restoredAt + RECONNECT_GRACE_MS;
    room.clockQuarantined = Boolean(room.clockQuarantined);
    rooms.set(room.code, room);
    // Persist the adjusted deadlines immediately so a second restart cannot shift them twice.
    await saveRoom(room);
  }
  await pool.query('DELETE FROM hollow_rooms WHERE expires_at <= NOW()');
  await flushAllRoomSaves();
  lastDatabaseHeartbeatAt = Date.now();
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
  if (room.gameMode === 'in_person' && room.narratorId === player.id) room.narratorReadyId = null;

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
    try {
      const snapshot = makeSnapshot(room, player.id);
      if (snapshot) io.to(socketId).emit('room:state', snapshot);
    } catch (err) {
      console.error(`Could not build snapshot for room ${room.code}, player ${player.id}:`, err);
    }
  }
}

async function commit(room) {
  syncNarratorClockPause(room);
  room.schemaVersion = ROOM_SCHEMA_VERSION;
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
  room.phaseMinUntil = room.gameMode === 'in_person' ? Date.now() + IN_PERSON_PHASE_MINIMUM_SECONDS.discussion * 1000 : null;
  const durationSeconds = room.gameMode === 'in_person'
    ? getInPersonDiscussionSeconds(livingPlayers(room).length)
    : getDiscussionSeconds(room.round);
  room.phaseEndsAt = Date.now() + (durationSeconds + (room.gameMode === 'in_person' ? IN_PERSON_PHASE_MINIMUM_SECONDS.discussion : 0)) * 1000;
  room.tieCandidates = [];
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
  room.transition = null;
  room.voteReveal = null;
  room.announcement = null;
  room.nightStep = null;
  room.nightCue = null;
  room.nightStepMinUntil = null;
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
  if (room.phase === 'discussion' && everyoneReady(room) && (!room.phaseMinUntil || Date.now() >= room.phaseMinUntil)) {
    beginVoting(room);
    return true;
  }
  if (room.phase === 'voting' && everyoneVoted(room) && (!room.phaseMinUntil || Date.now() >= room.phaseMinUntil)) {
    resolveDayVoting(room, false);
    return true;
  }
  if (room.phase === 'tieVoting' && everyoneVoted(room) && (!room.phaseMinUntil || Date.now() >= room.phaseMinUntil)) {
    resolveDayVoting(room, true);
    return true;
  }
  return false;
}

function reconcileDiscussionReadiness(room) {
  if (room.status !== 'playing' || room.phase !== 'discussion' || !everyoneReady(room)) return false;
  if (room.gameMode === 'in_person') return reconcileInPersonDayProgress(room);
  beginVoting(room);
  return true;
}

function beginVoting(room) {
  room.phase = 'voting';
  room.phaseMinUntil = room.gameMode === 'in_person' ? Date.now() + IN_PERSON_PHASE_MINIMUM_SECONDS.voting * 1000 : null;
  const durationSeconds = room.gameMode === 'in_person' ? IN_PERSON_VOTE_SECONDS : VOTE_SECONDS;
  room.phaseEndsAt = Date.now() + (durationSeconds + (room.gameMode === 'in_person' ? IN_PERSON_PHASE_MINIMUM_SECONDS.voting : 0)) * 1000;
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
  room.transition = null;
  room.voteReveal = null;
  room.nightStep = null;
  room.nightCue = null;
  room.nightStepMinUntil = null;
  room.announcement = makeAnnouncement('phase', 'THE VOTE BEGINS', 'Choose the name you believe is hiding in the dark. The vote is private.', 'gold');
}

function beginNextNight(room) {
  room.round += 1;
  // An inherited faction becomes active on this round's opening. Check parity
  // at activation, not at the earlier private inheritance choice.
  const activatedWinner = getWinner(room.players);
  if (activatedWinner) {
    finishGame(room, activatedWinner);
    return;
  }
  room.phase = 'night';
  room.phaseMinUntil = null;
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
  room.phaseMinUntil = null;
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
  const pendingMafiaInheritance = hasPendingMafiaInheritance(room.players, room.round);
  if (winner && !pendingMafiaInheritance) {
    finishGame(room, winner);
    return true;
  }
  if (winner && pendingMafiaInheritance) {
    // Defer a roster-triggered win while a private Mafia inheritance is waiting
    // for its next-round activation. End-of-night resolution handles the verdict.
    return false;
  }
  if (room.phase === 'transition' && room.transition?.pendingWinner) {
    room.transition.pendingWinner = null;
    room.transition.nextPhase = ['murder', 'quiet'].includes(room.transition.kind) ? 'discussion' : 'night';
  }
  return false;
}

function startTransition(room, kind, durationMs, nextPhase, pendingWinner = null) {
  const startedAt = Date.now();
  const effectiveDurationMs = room.gameMode === 'in_person'
    ? Math.max(durationMs, IN_PERSON_TRANSITION_MINIMUM_MS[kind] ?? durationMs)
    : durationMs;
  room.phase = 'transition';
  room.phaseMinUntil = null;
  room.phaseEndsAt = startedAt + effectiveDurationMs;
  room.nightStep = null;
  room.nightCue = null;
  room.transition = {
    id: randomUUID(),
    kind,
    startedAt,
    durationMs: effectiveDurationMs,
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
    room.phaseMinUntil = room.gameMode === 'in_person' ? Date.now() + IN_PERSON_PHASE_MINIMUM_SECONDS.tieVoting * 1000 : null;
    room.phaseEndsAt = Date.now() + ((room.gameMode === 'in_person' ? IN_PERSON_VOTE_SECONDS : TIE_SECONDS) + (room.gameMode === 'in_person' ? IN_PERSON_PHASE_MINIMUM_SECONDS.tieVoting : 0)) * 1000;
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
  const livingMafia = room.players.filter((player) => player.alive && player.role === 'mafia' && roleIsActive(player, room));
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
    const voiceRoom = `hollow-${room.code}-${room.matchId || 'legacy'}-${mode}-${room.round}`;
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
  player.eliminationKind = 'departure';
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
  target.eliminationKind = type === 'murder' ? 'murder' : 'vote';
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

async function quarantineRoomClock(room, err) {
  if (room.clockQuarantined) return;
  room.clockQuarantined = true;
  room.phaseEndsAt = null;
  room.phaseMinUntil = null;
  room.nightStepMinUntil = null;
  room.nightStep = null;
  room.nightCue = null;
  room.transition = null;
  room.announcement = makeAnnouncement(
    'system-error',
    'THE TABLE HAS BEEN SEALED',
    'A technical issue interrupted this table. This room has been paused to protect the game. Other tables are unaffected. Please create a new table.',
    'red',
  );
  room.lastActivityAt = Date.now();
  console.error(`Game clock quarantined room ${room.code}:`, err);
  try { emitRoom(room); }
  catch (emitError) { console.error(`Could not publish pause notice for room ${room.code}:`, emitError); }
  await saveRoom(room);
}

async function processRoomTick(room, now) {
  if (room.clockQuarantined) {
    if (roomHasExpired(room, now)) {
      await deleteRoom(room.code);
    }
    return;
  }
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
    return;
  }
  if (changed && room.status === 'playing') {
    if (reconcileAfterRosterChange(room)) {
      // A disconnect can change the faction balance; publish the final verdict.
    } else if (room.phase === 'discussion' && reconcileDiscussionReadiness(room)) {
      // Removing/forfeiting a seat can leave every remaining living player ready.
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

  if (room.status === 'playing' && room.gameMode === 'in_person') {
    const narratorPause = syncNarratorClockPause(room, now);
    if (narratorPause.changed) changed = true;
    if (room.narratorPausedAt) {
      if (roomHasExpired(room, now)) {
        await deleteRoom(room.code);
        return;
      }
      if (changed) await commit(room);
      return;
    }
  }

  if (room.status === 'playing' && room.gameMode === 'in_person' && room.phase === 'night') {
    if (room.nightStepMinUntil && now >= room.nightStepMinUntil && reconcileInPersonNightProgress(room)) changed = true;
    if (room.phase === 'night' && room.phaseEndsAt && now >= room.phaseEndsAt) {
      advanceInPersonNightStep(room, { timedOut: true });
      changed = true;
    }
  } else if (room.status === 'playing' && room.gameMode === 'in_person' && ['discussion', 'voting', 'tieVoting'].includes(room.phase)) {
    if (room.phaseMinUntil && now >= room.phaseMinUntil && reconcileInPersonDayProgress(room)) changed = true;
    if (!changed && room.phaseEndsAt && now >= room.phaseEndsAt) {
      if (room.phase === 'discussion') beginVoting(room);
      else if (room.phase === 'voting') resolveDayVoting(room, false);
      else if (room.phase === 'tieVoting') resolveDayVoting(room, true);
      changed = true;
    }
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

  if (roomHasExpired(room, now)) {
    await deleteRoom(room.code);
    return;
  }
  if (changed) await commit(room);
}

async function refreshDatabaseHeartbeat(now = Date.now()) {
  if (!pool || now - lastDatabaseHeartbeatAt < DATABASE_HEARTBEAT_INTERVAL_MS) return;
  lastDatabaseHeartbeatAt = now;
  try {
    // Never advance the checkpoint past a room snapshot that is still waiting to be saved.
    await flushAllRoomSaves();
    if (pendingRoomSaves.size > 0) {
      console.warn('Database heartbeat skipped because one or more room saves are still pending.');
      return;
    }
    // updated_at acts as a lightweight server checkpoint for timer restoration after a crash/redeploy.
    await pool.query('UPDATE hollow_rooms SET updated_at = NOW() WHERE expires_at > NOW()');
  } catch (err) {
    lastDatabaseHeartbeatAt = now;
    console.error('Database heartbeat failed:', err.message);
  }
}

const runRoomClockTick = createNonOverlappingTask(async () => {
  const now = Date.now();
  await runRoomBatchSafely(
    [...rooms.values()],
    (room) => processRoomTick(room, now),
    quarantineRoomClock,
  );
  await refreshDatabaseHeartbeat(now);
});

async function tickRooms() {
  if (shuttingDown || activeRoomTickPromise) return;
  const tickPromise = runRoomClockTick();
  activeRoomTickPromise = tickPromise;
  try {
    return await tickPromise;
  } finally {
    if (activeRoomTickPromise === tickPromise) activeRoomTickPromise = null;
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

// Expired limiter buckets are no longer useful; prune them without changing thresholds.
function pruneTransientState(now = Date.now()) {
  for (const [ip, entry] of joinAttempts) {
    if (!entry || now > entry.resetAt) joinAttempts.delete(ip);
  }
  for (const [playerId, entries] of chatAttempts) {
    const recent = entries.filter((time) => now - time < 5000);
    if (recent.length) chatAttempts.set(playerId, recent);
    else chatAttempts.delete(playerId);
  }
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
      if (context.room.clockQuarantined && callback !== 'room:leave') {
        return reply(ack, error('This table was paused after a technical issue. Please create a new table.'));
      }
      if (context.room.narratorPausedAt && ['identity:ready', 'night:act', 'night:undertaker', 'day:ready', 'day:vote'].includes(callback)) {
        return reply(ack, error('The game clock is paused until the narrator reconnects and enables the house voice.'));
      }
      const result = await handler(context.room, context.player, payload);
      reply(ack, result ?? success());
    } catch (err) {
      console.error(`Socket action ${callback} failed:`, err);
      reply(ack, error('Something went wrong. Please try again.'));
    }
  };
}

io.on('connection', (socket) => {
  // H5: an independent token bucket prevents one socket from flooding every room.
  const consumeEventToken = createTokenBucket({ capacity: SOCKET_EVENT_BURST, refillPerSecond: SOCKET_EVENT_RATE });
  socket.use(([eventName, ...args], next) => {
    if (consumeEventToken()) return next();
    const acknowledgement = args.at(-1);
    if (typeof acknowledgement === 'function') {
      reply(acknowledgement, error('Too many requests from this device. Please slow down.'));
    }
    next(new Error(`Socket event rate limit exceeded: ${String(eventName)}`));
  });
  socket.on('room:create', async (payload = {}, ack) => {
    try {
      if (socket.data.code && socket.data.playerId) return reply(ack, error('Leave your current table before creating another.'));
      const ip = socket.handshake.address || 'unknown';
      if (!ipAllowed(ip)) return reply(ack, error('Too many room attempts. Please wait a few minutes and try again.'));
      const name = cleanDisplayName(payload.name);
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
        schemaVersion: ROOM_SCHEMA_VERSION,
        narratorPausedAt: null,
        code,
        matchId: randomUUID(),
        gameMode,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'lobby',
        hostId: id,
        narratorId: gameMode === 'in_person' ? id : null,
        narratorReadyId: null,
        hostGraceUntil: null,
        settings: { maxPlayers, mafiaCount: Math.min(2, getMafiaCap(maxPlayers)), undertakerCount: 0 },
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
      const name = cleanDisplayName(payload.name);
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
      const nameKey = displayNameSkeleton(name);
      if (room.players.some((player) => displayNameSkeleton(player.name) === nameKey)) return reply(ack, error('That nickname is already taken at this table.'));
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
      if (socket.data.code || socket.data.playerId) return reply(ack, error('Leave your current table before restoring another seat.'));
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
    const undertakerCount = payload.undertakerCount === undefined
      ? (room.settings.undertakerCount === 1 ? 1 : 0)
      : Number(payload.undertakerCount);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 5 || maxPlayers > 16) return error('Player limit must be between 5 and 16.');
    if (maxPlayers < room.players.length) return error('Player limit cannot be lower than the number of people already seated.');
    if (!Number.isInteger(mafiaCount) || mafiaCount < 1 || mafiaCount > getMafiaCap(maxPlayers)) return error(`Mafia count must be between 1 and ${getMafiaCap(maxPlayers)} for this player limit.`);
    if (!Number.isInteger(undertakerCount) || undertakerCount < 0 || undertakerCount > UNDERTAKER_MAX_PER_GAME) return error('Undertaker count must be 0 or 1.');
    room.settings.maxPlayers = maxPlayers;
    room.settings.mafiaCount = mafiaCount;
    room.settings.undertakerCount = undertakerCount;
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
    room.narratorReadyId = null;
    await commit(room);
    return success({ narratorId: target.id });
  }));

  socket.on('narrator:audio-ready', withPlayer(socket, 'narrator:audio-ready', async (room, player) => {
    if (room.gameMode !== 'in_person') return error('Narrator audio is only used for In-Person gatherings.');
    if (room.narratorId !== player.id) return error('Only the assigned narrator device can enable public audio.');
    if (!isInPersonVoicePackReady()) return error('The complete narrator voice pack is not installed yet.');
    room.narratorReadyId = player.id;
    await commit(room);
    return success({ ready: true });
  }));

  socket.on('narrator:visibility', withPlayer(socket, 'narrator:visibility', async (room, player, payload) => {
    if (room.gameMode !== 'in_person' || room.status !== 'playing') return error('Narrator visibility is only tracked during an In-Person game.');
    if (room.narratorId !== player.id) return error('Only the assigned narrator device can update narrator visibility.');
    if (payload.visible === false) {
      room.narratorReadyId = null;
      await commit(room);
      return success({ paused: true, reenableRequired: true });
    }
    // Returning to the tab never auto-unlocks audio. The narrator must tap the
    // speaker test again so mobile browsers can resume audio after backgrounding.
    return success({ paused: Boolean(room.narratorPausedAt), reenableRequired: Boolean(room.narratorPausedAt) });
  }));

  socket.on('lobby:start', withPlayer(socket, 'lobby:start', async (room, player) => {
    if (room.status !== 'lobby') return error('This game has already started.');
    if (room.hostId !== player.id) return error('Only the host can start the game.');
    if (room.gameMode === 'in_person' && !isInPersonVoicePackReady()) {
      return error('The narrator audio pack is incomplete. Run the local narration generator before starting an In-Person game.');
    }
    if (room.players.length < 5) return error('At least five players are required to begin.');
    const mafiaCap = getMafiaCap(room.players.length);
    if (room.settings.mafiaCount > mafiaCap) return error(`With ${room.players.length} players, the maximum Mafia count is ${mafiaCap}.`);
    if (room.gameMode === 'in_person') {
      repairNarrator(room);
      const narrator = playerById(room, room.narratorId);
      if (!narrator?.connected) return error('Connect or assign a narrator phone before beginning the gathering.');
      if (room.narratorReadyId !== narrator.id) return error('The assigned narrator must tap ENABLE & TEST NARRATOR before the host can begin.');
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
    if (room.settings.undertakerCount === 1) {
      const undertaker = remaining.splice(randomBytes(2).readUInt16BE(0) % remaining.length, 1)[0];
      undertaker.role = 'undertaker';
      undertaker.undertakerUsed = false;
      undertaker.roleActiveFromRound = 1;
    }
    remaining.forEach((entry) => { entry.role = 'citizen'; });
    room.status = 'playing';
    room.round = 1;
    room.angelLastProtectedTargetId = null;
    room.players.forEach((entry) => { entry.undertakerUsed = false; entry.roleActiveFromRound = 1; entry.eliminationKind = null; });
    room.phase = 'night';
    room.phaseMinUntil = null;
    room.actions = freshActions();
    room.tieCandidates = [];
    room.transition = null;
    room.voteReveal = null;
    room.mafiaConflictExtensionUsed = false;
    room.inPersonMafiaTargetId = null;
    room.nightStep = null;
    room.nightCue = null;
    room.nightStepMinUntil = null;
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
    if (!roleIsActive(player, room)) return error('Your inherited role becomes active on the next night.');
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
        shortenConfirmedRoleActionWindow(room, 2);
        reconcileInPersonNightProgress(room);
      } else if (player.role === 'sheriff') {
        if (room.nightStep !== 'sheriff') return error('The Sheriff is not being summoned right now.');
        if (room.actions.sheriffTarget) return error('Your investigation is already locked for this night.');
        if (target.id === player.id) return error('You cannot investigate yourself.');
        room.actions.sheriffTarget = target.id;
        const isMafia = isMafiaFactionMember(target);
        addPrivateResult(
          player,
          `${target.name} is ${isMafia ? 'MAFIA' : 'NOT MAFIA'}.`,
          isMafia ? 'danger' : 'success',
          { targetName: target.name, targetAvatar: target.avatar },
        );
        shortenConfirmedRoleActionWindow(room, 5);
        reconcileInPersonNightProgress(room);
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
      const isMafia = isMafiaFactionMember(target);
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

  // Keep the public Undertaker deadline fixed: shortening it after a private choice
  // would let other players infer whether the one-use power was available or used.
  socket.on('night:undertaker', withPlayer(socket, 'night:undertaker', async (room, player, payload) => {
    if (room.status !== 'playing' || room.phase !== 'night') return error('The night has ended.');
    if (room.phaseEndsAt && Date.now() >= room.phaseEndsAt) return error('The Undertaker window has closed.');
    if (!player.alive) return error('The fallen cannot inherit an identity.');
    if (player.role !== 'undertaker' || player.undertakerUsed) return error('Your one-time inheritance is not available.');
    if (!roleIsActive(player, room)) return error('Your role is not active yet.');
    if (room.gameMode === 'in_person' && room.nightStep !== 'undertaker') return error('The Undertaker has not been summoned.');
    if (room.round < 2) return error('The graveyard opens after the first round.');
    if (room.actions.undertakerDecision) return error('Your decision for this night is already sealed.');

    const candidates = undertakerCandidates(room);
    if (payload.decline === true) {
      room.actions.undertakerDecision = 'declined';
      await commit(room);
      return success({ declined: true, powerPreserved: true });
    }

    const target = candidates.find((entry) => entry.id === String(payload.targetId || ''));
    if (!target) return error('That identity is no longer available in the graveyard.');
    const result = resolveUndertakerChoice(player, target, room.round);
    if (!result.ok) return error('That identity cannot be inherited.');

    // Commit the inherited faction/role immediately for parity checks, but gate
    // every copied night ability until the following round.
    player.role = result.inheritedRole;
    player.undertakerUsed = true;
    player.roleActiveFromRound = result.activeFromRound;
    room.actions.undertakerDecision = { targetId: target.id, inheritedRole: result.inheritedRole };
    addPrivateResult(
      player,
      `You inherited the ${result.inheritedRole.toUpperCase()} identity of ${target.name}. Your new role becomes active next night.`,
      result.inheritedRole === 'mafia' ? 'danger' : 'success',
      { targetName: target.name, targetAvatar: target.avatar, inheritedRole: result.inheritedRole, undertakerTransfer: true },
    );
    // Do not end the game at the moment of inheritance: the converted role is
    // privately revealed only to this player, and victory is evaluated at the
    // normal end-of-night resolution in both modes. This avoids a public timing
    // signal and preserves the full In-Person cue sequence through town wake.
    await commit(room);
    return success({ inherited: true, activeFromRound: result.activeFromRound });
  }));

  socket.on('day:ready', withPlayer(socket, 'day:ready', async (room, player) => {
    if (room.status !== 'playing' || room.phase !== 'discussion') return error('The discussion phase is closed.');
    if (!player.alive) return error('Ghosts cannot ready the vote.');
    room.actions.dayReady ??= {};
    // Explicit desired state makes retries idempotent. The no-payload fallback
    // preserves compatibility with clients that still send the older toggle.
    const ready = typeof payload.ready === 'boolean'
      ? payload.ready
      : !Boolean(room.actions.dayReady[player.id]);
    if (ready) room.actions.dayReady[player.id] = true;
    else delete room.actions.dayReady[player.id];
    const living = votingPlayers(room);
    const readyCount = living.filter((member) => room.actions.dayReady[member.id]).length;
    const started = reconcileDiscussionReadiness(room);
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

  socket.on('game:rematch', withPlayer(socket, 'game:rematch', async (room, host) => {
    if (room.status !== 'finished') return error('A rematch is available only after the final verdict.');
    if (room.hostId !== host.id) return error('Only the host can begin a rematch.');
    const previousPlayers = [...room.players];
    const connectedIds = previousPlayers
      .filter((player) => player.connected && socketByPlayer.has(player.id))
      .filter((player) => io.sockets.sockets.has(socketByPlayer.get(player.id)))
      .map((player) => player.id);
    const result = prepareRoomRematch(room, connectedIds, { freshActions, makeAnnouncement });
    if (!result.ok) {
      if (result.reason === 'not-enough-players') return error(`A rematch needs at least five connected players. Only ${result.available} are still here.`);
      return error('This table is not ready for a rematch.');
    }
    room.matchId = randomUUID();
    const retainedIds = new Set(room.players.map((player) => player.id));
    for (const player of previousPlayers) {
      if (!retainedIds.has(player.id)) {
        socketByPlayer.delete(player.id);
        chatAttempts.delete(player.id);
      }
    }
    await commit(room);
    return success({ retainedCount: result.retainedCount });
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
      if (!wonByRosterChange && room.phase === 'discussion') reconcileDiscussionReadiness(room);
      if (!wonByRosterChange && room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
        startTransition(room, 'no-elimination', NO_ELIMINATION_TRANSITION_MS, 'night');
      } else if (!wonByRosterChange && ['voting', 'tieVoting'].includes(room.phase) && everyoneVoted(room)) {
        resolveDayVoting(room, room.phase === 'tieVoting');
      }
    }

    if (room.gameMode === 'in_person' && room.narratorId === target.id) {
      room.narratorReadyId = null;
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
    const text = cleanChatText(payload.text);
    if (!text) return error('Write a message before sending.');
    if (!chatAllowed(player.id)) return error('Slow down. The house is listening.');
    let scope = 'public';
    if (room.phase === 'night') {
      if (player.role !== 'mafia' || !roleIsActive(player, room)) return error('The town is silent during the night.');
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
      if (room.gameMode === 'in_person' && room.narratorId === player.id) { room.narratorReadyId = null; room.narratorId = null; repairNarrator(room, true); }
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
      if (room.gameMode === 'in_person' && room.narratorId === player.id) { room.narratorReadyId = null; room.narratorId = null; repairNarrator(room, true); }
      if (reconcileAfterRosterChange(room)) {
        // The departure itself may decide the game.
      } else if (room.phase === 'discussion' && reconcileDiscussionReadiness(room)) {
        // All remaining living players had already confirmed they were ready.
      } else if (room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
        startTransition(room, 'no-elimination', NO_ELIMINATION_TRANSITION_MS, 'night');
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
    if (room.gameMode === 'in_person' && room.narratorId === player.id) { room.narratorReadyId = null; repairNarrator(room, true); }
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
      || (room.phase === 'night' && player.role === 'mafia' && roleIsActive(player, room));
    if (!allowedPhase) return res.status(403).json({ error: 'Voice chat is closed during this phase.' });
    const voiceRoom = room.phase === 'night'
      ? `hollow-${room.code}-${room.matchId || 'legacy'}-night-${room.round}`
      : `hollow-${room.code}-${room.matchId || 'legacy'}-day-${room.round}`;
    const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: player.id,
      name: player.name,
      ttl: '15m',
    });
    accessToken.addGrant({
      roomJoin: true,
      room: voiceRoom,
      canPublish: true,
      canPublishSources: ['microphone'],
      canPublishData: false,
      canSubscribe: true,
    });
    const jwt = await accessToken.toJwt();
    res.json({ token: jwt, serverUrl: process.env.LIVEKIT_URL, room: voiceRoom });
  } catch (err) {
    console.error('LiveKit token error:', err);
    res.status(500).json({ error: 'Could not start voice chat.' });
  }
});

// API misses return JSON, never the React application shell.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

if (isProduction) {
  const distPath = path.resolve(__dirname, '../client/dist');
  app.use(express.static(distPath, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Saving active tables before shutdown.`);
  if (roomTickTimer) clearInterval(roomTickTimer);
  // Do not snapshot rooms while a previously-started tick is still mutating them.
  if (activeRoomTickPromise) await activeRoomTickPromise;

  const now = Date.now();
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (!player.connected) continue;
      player.connected = false;
      player.disconnectAt = now;
      if (room.hostId === player.id) room.hostGraceUntil = now + RECONNECT_GRACE_MS;
      if (room.gameMode === 'in_person' && room.narratorId === player.id) room.narratorReadyId = null;
    }
    await saveRoom(room);
  }

  await new Promise((resolve) => io.close(resolve));
  await flushAllRoomSaves();
  if (pool) await pool.end();
  console.log('Active table saves flushed. Shutdown complete.');
}

process.once('SIGTERM', () => {
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown exceeded 12 seconds. Forcing process exit.');
    process.exit(1);
  }, 12_000);
  forceExit.unref();
  gracefulShutdown('SIGTERM').then(() => {
    clearTimeout(forceExit);
    process.exitCode = 0;
  }).catch((err) => {
    clearTimeout(forceExit);
    console.error('Graceful shutdown failed:', err);
    process.exitCode = 1;
  });
});

process.once('SIGINT', () => {
  const forceExit = setTimeout(() => process.exit(1), 12_000);
  forceExit.unref();
  gracefulShutdown('SIGINT').then(() => {
    clearTimeout(forceExit);
    process.exitCode = 0;
  }).catch((err) => {
    clearTimeout(forceExit);
    console.error('Graceful shutdown failed:', err);
    process.exitCode = 1;
  });
});

await initializeDatabase();
narratorVoicePackReadiness.refresh();
roomTickTimer = setInterval(() => { tickRooms().catch((err) => console.error('Game clock error:', err)); }, 500);
const transientStatePruner = setInterval(() => pruneTransientState(), 60_000);
transientStatePruner.unref?.();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Hollow Table server is listening on port ${PORT}`);
});
