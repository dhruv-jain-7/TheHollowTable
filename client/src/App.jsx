import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request, socket } from './socket.js';
import ExperienceTutorial from './components/ExperienceTutorial.jsx';
import { getNarrationCue } from './audio/narration.js';

const VoiceRoom = lazy(() => import('./components/VoiceRoom.jsx'));
const InviteTools = lazy(() => import('./components/InviteTools.jsx'));

// HOLLOW_STAGE_6_NARRATOR_AUDIO: one unlocked narrator device plays the shared static voice pack.
// HOLLOW_STAGE_8_UNDERTAKER_ROLE: private one-use inheritance and the in-game role guide.

const AVATARS = [
  { id: 'raven', face: '🐦‍⬛', label: 'Raven' },
  { id: 'skull', face: '💀', label: 'Skull' },
  { id: 'ghost', face: '👻', label: 'Ghost' },
  { id: 'bat', face: '🦇', label: 'Bat' },
  { id: 'wolf', face: '🐺', label: 'Wolf' },
  { id: 'cat', face: '🐈‍⬛', label: 'Black cat' },
  { id: 'owl', face: '🦉', label: 'Owl' },
  { id: 'spider', face: '🕷️', label: 'Spider' },
  { id: 'moth', face: '🦋', label: 'Moth' },
  { id: 'snake', face: '🐍', label: 'Serpent' },
  { id: 'candle', face: '🕯️', label: 'Candle' },
  { id: 'rose', face: '🥀', label: 'Withered rose' },
  { id: 'moon', face: '🌘', label: 'Eclipse' },
  { id: 'pumpkin', face: '🎃', label: 'Lantern' },
  { id: 'key', face: '🗝️', label: 'Old key' },
  { id: 'crow', face: '🐦', label: 'Crow' },
  { id: 'coffin', face: '⚰️', label: 'Coffin' },
  { id: 'crystal', face: '🔮', label: 'Oracle' },
  { id: 'mask', face: '🎭', label: 'Masquerade' },
  { id: 'poison', face: '⚗️', label: 'Alchemist' },
  { id: 'blackheart', face: '🖤', label: 'Black heart' },
  { id: 'eye', face: '👁️', label: 'Watcher' },
  { id: 'rose2', face: '🌹', label: 'Dark rose' },
  { id: 'moon2', face: '🌑', label: 'New moon' },
];

const ROLE_NAMES = { mafia: 'Mafia', sheriff: 'Sheriff', angel: 'Angel', undertaker: 'Undertaker', citizen: 'Citizen' };

function roleCardFor(role, mafiaIndex = 0) {
  if (role === 'mafia') {
    const clubs = mafiaIndex % 2 === 1;
    return { rank: 'A', suit: clubs ? '♣' : '♠', suitName: clubs ? 'CLUBS' : 'SPADES', roleName: 'MAFIA', art: '☠', className: 'mafia', motto: 'THE HOUSE HAS TEETH' };
  }
  if (role === 'sheriff') return { rank: 'A', suit: '♦', suitName: 'DIAMONDS', roleName: 'SHERIFF', art: '⚖', className: 'sheriff', motto: 'KEEP THE LIGHT ALIVE' };
  if (role === 'angel') return { rank: 'A', suit: '♥', suitName: 'HEARTS', roleName: 'ANGEL', art: '✧', className: 'angel', motto: 'ONE SOUL MAY BE SPARED' };
  if (role === 'undertaker') return { rank: 'Q', suit: '♠', suitName: 'SPADES', roleName: 'UNDERTAKER', art: '⚰', className: 'undertaker', motto: 'THE GRAVE REMEMBERS' };
  return { rank: '7', suit: '♦', suitName: 'DIAMONDS', roleName: 'CITIZEN', art: '🕯', className: 'citizen', motto: 'FIND THE HIDDEN HAND' };
}

function avatarFor(id) {
  return AVATARS.find((avatar) => avatar.id === id) ?? AVATARS[0];
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

// HOLLOW_STAGE_4_5_IN_PERSON_NIGHT_FLOW: render the sequential In-Person night without changing Online presentation.
function phaseTitle(snapshot) {
  if (snapshot.status === 'lobby') return 'THE GUESTS ARE GATHERING';
  if (snapshot.phase === 'night' && snapshot.gameMode === 'in_person') {
    const labels = { role_reveal: 'SEAL YOUR IDENTITY', town_sleep: 'THE TOWN MUST SLEEP', mafia: 'THE MAFIA AWAKENS', mafia_clash: 'CLASH OF OPINIONS', mafia_sleep: 'THE MAFIA RETURNS TO DARKNESS', angel: 'THE ANGEL AWAKENS', angel_sleep: 'THE HOUSE FALLS QUIET', sheriff: 'THE SHERIFF AWAKENS', sheriff_sleep: 'THE LAST SECRET IS SEALED', undertaker: 'THE GRAVE OPENS', town_wake: 'DAWN APPROACHES' };
    return `NIGHT ${snapshot.round} · ${labels[snapshot.nightStep] || 'THE MURDER HOUR'}`;
  }
  if (snapshot.phase === 'night') return `NIGHT ${snapshot.round} · THE MURDER HOUR`;
  if (snapshot.phase === 'discussion') return `DAY ${snapshot.round} · OPEN DISCUSSION`;
  if (snapshot.phase === 'voting') return `DAY ${snapshot.round} · ELIMINATION VOTE`;
  if (snapshot.phase === 'tieVoting') return `DAY ${snapshot.round} · THE TIE-BREAK`;
  if (snapshot.phase === 'transition') return 'THE HOUSE HOLDS ITS BREATH';
  return 'THE GAME IS OVER';
}

function phaseDescription(snapshot) {
  if (snapshot.phase === 'night' && snapshot.gameMode === 'in_person') {
    const descriptions = {
      role_reveal: 'Read your identity in private. The night begins as soon as everyone connected has entered, or when the short reveal window closes.',
      town_sleep: 'Everyone close your eyes. The house is preparing its first call.',
      mafia: 'Only the living Mafias may act. Choose a living target; every connected Mafia must agree before the night can continue.',
      mafia_clash: 'The Mafia choices are divided. Change your target before the final 15 seconds expire; a lasting disagreement means no murder.',
      mafia_sleep: 'The Mafia decision is sealed. All phones remain silent while the next role is summoned.',
      angel: 'Only the Angel may act. Confirm one living soul to protect; the choice locks immediately.',
      angel_sleep: 'The protection is sealed. Keep your eyes closed.',
      sheriff: 'Only the Sheriff may act. Investigate one living player; the result is private to this phone.',
      sheriff_sleep: 'The investigation is sealed. Keep your eyes closed until the final call.',
      undertaker: 'The same call is made every night. Only the living Undertaker with an unused power and an eligible graveyard choice can act. No public result follows this call.',
      town_wake: 'The night is complete. The house is bringing everyone back to the table.',
    };
    return descriptions[snapshot.nightStep] || 'The house is silent. Keep your eyes closed.';
  }
  if (snapshot.phase === 'night') return 'The house is silent. Choose your action in secret.';
  if (snapshot.phase === 'discussion') return snapshot.gameMode === 'in_person'
    ? 'Speak across the physical table. Voting opens as soon as every connected living player is ready, or when the discussion clock expires.'
    : 'Speak carefully. Voting opens as soon as every living player is ready, or when the discussion clock expires.';
  if (snapshot.phase === 'voting') return snapshot.gameMode === 'in_person'
    ? 'You have up to 30 seconds. Voting closes as soon as every connected living player has submitted a choice.'
    : 'You have up to 100 seconds. Voting closes as soon as every living player has submitted a choice.';
  if (snapshot.phase === 'tieVoting') return snapshot.gameMode === 'in_person'
    ? 'The vote is tied. You have up to 30 seconds to choose between the remaining accused.'
    : 'The vote is tied. You have up to 100 seconds to choose between the remaining accused.';
  if (snapshot.phase === 'transition') return 'The house is deciding what happens next.';
  if (snapshot.phase === 'finished') return snapshot.winner === 'mafia' ? 'The Mafia own the house.' : 'The town has survived.';
  return '';
}

function RolePlayingCard({ card, faceUp = true, onFlip, compact = false }) {
  const Tag = onFlip ? 'button' : 'div';
  return (
    <Tag
      type={onFlip ? 'button' : undefined}
      className={`identity-card ${compact ? 'identity-card-compact' : ''} ${faceUp ? 'identity-card-faceup' : 'identity-card-facedown'} identity-card-${card.className}`}
      onClick={onFlip}
      aria-label={onFlip ? 'Flip your identity card to reveal your role' : `${card.rank} of ${card.suitName}, ${card.roleName}`}
    >
      <span className="identity-card-inner">
        <span className="identity-card-back">
          <span className="card-back-corner">✦</span>
          <span className="card-back-sigil">☾</span>
          <strong>THE HOLLOW<br />TABLE</strong>
          <span className="card-back-rule" />
          <small>YOUR FATE IS SEALED</small>
          <span className="card-back-corner card-back-corner-bottom">✦</span>
        </span>
        <span className="identity-card-front">
          <span className="card-corner card-corner-top"><b>{card.rank}</b><i>{card.suit}</i></span>
          <span className="card-suit-watermark">{card.suit}</span>
          <span className="card-art" aria-hidden="true">{card.art}</span>
          <span className="card-face-title">{card.roleName}</span>
          <span className="card-face-subtitle">{card.rank} OF {card.suitName}</span>
          <span className="card-face-motto">{card.motto}</span>
          <span className="card-corner card-corner-bottom"><b>{card.rank}</b><i>{card.suit}</i></span>
        </span>
      </span>
    </Tag>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const latestSnapshotRef = useRef(snapshot);
  latestSnapshotRef.current = snapshot;
  const [session, setSession] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('hollow-table-session') || 'null'); }
    catch { return null; }
  });
  const [screen, setScreen] = useState('landing');
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('raven');
  const [joinCode, setJoinCode] = useState(() => (new URLSearchParams(window.location.search).get('code') || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 4));
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [mafiaCount, setMafiaCount] = useState(2);
  // HOLLOW_STAGE_2_MODE_SELECTION: the selected mode is saved on the server with the room.
  const [gameMode, setGameMode] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'in_person' ? 'in_person' : 'online');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [messageText, setMessageText] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => { try { return localStorage.getItem('hollow-tutorial-seen') !== 'yes'; } catch { return false; } });
  const [hapticsEnabled, setHapticsEnabled] = useState(() => { try { return localStorage.getItem('hollow-haptics') !== 'off'; } catch { return true; } });
  const [narratorVolume, setNarratorVolume] = useState(() => { try { const stored = localStorage.getItem('hollow-narrator-volume'); if (stored === null) return 1; const value = Number(stored); return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1; } catch { return 1; } });
  const [installPrompt, setInstallPrompt] = useState(null);
  const chatEndRef = useRef(null);
  const lastResumeKey = useRef('');
  const lastPhaseKey = useRef('');
  const lastHapticKey = useRef('');
  // HOLLOW_STAGE_3_IN_PERSON_LOBBY: keep the narrator's unlocked audio context alive across lobby renders.
  const narratorAudioContextRef = useRef(null);
  const narratorAudioElementRef = useRef(null);
  const narratorAudioSourceRef = useRef(null);
  const narratorAudioGainRef = useRef(null);
  const narratorAudioCompressorRef = useRef(null);
  const narrationUnlockedRef = useRef(false);
  const lastNarratorIdRef = useRef('');
  const [narrationUnlocked, setNarrationUnlocked] = useState(false);
  const [narrationPlaybackError, setNarrationPlaybackError] = useState('');
  const wakeLockRef = useRef(null);

  const flash = useCallback((message, isError = false) => {
    if (isError) setErrorMessage(message);
    else setNotice(message);
    window.setTimeout(() => {
      setErrorMessage((current) => current === message ? '' : current);
      setNotice((current) => current === message ? '' : current);
    }, 4500);
  }, []);

  const saveSession = useCallback((nextSession) => {
    setSession(nextSession);
    if (nextSession) sessionStorage.setItem('hollow-table-session', JSON.stringify(nextSession));
    else sessionStorage.removeItem('hollow-table-session');
  }, []);

  useEffect(() => {
    const onState = (nextSnapshot) => {
      const phaseKey = `${nextSnapshot.status}:${nextSnapshot.phase}:${nextSnapshot.round}:${(nextSnapshot.tieCandidates || []).map((item) => item.id).join(',')}`;
      if (lastPhaseKey.current !== phaseKey) setSelectedTarget('');
      lastPhaseKey.current = phaseKey;
      if (Number.isFinite(nextSnapshot.serverNow)) setServerOffset(nextSnapshot.serverNow - Date.now());
      setSnapshot(nextSnapshot);
      setScreen(nextSnapshot.status === 'lobby' ? 'lobby' : 'game');
    };
    const onReplaced = () => {
      saveSession(null);
      setSnapshot(null);
      setScreen('landing');
      flash('This seat was opened on another device. This tab has been signed out.', true);
    };
    const onKicked = (payload = {}) => {
      saveSession(null);
      setSnapshot(null);
      setScreen('landing');
      setSelectedTarget('');
      flash(payload.reason || 'The host removed your seat from this table.', true);
    };
    const onConnect = async () => {
      if (!session?.code || !session?.token) return;
      const resumeKey = `${socket.id}:${session.code}:${session.token}`;
      if (lastResumeKey.current === resumeKey) return;
      lastResumeKey.current = resumeKey;
      const response = await request('room:resume', session);
      if (response.ok) {
        if (response.snapshot) setSnapshot(response.snapshot);
      } else if (response.error === 'Saved table session not found.' || response.error === 'This reconnect code is no longer valid.') {
        saveSession(null);
        setSnapshot(null);
        setScreen('landing');
      } else {
        lastResumeKey.current = '';
        flash(response.error || 'Could not reconnect to the table.', true);
      }
    };
    socket.on('room:state', onState);
    socket.on('session:replaced', onReplaced);
    socket.on('session:kicked', onKicked);
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off('room:state', onState);
      socket.off('session:replaced', onReplaced);
      socket.off('session:kicked', onKicked);
      socket.off('connect', onConnect);
    };
  }, [session, saveSession, flash]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return undefined;
    navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('PWA service worker registration failed:', error));
    return undefined;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('hollow-haptics', hapticsEnabled ? 'on' : 'off');
      localStorage.setItem('hollow-narrator-volume', String(narratorVolume));
    } catch { /* Device preferences remain usable for this visit if storage is blocked. */ }
    if (narratorAudioElementRef.current) narratorAudioElementRef.current.volume = narratorVolume;
  }, [hapticsEnabled, narratorVolume]);

  useEffect(() => {
    const onInstallPrompt = (event) => { event.preventDefault(); setInstallPrompt(event); };
    const onInstalled = () => { setInstallPrompt(null); flash('The Hollow Table has been installed on this device.'); };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [flash]);

  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.status}:${snapshot.round}:${snapshot.phase}:${snapshot.nightStep || ''}:${snapshot.announcement?.id || ''}`;
    if (lastHapticKey.current && key !== lastHapticKey.current && hapticsEnabled && typeof navigator.vibrate === 'function') {
      const dramatic = snapshot.status === 'finished' || ['murder', 'elimination', 'victory'].includes(snapshot.announcement?.kind);
      navigator.vibrate(dramatic ? [55, 35, 55] : 24);
    }
    lastHapticKey.current = key;
  }, [snapshot?.status, snapshot?.round, snapshot?.phase, snapshot?.nightStep, snapshot?.announcement?.id, hapticsEnabled]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [snapshot?.chat?.length]);

  const createTable = async () => {
    setErrorMessage('');
    if (name.trim().length < 2) return flash('Enter a nickname with at least two characters.', true);
    setBusy(true);
    const response = await request('room:create', { name, avatar, maxPlayers, gameMode });
    setBusy(false);
    if (!response.ok) return flash(response.error, true);
    saveSession({ code: response.code, token: response.token });
    window.history.replaceState({}, '', window.location.pathname);
    setSnapshot(response.snapshot);
    setScreen('lobby');
  };

  const joinTable = async () => {
    setErrorMessage('');
    if (name.trim().length < 2) return flash('Enter a nickname with at least two characters.', true);
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(joinCode.trim().toUpperCase())) return flash('Enter the four-character table code.', true);
    setBusy(true);
    const response = await request('room:join', { code: joinCode, name, avatar, gameMode });
    setBusy(false);
    if (!response.ok) return flash(response.error, true);
    saveSession({ code: response.code, token: response.token });
    window.history.replaceState({}, '', window.location.pathname);
    setSnapshot(response.snapshot);
    setScreen('lobby');
  };

  const updateLobby = async (nextMaxPlayers, nextMafiaCount, nextUndertakerCount = snapshot?.settings?.undertakerCount ?? 0) => {
    setMaxPlayers(nextMaxPlayers);
    setMafiaCount(nextMafiaCount);
    const response = await request('lobby:update', { maxPlayers: nextMaxPlayers, mafiaCount: nextMafiaCount, undertakerCount: nextUndertakerCount });
    if (!response.ok) flash(response.error, true);
    return response;
  };

  const setNarrator = async (playerId) => {
    const response = await request('lobby:narrator:set', { playerId });
    if (!response.ok) flash(response.error || 'Could not assign the narrator device.', true);
    else flash('The narrator device has been assigned.');
    return response;
  };

  const startGame = async () => {
    setBusy(true);
    const response = await request('lobby:start');
    setBusy(false);
    if (!response.ok) flash(response.error, true);
  };

  const kickPlayer = async (player) => {
    if (!snapshot?.me?.isHost || !player || player.id === snapshot.me.id) return;
    const action = snapshot.status === "playing" ? "forfeit this player's seat in the current game" : "remove this guest from the lobby";
    if (!window.confirm(`Remove ${player.name}? This will ${action}.`)) return;
    const response = await request('room:kick', { playerId: player.id });
    if (!response?.ok) flash(response?.error || 'Could not remove this guest.', true);
    else flash(`${player.name} was removed from the table.`);
  };

  const requestRematch = async () => {
    if (!snapshot?.me?.isHost) return;
    setBusy(true);
    const response = await request('game:rematch');
    setBusy(false);
    if (!response?.ok) flash(response?.error || 'The rematch could not begin.', true);
    else flash('The table is gathering again. Everyone kept their seat.');
  };

  const closeTutorial = useCallback(() => {
    setTutorialOpen(false);
    try { localStorage.setItem('hollow-tutorial-seen', 'yes'); } catch { /* Tutorial can still be opened manually. */ }
  }, []);
  const closeRules = useCallback(() => setRulesOpen(false), []);
  const closePreferences = useCallback(() => setPreferencesOpen(false), []);

  const leaveTable = async () => {
    if (snapshot?.status === 'playing' && !window.confirm('Leaving now counts as abandoning your seat. Your character will be removed from the living players. Continue?')) return;
    setLeaving(true);
    const response = await request('room:leave');
    if (!response?.ok) {
      setLeaving(false);
      flash(response?.error || 'Could not leave the table. Please try again.', true);
      return;
    }
    saveSession(null);
    setSnapshot(null);
    setScreen('landing');
    setLeaving(false);
    setSelectedTarget('');
    lastPhaseKey.current = '';
  };

  const sendChat = async (event) => {
    event.preventDefault();
    if (!messageText.trim()) return;
    const response = await request('chat:send', { text: messageText });
    if (!response.ok) flash(response.error, true);
    else setMessageText('');
  };

  const readyIdentity = async () => {
    if (snapshot?.gameMode !== 'in_person') return;
    const response = await request('identity:ready');
    if (!response.ok) flash(response.error || 'Could not confirm your identity card.', true);
  };

  const actNight = async () => {
    if (!selectedTarget) return flash('Choose a player first.', true);
    const response = await request('night:act', { targetId: selectedTarget });
    if (!response.ok) flash(response.error, true);
    else flash('Your night action has been recorded.');
  };

  const actUndertaker = async (targetId = null, decline = false) => {
    const response = await request('night:undertaker', { targetId, decline });
    if (!response.ok) flash(response.error || 'The identity could not be inherited.', true);
    else flash(decline ? 'Your power remains unspent.' : 'The identity has been inherited. Your new role begins next night.');
    return response;
  };

  const vote = async () => {
    if (!selectedTarget) return flash('Choose a player first.', true);
    const response = await request('day:vote', { targetId: selectedTarget });
    if (!response.ok) flash(response.error, true);
    else flash('Vote recorded.');
  };

  const readyToVote = async () => {
    const response = await request('day:ready', { ready: !Boolean(snapshot?.me?.readyToVote) });
    if (!response.ok) flash(response.error, true);
    else flash(response.ready ? 'You are marked ready for the vote.' : 'You are no longer marked ready.');
  };

  const getNarratorAudioElement = () => {
    if (narratorAudioContextRef.current?.state === 'closed') {
      narratorAudioContextRef.current = null;
      narratorAudioSourceRef.current = null;
      narratorAudioGainRef.current = null;
      narratorAudioCompressorRef.current = null;
      narratorAudioElementRef.current = null;
    }
    if (!narratorAudioElementRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      audio.volume = narratorVolume;
      audio.addEventListener('error', () => {
        setNarrationPlaybackError('Audio could not be loaded. Check that the voice pack is complete.');
      });
      narratorAudioElementRef.current = audio;
    }
    return narratorAudioElementRef.current;
  };

  const prepareNarratorAudioGraph = (audio) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    let context = narratorAudioContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContextClass();
      narratorAudioContextRef.current = context;
    }
    if (!narratorAudioSourceRef.current) {
      const source = context.createMediaElementSource(audio);
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-19, context.currentTime);
      compressor.knee.setValueAtTime(16, context.currentTime);
      compressor.ratio.setValueAtTime(3.5, context.currentTime);
      compressor.attack.setValueAtTime(0.004, context.currentTime);
      compressor.release.setValueAtTime(0.24, context.currentTime);
      const gain = context.createGain();
      gain.gain.setValueAtTime(1.08, context.currentTime);
      source.connect(compressor);
      compressor.connect(gain);
      gain.connect(context.destination);
      narratorAudioSourceRef.current = source;
      narratorAudioCompressorRef.current = compressor;
      narratorAudioGainRef.current = gain;
    }
    return context;
  };

  const playNarratorClip = async (clipId) => {
    const audio = getNarratorAudioElement();
    try {
      const context = prepareNarratorAudioGraph(audio);
      if (context?.state === 'suspended') await context.resume();
      audio.pause();
      audio.currentTime = 0;
      audio.src = `/audio/${clipId}.mp3`;
      audio.load();
      await audio.play();
      setNarrationPlaybackError('');
      return { ok: true, audio };
    } catch (error) {
      setNarrationPlaybackError(error?.name === 'NotAllowedError'
        ? 'Tap ENABLE THE HOUSE VOICE to allow this phone to play announcements.'
        : 'Narrator audio could not start. Check the phone volume and audio files.');
      return { ok: false, error: 'The browser blocked narrator audio. Tap the enable button and try again.' };
    }
  };

  const testNarratorSpeaker = async () => {
    if (!snapshot?.me?.isNarrator) return { ok: false, error: 'Only the assigned narrator device can enable public audio.' };
    if (!snapshot.voicePackReady) return { ok: false, error: 'The complete narrator voice pack is not installed yet.' };
    setNarrationPlaybackError('');
    const audio = getNarratorAudioElement();
    let timeoutId;
    let failed = false;
    const playbackEnded = new Promise((resolve) => {
      const finish = (didFail = false) => {
        failed = didFail;
        resolve();
      };
      audio.addEventListener('ended', () => finish(false), { once: true });
      audio.addEventListener('error', () => finish(true), { once: true });
    });
    const result = await playNarratorClip('narrator_test');
    if (!result.ok) return result;
    await Promise.race([playbackEnded, new Promise((resolve) => { timeoutId = window.setTimeout(resolve, 15000); })]);
    window.clearTimeout(timeoutId);
    if (failed || !audio.ended) {
      audio.pause();
      return { ok: false, error: 'The narrator test did not finish playing. Check the volume and try again.' };
    }
    const ready = await request('narrator:audio-ready');
    if (!ready.ok) return { ok: false, error: ready.error || 'The server could not confirm narrator readiness.' };
    narrationUnlockedRef.current = true;
    setNarrationUnlocked(true);
    return { ok: true };
  };

  useEffect(() => {
    if (snapshot?.gameMode !== 'in_person') return;
    if (lastNarratorIdRef.current !== snapshot.narratorId) {
      lastNarratorIdRef.current = snapshot.narratorId || '';
      narrationUnlockedRef.current = false;
      setNarrationUnlocked(false);
    }
    if (!snapshot?.me?.isNarrator) return;
    if (snapshot.narratorAudioReady && !narrationUnlockedRef.current) {
      narrationUnlockedRef.current = true;
      setNarrationUnlocked(true);
    }
    if (!narrationUnlockedRef.current) return;
    const cue = getNarrationCue(snapshot);
    if (!cue) return;
    const storageKey = `hollow-narration:${snapshot.code}`;
    let previousKey = '';
    try { previousKey = sessionStorage.getItem(storageKey) || ''; } catch { /* Audio still works without session storage. */ }
    if (previousKey === cue.key) return;
    try { sessionStorage.setItem(storageKey, cue.key); } catch { /* In-memory dedupe below still works. */ }
    playNarratorClip(cue.clip).then((result) => {
      if (!result.ok) {
        try { if (sessionStorage.getItem(storageKey) === cue.key) sessionStorage.removeItem(storageKey); } catch { /* No persistent store available. */ }
      }
    });
  }, [snapshot, narrationUnlocked]);

  useEffect(() => {
    if (snapshot?.status !== 'playing') return undefined;
    let disposed = false;
    const requestScreenWakeLock = async () => {
      if (disposed || document.visibilityState !== 'visible' || !navigator.wakeLock?.request) return;
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          if (!disposed && document.visibilityState === 'visible') void requestScreenWakeLock();
        }, { once: true });
      } catch {
        // Wake Lock is optional; unsupported browsers continue without it.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void requestScreenWakeLock();
        return;
      }
      const currentSnapshot = latestSnapshotRef.current;
      if (currentSnapshot?.gameMode === 'in_person' && currentSnapshot?.me?.isNarrator) {
        narrationUnlockedRef.current = false;
        setNarrationUnlocked(false);
        const missedCue = getNarrationCue(currentSnapshot);
        if (missedCue) {
          try {
            const storageKey = `hollow-narration:${currentSnapshot.code}`;
            if (sessionStorage.getItem(storageKey) === missedCue.key) sessionStorage.removeItem(storageKey);
          } catch { /* Audio can still be re-enabled when session storage is unavailable. */ }
        }
        void request('narrator:visibility', { visible: false });
      }
    };
    void requestScreenWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (wakeLockRef.current) {
        void wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [snapshot?.code, snapshot?.gameMode, snapshot?.status, snapshot?.me?.isNarrator]);

  useEffect(() => {
    if (snapshot?.narratorPaused && snapshot?.me?.isNarrator) {
      narrationUnlockedRef.current = false;
      setNarrationUnlocked(false);
    }
  }, [snapshot?.narratorPaused, snapshot?.me?.isNarrator]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.code);
      flash('Table code copied. Invite your guests.');
    } catch {
      flash(`Your table code is ${snapshot.code}`);
    }
  };

  const countdown = snapshot?.phaseEndsAt ? snapshot.phaseEndsAt - (clock + serverOffset) : null;

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grain-overlay" />
      <header className="topbar">
        <button className="brand-lockup" onClick={() => snapshot ? null : setScreen('landing')} aria-label="The Hollow Table home">
          <span className="brand-mark">✦</span>
          <span><strong>THE HOLLOW TABLE</strong><small>A SOCIAL DEDUCTION HORROR GAME</small></span>
        </button>
        <div className="topbar-right">
          <span className="online-indicator"><i /> {socket.connected ? 'SERVER CONNECTED' : 'RECONNECTING'}</span>
          <button className="know-roles-button" type="button" onClick={() => setTutorialOpen(true)}>HOW TO PLAY</button>
          <button className="know-roles-button" type="button" onClick={() => setRulesOpen(true)}>✦ KNOW THE ROLES</button>
          <button className="quiet-button" type="button" onClick={() => setPreferencesOpen(true)}>SETTINGS</button>
          {installPrompt && <button className="quiet-button" type="button" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>INSTALL APP</button>}
          {snapshot && <button className="quiet-button" onClick={leaveTable} disabled={leaving}>{leaving ? 'LEAVING…' : 'LEAVE TABLE'}</button>}
        </div>
      </header>

      {!socket.connected && <div className="reconnect-banner app-connection-banner" role="status" aria-live="polite"><strong>THE CONNECTION HAS BEEN LOST</strong><span>Trying to restore your seat. Keep this tab open and stay online.</span></div>}
      {(errorMessage || notice) && <div className={`toast ${errorMessage ? 'toast-error' : 'toast-good'}`}>{errorMessage || notice}</div>}
      {snapshot?.clockQuarantined && (
        <div className="announcement announcement-red system-clock-quarantine" role="alert">
          <div className="announcement-side" aria-hidden="true">☠</div>
          <div>
            <div className="announcement-kicker">TABLE INTERRUPTED · GAME CLOCK PAUSED</div>
            <h2>THE TABLE HAS BEEN SEALED</h2>
            <p>This table was paused after a technical issue to protect the game. Other tables are unaffected. Please create a new table to continue playing.</p>
          </div>
          <div className="announcement-side" aria-hidden="true">☠</div>
        </div>
      )}
      {snapshot?.status === 'finished' && snapshot.gameMode === 'in_person' && snapshot.me.isNarrator && !narrationUnlocked && (
        <div className="narrator-unlock-banner narrator-finished-unlock" role="status">
          <div><strong>THE FINAL VERDICT IS READY</strong><span>{narrationPlaybackError || 'Enable this phone to hear the final announcement.'}</span></div>
          <button type="button" className="outline-button" onClick={testNarratorSpeaker}>ENABLE HOUSE VOICE</button>
        </div>
      )}

      {!snapshot && (
        <Landing
          name={name} setName={setName}
          gameMode={gameMode} setGameMode={setGameMode}
          avatar={avatar} setAvatar={setAvatar}
          joinCode={joinCode} setJoinCode={setJoinCode}
          maxPlayers={maxPlayers} setMaxPlayers={(value) => { setMaxPlayers(value); setMafiaCount((current) => Math.min(current, Math.max(1, Math.floor((value - 1) / 2)))); }}
          createTable={createTable} joinTable={joinTable} busy={busy}
        />
      )}

      {snapshot?.status === 'lobby' && (
        <Lobby
          snapshot={snapshot}
          maxPlayers={snapshot.settings.maxPlayers}
          mafiaCount={snapshot.settings.mafiaCount}
          undertakerCount={snapshot.settings.undertakerCount ?? 0}
          onUpdate={updateLobby}
          onStart={startGame}
          busy={busy}
          onCopy={copyCode}
          onKickPlayer={kickPlayer}
          onSetNarrator={setNarrator}
          onTestSpeaker={testNarratorSpeaker}
          narrationPlaybackError={narrationPlaybackError}
        />
      )}

      {snapshot?.status === 'playing' && (
        <Game
          snapshot={snapshot}
          countdown={countdown}
          selectedTarget={selectedTarget}
          setSelectedTarget={setSelectedTarget}
          actNight={actNight}
          actUndertaker={actUndertaker}
          vote={vote}
          messageText={messageText}
          setMessageText={setMessageText}
          sendChat={sendChat}
          chatEndRef={chatEndRef}
          session={session}
          clock={clock}
          serverOffset={serverOffset}
          onKickPlayer={kickPlayer}
          onReadyToVote={readyToVote}
          onIdentityReady={readyIdentity}
          narrationUnlocked={narrationUnlocked}
          onEnableNarration={testNarratorSpeaker}
          narrationPlaybackError={narrationPlaybackError}
          hapticsEnabled={hapticsEnabled}
        />
      )}

      {snapshot?.status === 'finished' && (
        <EndGame snapshot={snapshot} onLeave={leaveTable} onRematch={requestRematch} isHost={snapshot.me.isHost} busy={busy} />
      )}

      {rulesOpen && <RulesModal onClose={closeRules} />}
      {tutorialOpen && <ExperienceTutorial gameMode={snapshot?.gameMode || gameMode} onClose={closeTutorial} />}
      {preferencesOpen && <PreferencesModal hapticsEnabled={hapticsEnabled} setHapticsEnabled={setHapticsEnabled} narratorVolume={narratorVolume} setNarratorVolume={setNarratorVolume} onClose={closePreferences} />}

      <footer className="site-footer">
        <span>NO ONE IS INNOCENT AFTER MIDNIGHT.</span>
        <span>PRIVATE TABLES · {snapshot?.code || 'INVITE ONLY'}</span>
      </footer>
    </main>
  );
}

function RulesModal({ onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    const getFocusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    getFocusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = getFocusable();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);
  const roles = [
    { role: 'mafia', rank: 'A', name: 'Mafia', side: 'THE HOUSE', text: 'Work together in secret to choose a living player to murder each night. Win when the living Mafia equal or outnumber everyone else.' },
    { role: 'sheriff', rank: 'A', name: 'Sheriff', side: 'THE INVESTIGATOR', text: 'Investigate one living player each night. The answer is private to you. Find the Mafia and help the town eliminate them.' },
    { role: 'angel', rank: 'A', name: 'Angel', side: 'THE PROTECTOR', text: 'Protect one living player each night. You may protect yourself, but not the same person on consecutive nights. A saved player is never publicly identified.' },
    { role: 'undertaker', rank: 'Q', name: 'Undertaker', side: 'THE GRAVE KEEPER', text: 'Optional · maximum one. From Round 2, when a previous player has been eliminated, you may privately inherit that player’s role once. Their seat stays empty; you keep your name and seat. Your new role becomes active next night. Declining or timing out preserves the unused power. The public wake-up call is identical every night; no one is told whether you used it or whose identity you took.' },
    { role: 'citizen', rank: '7', name: 'Citizen', side: 'THE TOWN', text: 'You have no night action. Listen carefully, discuss what you notice, and vote to eliminate the Mafia.' },
  ];
  return (
    <div className="rules-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-modal-title">
        <button type="button" className="rules-modal-close" onClick={onClose} aria-label="Close rules">×</button>
        <div className="eyebrow"><span /> THE HOUSE RULEBOOK <span /></div>
        <h2 id="rules-modal-title">KNOW THE <em>ROLES</em></h2>
        <p className="rules-modal-intro">Every seat holds a secret. Learn what each role can do, how the night moves, and how the house decides its winner.</p>
        <div className="rules-role-grid">
          {roles.map((entry) => (
            <article key={entry.role} className={`rules-role-card rules-role-${entry.role}`}>
              <div className="rules-role-rank">{entry.rank}</div>
              <div><small>{entry.side}</small><h3>{entry.name}</h3><p>{entry.text}</p></div>
            </article>
          ))}
        </div>
        <div className="rules-flow-grid">
          <article><span>01 · NIGHT</span><h3>The secret hours</h3><p><b>Online:</b> night actions take place privately inside the shared night timer. Mafia choose a target, Angel protects, Sheriff investigates, and an eligible Undertaker may inherit a departed role.</p><p><b>In Person:</b> the narrator follows one fixed public order: Town sleeps → Mafia → Angel → Sheriff → Undertaker → Town wakes. The Angel, Sheriff and Undertaker calls are kept in the sequence even when a role is absent, fallen, or its power has already been used. The Undertaker receives one public wake-up call only; no public use or identity announcement follows.</p></article>
          <article><span>02 · DAY</span><h3>Discuss and decide</h3><p>Everyone discusses the night. Living players vote privately. If the first vote ties, the accused face one tie-break vote. If the tie remains, nobody is eliminated.</p></article>
          <article><span>03 · VICTORY</span><h3>One faction remains</h3><p><b>Town wins</b> when every living Mafia member is gone. <b>Mafia wins</b> when living Mafia equal or outnumber all other living players.</p></article>
        </div>
        <div className="rules-privacy-note"><span>☾</span><p>During the game, no death announcement identifies the fallen player’s role. Private investigations and inherited identities stay on the relevant player’s own screen. The final reveal happens only after the game ends.</p></div>
        <button type="button" className="primary-button full-button rules-modal-continue" onClick={onClose}>I UNDERSTAND · RETURN TO THE HOUSE</button>
      </section>
    </div>
  );
}

function PreferencesModal({ hapticsEnabled, setHapticsEnabled, narratorVolume, setNarratorVolume, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const getFocusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]') || [])];
    getFocusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = getFocusable();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div className="experience-tutorial-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="preferences-modal panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title">
        <button type="button" className="rules-modal-close" onClick={onClose} aria-label="Close settings">×</button>
        <div className="eyebrow"><span /> DEVICE SETTINGS <span /></div>
        <h2 id="preferences-title">MAKE THE HOUSE <em>YOURS</em></h2>
        <label className="preference-row">
          <span><strong>HAPTIC FEEDBACK</strong><small>Subtle vibrations for phase changes and dramatic verdicts. Supported devices only.</small></span>
          <input type="checkbox" checked={hapticsEnabled} onChange={(event) => setHapticsEnabled(event.target.checked)} />
        </label>
        <label className="preference-volume">
          <span><strong>NARRATOR VOLUME</strong><small>Adjust public voice announcements on this device only.</small></span>
          <input type="range" min="0" max="1" step="0.05" value={narratorVolume} onChange={(event) => setNarratorVolume(Number(event.target.value))} />
          <small>{Math.round(narratorVolume * 100)}% · DOES NOT CHANGE OTHER PLAYERS’ DEVICES</small>
        </label>
        <p className="preferences-note">Preferences are saved on this device. In-Person narration still requires an explicit voice unlock after the browser returns from the background.</p>
        <button type="button" className="primary-button full-button" onClick={onClose}>SAVE & RETURN</button>
      </section>
    </div>
  );
}

function AvatarPicker({ selected, onSelect }) {
  return (
    <div className="avatar-picker">
      {AVATARS.map((item, index) => (
        <button
          type="button"
          key={item.id}
          title={item.label}
          aria-label={`Choose ${item.label} avatar`}
          className={`avatar-option avatar-tone-${index % 6} ${selected === item.id ? 'selected' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          <span>{item.face}</span>
        </button>
      ))}
    </div>
  );
}

function Landing({ name, setName, gameMode, setGameMode, avatar, setAvatar, joinCode, setJoinCode, maxPlayers, setMaxPlayers, createTable, joinTable, busy }) {
  const [mode, setMode] = useState(joinCode ? 'join' : 'create');
  return (
    <section className="landing-layout">
      <div className="landing-copy">
        <div className="eyebrow"><span /> THE HOUSE IS WAITING <span /></div>
        <h1>Some secrets<br /><em>never stay buried.</em></h1>
        <p className="landing-lede">Gather your circle. Take your seat. Find the liar before the house claims you all.</p>
        <div className="landing-mode-selector" role="group" aria-label="Choose how you will gather">
          <button type="button" className={`landing-mode-card ${gameMode === 'online' ? 'selected' : ''}`} onClick={() => setGameMode('online')} aria-pressed={gameMode === 'online'}>
            <span className="landing-mode-kicker">PLAY ONLINE</span>
            <strong>SUMMON FROM AFAR</strong>
            <small>The distance will not keep you safe.</small>
            <i aria-hidden="true">✦</i>
          </button>
          <button type="button" className={`landing-mode-card ${gameMode === 'in_person' ? 'selected' : ''}`} onClick={() => setGameMode('in_person')} aria-pressed={gameMode === 'in_person'}>
            <span className="landing-mode-kicker">PLAY IN PERSON</span>
            <strong>GATHER AT THE TABLE</strong>
            <small>Sit close. Close your eyes. Trust no one.</small>
            <i aria-hidden="true">☾</i>
          </button>
        </div>
        <div className="landing-features">
          <div><b>01</b><span>PRIVATE TABLES<br /><small>Four-character invite code</small></span></div>
          <div><b>02</b><span>SECRET ROLES<br /><small>Mafia, Sheriff, Angel, Undertaker, Citizen</small></span></div>
          <div><b>03</b><span>LIVE GAMEPLAY<br /><small>Discuss, investigate, vote</small></span></div>
        </div>
        <div className="quote-mark">“</div>
        <p className="whisper">Trust the silence. Fear the familiar.</p>
      </div>

      <section className="entry-card">
        <div className="card-topline"><span>✦</span> YOUR NIGHT BEGINS HERE <span>✦</span></div>
        <div className="entry-tabs">
          <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>CREATE TABLE</button>
          <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>JOIN TABLE</button>
        </div>
        <label className="field-label">YOUR NAME</label>
        <input className="dark-input" value={name} onChange={(event) => setName(event.target.value.slice(0, 18))} placeholder="Enter your nickname" maxLength={18} />
        <div className="picker-heading"><span className="field-label">CHOOSE YOUR PORTRAIT</span><small>24 portraits</small></div>
        <AvatarPicker selected={avatar} onSelect={setAvatar} />
        {mode === 'create' ? (
          <>
            <div className="setting-row"><span className="field-label">TABLE CAPACITY</span><strong>{maxPlayers} PLAYERS</strong></div>
            <input className="range-input" type="range" min="5" max="16" value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))} />
            <div className="range-labels"><span>5 MIN</span><span>16 MAX</span></div>
            <button className="primary-button full-button" onClick={createTable} disabled={busy}>{busy ? 'OPENING THE HOUSE…' : gameMode === 'in_person' ? 'GATHER THE TABLE' : 'OPEN A DISTANT TABLE'} <span>↗</span></button>
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="table-code">FOUR-CHARACTER TABLE CODE</label>
            <input id="table-code" className="dark-input code-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 4))} placeholder="X7K9" maxLength={4} />
            <button className="primary-button full-button" onClick={joinTable} disabled={busy}>{busy ? 'FINDING YOUR TABLE…' : gameMode === 'in_person' ? 'JOIN THE GATHERING' : 'ANSWER THE SUMMONS'} <span>↗</span></button>
          </>
        )}
        <p className="privacy-note"><span>♙</span> Private by code. No public matchmaking. No account required.</p>
      </section>
    </section>
  );
}

function Lobby({ snapshot, maxPlayers, mafiaCount, undertakerCount, onUpdate, onStart, busy, onCopy, onKickPlayer, onSetNarrator, onTestSpeaker, narrationPlaybackError }) {
  const isHost = snapshot.me.isHost;
  const actualCap = Math.max(1, Math.floor((snapshot.players.length - 1) / 2));
  const [localMax, setLocalMax] = useState(snapshot.settings.maxPlayers);
  const [localMafia, setLocalMafia] = useState(snapshot.settings.mafiaCount);
  const [localUndertaker, setLocalUndertaker] = useState(snapshot.settings.undertakerCount ?? 0);
  const [speakerTestBusy, setSpeakerTestBusy] = useState(false);
  const [speakerTestStatus, setSpeakerTestStatus] = useState('');
  useEffect(() => { setLocalMax(snapshot.settings.maxPlayers); }, [snapshot.settings.maxPlayers]);
  useEffect(() => { setLocalMafia(snapshot.settings.mafiaCount); }, [snapshot.settings.mafiaCount]);
  useEffect(() => { setLocalUndertaker(snapshot.settings.undertakerCount ?? 0); }, [snapshot.settings.undertakerCount]);
  useEffect(() => { setSpeakerTestStatus(''); }, [snapshot.narratorId]);
  const canStart = snapshot.players.length >= 5 && localMafia <= actualCap && localMax >= snapshot.players.length;
  const narratorPrerequisitesMet = snapshot.gameMode !== 'in_person' || (snapshot.voicePackReady && snapshot.narratorAudioReady);
  const runSpeakerTest = async () => {
    setSpeakerTestBusy(true);
    const result = await onTestSpeaker();
    setSpeakerTestBusy(false);
    setSpeakerTestStatus(result?.ok ? 'AUDIO READY · CHECK YOUR SPEAKER VOLUME' : result?.error || 'Speaker test failed.');
  };

  const saveSettings = async (nextMax, nextMafia, nextUndertaker = localUndertaker) => {
    const response = await onUpdate(nextMax, nextMafia, nextUndertaker);
    if (!response?.ok) {
      setLocalMax(snapshot.settings.maxPlayers);
      setLocalMafia(snapshot.settings.mafiaCount);
      setLocalUndertaker(snapshot.settings.undertakerCount ?? 0);
    }
  };
  const changeMax = (value) => {
    const nextMax = Number(value);
    const nextMafia = Math.min(localMafia, Math.max(1, Math.floor((nextMax - 1) / 2)));
    setLocalMax(nextMax);
    setLocalMafia(nextMafia);
    saveSettings(nextMax, nextMafia, localUndertaker);
  };
  const changeMafia = (value) => {
    setLocalMafia(Number(value));
    saveSettings(localMax, Number(value), localUndertaker);
  };

  return (
    <section className="lobby-layout">
      <div className="lobby-heading">
        <div className="eyebrow"><span /> THE GUESTS ARE GATHERING <span /></div>
        <h1>Take your <em>seat.</em></h1>
        <p>Invite your circle. When at least five souls have arrived, the host may begin.</p>
      </div>
      {snapshot.gameMode === 'in_person' && (
        <>
          <div className="in-person-mode-banner">
            <strong>GATHER AT THE TABLE</strong>
            <span>EVERY PLAYER USES THEIR OWN PHONE. ALL PHONES MUST STAY CONNECTED TO THE INTERNET. THIS IS NOT OFFLINE PLAY.</span>
          </div>
          <section className="panel narrator-panel">
            <div className="narrator-panel-heading">
              <div><div className="panel-kicker">THE VOICE OF THE HOUSE</div><h2>Narrator device</h2></div>
              <span className={snapshot.me.isNarrator ? 'narrator-device-badge narrator-device-active' : 'narrator-device-badge'}>{snapshot.me.isNarrator ? 'THIS DEVICE' : 'ONE SPEAKER ONLY'}</span>
            </div>
            <div className="narrator-assignment-row">
              <div className="narrator-avatar">{avatarFor(snapshot.narrator?.avatar).face}</div>
              <div className="narrator-assignment-copy">
                <small>ASSIGNED NARRATOR</small>
                <strong>{snapshot.narrator?.name || 'Awaiting a connected device'}</strong>
                <span>{snapshot.narrator?.connected ? 'This is the only device that will play public announcements.' : 'The assigned device is reconnecting. The host can assign another connected device.'}</span>
              </div>
              <span className={snapshot.narrator?.connected ? 'narrator-connection narrator-connected' : 'narrator-connection'}>{snapshot.narrator?.connected ? 'CONNECTED' : 'OFFLINE'}</span>
            </div>
            {isHost && (
              <div className="narrator-controls">
                <label className="narrator-select-wrap" htmlFor="narrator-device-select">
                  <span>ASSIGN THE SPEAKING DEVICE</span>
                  <select id="narrator-device-select" className="dark-input narrator-select" value={snapshot.narratorId || snapshot.me.id} onChange={(event) => onSetNarrator(event.target.value)} disabled={busy}>
                    {snapshot.players.filter((player) => player.connected).map((player) => <option key={player.id} value={player.id}>{player.name}{player.id === snapshot.me.id ? ' · HOST DEVICE' : ''}</option>)}
                  </select>
                </label>
                <p>Host controls stay with you. Assign one connected phone, then have that person enable the voice before the game begins.</p>
              </div>
            )}
            {snapshot.me.isNarrator ? (
              <div className="narrator-test-row">
                <button type="button" className="outline-button narrator-test-button" onClick={runSpeakerTest} disabled={speakerTestBusy || !snapshot.voicePackReady}>{speakerTestBusy ? 'TESTING HOUSE VOICE…' : snapshot.narratorAudioReady ? '♪ REPLAY VOICE TEST' : '♪ ENABLE & TEST NARRATOR'}</button>
                <span className={speakerTestStatus.startsWith('AUDIO READY') ? 'narrator-test-status narrator-test-success' : 'narrator-test-status'} aria-live="polite">{speakerTestStatus || narrationPlaybackError || (!snapshot.voicePackReady ? 'Generate the voice pack on your computer before starting.' : snapshot.narratorAudioReady ? 'NARRATOR READY · PUBLIC AUDIO PLAYS FROM THIS DEVICE ONLY' : 'Tap once to unlock public narration on this phone.')}</span>
              </div>
            ) : (
              <p className="narrator-guest-note">Public announcements play only from {snapshot.narrator?.name || 'the assigned narrator'}’s device. {snapshot.narratorAudioReady ? 'The narrator is ready.' : 'Ask the narrator to enable audio before the game begins.'} Your phone will stay silent.</p>
            )}
          </section>
        </>
      )}
      <div className="lobby-grid">
        <section className="panel code-panel">
          <div className="panel-kicker">YOUR PRIVATE TABLE CODE</div>
          <div className="code-display">{snapshot.code.split('').map((letter, index) => <span key={index}>{letter}</span>)}</div>
          <button className="outline-button copy-button" onClick={onCopy}>▣ COPY INVITE CODE</button>
          <Suspense fallback={<div className="voice-loading" role="status">PREPARING THE INVITE…</div>}>
            <InviteTools code={snapshot.code} gameMode={snapshot.gameMode} />
          </Suspense>
          <div className="code-footnote">Only guests with this code can enter.</div>
        </section>
        <section className="panel guest-panel">
          <div className="panel-header"><div><div className="panel-kicker">THE GUEST LIST</div><h2>At the table <span>{snapshot.players.length}/{snapshot.settings.maxPlayers}</span></h2></div><span className="panel-symbol">♜</span></div>
          <div className="guest-list">
            {snapshot.players.map((player, index) => (
              <div className="guest-row" key={player.id}>
                <div className={`mini-avatar avatar-tone-${index % 6}`}>{avatarFor(player.avatar).face}</div>
                <div className="guest-name">{player.name}{player.isHost && <small>HOST</small>}</div>
                <span className={`guest-status ${player.connected ? 'connected' : ''}`}><i /> {player.connected ? 'HERE' : 'RECONNECTING'}</span>
                {isHost && player.id !== snapshot.me.id && <button className="host-kick-button" onClick={() => onKickPlayer(player)} title={`Remove ${player.name}`}>REMOVE</button>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, Math.min(6, snapshot.settings.maxPlayers - snapshot.players.length)) }).map((_, index) => (
              <div className="guest-row empty-seat" key={`empty-${index}`}><div className="mini-avatar">?</div><div className="guest-name">Awaiting a guest</div><span>EMPTY SEAT</span></div>
            ))}
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-header"><div><div className="panel-kicker">THE HOUSE RULES</div><h2>Game settings</h2></div><span className="panel-symbol">⚙</span></div>
          {isHost ? (
            <>
              <div className="setting-block"><div className="setting-row"><label>Maximum guests</label><strong>{localMax}</strong></div><input className="range-input" type="range" min="5" max="16" value={localMax} onChange={(event) => changeMax(event.target.value)} /></div>
              <div className="setting-block"><div className="setting-row"><label>Mafia members</label><strong>{localMafia}</strong></div><input className="range-input" type="range" min="1" max={Math.max(1, Math.floor((localMax - 1) / 2))} value={localMafia} onChange={(event) => changeMafia(event.target.value)} /></div>
              <div className="undertaker-setting-card">
                <div><span className="panel-kicker">OPTIONAL SECRET ROLE · MAXIMUM ONE</span><strong>Include the Undertaker?</strong><small>Recommended for 9+ players, but available at any table size.</small></div>
                <div className="undertaker-choice" role="group" aria-label="Undertaker count">
                  <button type="button" className={localUndertaker === 0 ? 'selected' : ''} onClick={() => { setLocalUndertaker(0); saveSettings(localMax, localMafia, 0); }}>0 · OFF</button>
                  <button type="button" className={localUndertaker === 1 ? 'selected' : ''} onClick={() => { setLocalUndertaker(1); saveSettings(localMax, localMafia, 1); }}>1 · ON</button>
                </div>
              </div>
              <div className="fixed-roles"><span><b>1</b> SHERIFF</span><span><b>1</b> ANGEL</span><span><b>{localUndertaker}</b> UNDERTAKER</span><span><b>4 MIN</b> DISCUSSION FLOOR</span></div>
              {snapshot.players.length >= 5 && mafiaCount > actualCap && <p className="warning-note">With {snapshot.players.length} players, reduce Mafia to {actualCap} or fewer before starting.</p>}
              <button className="primary-button full-button start-button" onClick={onStart} disabled={busy || !canStart || !narratorPrerequisitesMet}>{busy ? 'AWAKENING THE HOUSE…' : snapshot.gameMode === 'in_person' ? (!snapshot.voicePackReady ? 'NARRATOR AUDIO PACK NOT READY' : !snapshot.narratorAudioReady ? 'ENABLE THE NARRATOR VOICE FIRST' : 'BEGIN THE GATHERING') : 'BEGIN THE GAME'} <span>↗</span></button>
              <p className="host-note">You are the host. Roles are assigned secretly by the server.</p>
            </>
          ) : (
            <div className="waiting-host"><div className="waiting-orbit">✧</div><h3>Waiting for the host</h3><p>The host is preparing the house rules. The game begins when at least five guests have arrived.</p><div className="fixed-roles"><span><b>1</b> SHERIFF</span><span><b>1</b> ANGEL</span><span><b>{snapshot.settings.undertakerCount ?? 0}</b> UNDERTAKER</span></div></div>
          )}
        </section>
      </div>
      <div className="lobby-bottom-note"><span>✦</span> Once the game begins, no new guests may enter. <span>✦</span></div>
    </section>
  );
}

function MurderOverlay({ announcement }) {
  if (!announcement) return null;
  return (
    <div className="murder-overlay" key={announcement.id} aria-live="assertive">
      <div className="murder-red-flash" />
      <div className="murder-blood-burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
      <div className="murder-knife" aria-hidden="true">
        <svg viewBox="0 0 180 420">
          <defs><linearGradient id="knifeSteel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff0db" /><stop offset=".45" stopColor="#aeb4ba" /><stop offset="1" stopColor="#4d5158" /></linearGradient></defs>
          <path d="M90 8 L137 220 L90 275 L43 220 Z" fill="url(#knifeSteel)" stroke="#d9d0c7" strokeWidth="4" />
          <path d="M90 275V385" stroke="#39201b" strokeWidth="30" strokeLinecap="round" />
          <path d="M49 292H131" stroke="#a77b4f" strokeWidth="18" strokeLinecap="round" />
          <path d="M90 287V378" stroke="#8b4b37" strokeWidth="5" />
        </svg>
      </div>
      <div className="murder-reveal-text">
        <span>THE HOUSE HAS TAKEN</span>
        <strong>{announcement.victimName || 'A PLAYER'}</strong>
        <em>HAS BEEN MURDERED</em>
      </div>
    </div>
  );
}


const VOTE_TABLE_MS = 6200;
const ELIMINATION_VERDICT_END_MS = 10800;
const NO_ELIMINATION_VERDICT_END_MS = 8500;

function TypewriterText({ text, className = '', speed = 62 }) {
  const [visibleText, setVisibleText] = useState('');
  useEffect(() => {
    setVisibleText('');
    if (!text) return undefined;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setVisibleText(text.slice(0, index));
      if (index >= text.length) window.clearInterval(timer);
    }, speed);
    return () => window.clearInterval(timer);
  }, [text, speed]);
  return <span className={className}>{visibleText}</span>;
}

function CinematicTransition({ transition, announcement, voteReveal, elapsed }) {
  if (!transition) return null;
  const kind = transition.kind;
  const victimName = transition.victimName || announcement?.victimName || 'A PLAYER';
  const victimAvatar = avatarFor(transition.victimAvatar || announcement?.victimAvatar);

  if (kind === 'murder') {
    return (
      <div className="cinematic-overlay cinematic-murder" role="alert" aria-live="assertive">
        <div className="cinematic-blood-wash" />
        <div className="cinematic-skull" aria-hidden="true">☠</div>
        <div className="cinematic-knife" aria-hidden="true"><svg viewBox="0 0 120 360" role="presentation"><path d="M60 4 L94 207 L60 250 L26 207 Z" fill="#d7dce0" stroke="#f1e9e2" strokeWidth="4"/><path d="M60 250V340" stroke="#38201c" strokeWidth="25" strokeLinecap="round"/><path d="M30 267H90" stroke="#b58a5a" strokeWidth="17" strokeLinecap="round"/><path d="M60 259V332" stroke="#8f4a39" strokeWidth="4"/></svg></div>
        <div className="cinematic-content">
          <span className="cinematic-prelude"><TypewriterText key={transition.id + '-prelude'} text="THE HOUSE HAS GONE SILENT…" speed={82}/></span>
          <div className="cinematic-victim-avatar">{victimAvatar.face}</div>
          {elapsed >= 1100 && <h1 className="cinematic-title"><TypewriterText key={transition.id + '-victim'} text={`${victimName.toUpperCase()} IS MURDERED!`} speed={72}/></h1>}
          <p className="cinematic-subline">NO ONE HEARD THE FINAL FOOTSTEP.</p>
        </div>
      </div>
    );
  }

  if (kind === 'quiet') {
    return (
      <div className="cinematic-overlay cinematic-quiet" role="status" aria-live="polite">
        <div className="cinematic-blood-wash"/><div className="cinematic-skull" aria-hidden="true">☠</div>
        <div className="cinematic-content"><span className="cinematic-prelude">THE DOORS OPEN AT DAWN</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-quiet'} text="IT WAS A QUIET NIGHT" speed={72}/></h1><p className="cinematic-subline">NO ONE WAS TAKEN. THE HOUSE KEEPS ITS SECRET.</p></div>
      </div>
    );
  }

  const rows = voteReveal?.rows ?? [];
  const showingVotes = elapsed < VOTE_TABLE_MS;
  const showingVerdict = kind === 'elimination' ? elapsed >= VOTE_TABLE_MS && elapsed < ELIMINATION_VERDICT_END_MS
    : kind === 'tie' ? elapsed >= VOTE_TABLE_MS && elapsed < (transition.durationMs - 1200)
      : kind === 'no-elimination' ? elapsed >= VOTE_TABLE_MS && elapsed < NO_ELIMINATION_VERDICT_END_MS : false;
  const showingSleep = !showingVotes && !showingVerdict;

  return (
    <div className={`cinematic-overlay cinematic-${showingVotes ? 'votes' : showingSleep ? 'sleep' : 'verdict'}`} role="alert" aria-live="assertive">
      <div className="cinematic-blood-wash"/><div className="cinematic-skull" aria-hidden="true">☠</div>
      {showingVotes ? (
        <div className="vote-reveal-panel">
          <span className="cinematic-prelude">THE ELIMINATION VOTE IS COMPLETE</span>
          <h1 className="vote-reveal-title">WHO VOTED FOR WHOM</h1>
          <div className="vote-reveal-head"><span>PLAYER</span><span>VOTED AGAINST</span></div>
          <div className="vote-reveal-list">
            {rows.map((row, index) => (
              <div className="vote-reveal-row" key={row.voterId} style={{'--row-delay': `${Math.min(index * 220, 3300)}ms`}}>
                <div className="vote-person"><span>{avatarFor(row.voterAvatar).face}</span><strong>{row.voterName}</strong></div>
                <div className="vote-target"><span>{row.targetName ? avatarFor(row.targetAvatar).face : '—'}</span><strong>{row.targetName || 'DID NOT VOTE'}</strong></div>
              </div>
            ))}
            {rows.length === 0 && <div className="vote-reveal-empty">NO VOTES WERE CAST.</div>}
          </div>
        </div>
      ) : showingVerdict ? (
        <div className="cinematic-content">
          {kind === 'elimination' ? <><span className="cinematic-prelude">THE TABLE HAS MADE ITS CHOICE</span><div className="cinematic-victim-avatar">{victimAvatar.face}</div><h1 className="cinematic-title"><TypewriterText key={transition.id + '-elimination'} text={`${victimName.toUpperCase()} IS ELIMINATED!`} speed={74}/></h1><p className="cinematic-subline">THEIR SEAT WILL REMAIN EMPTY.</p></>
            : kind === 'tie' ? <><span className="cinematic-prelude">THE TABLE CANNOT AGREE</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-tie'} text="THE VOTE IS TIED" speed={72}/></h1><p className="cinematic-subline">THE ACCUSED WILL FACE ONE FINAL VOTE.</p></>
              : <><span className="cinematic-prelude">THE BALLOTS HAVE BEEN COUNTED</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-none'} text="NO ONE IS ELIMINATED" speed={72}/></h1><p className="cinematic-subline">THE HOUSE HAS ACCEPTED NO VERDICT.</p></>}
        </div>
      ) : (
        <div className="cinematic-content cinematic-sleep-content"><span className="cinematic-prelude">THE CANDLES ARE GOING OUT</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-sleep'} text="TOWN, SLEEP." speed={95}/></h1><p className="cinematic-subline">THE NIGHT BELONGS TO THE HOUSE.</p></div>
      )}
    </div>
  );
}

function SheriffRevealOverlay({ result }) {
  if (!result) return null;
  return (
    <div className={`sheriff-reveal-overlay ${result.kind === 'danger' ? 'sheriff-result-danger' : 'sheriff-result-safe'}`} role="alert" aria-live="assertive">
      <div className="cinematic-skull" aria-hidden="true">☠</div>
      <span>PRIVATE INVESTIGATION</span>
      <div className="sheriff-target-avatar">{avatarFor(result.targetAvatar).face}</div>
      <h2><TypewriterText key={result.id} text={result.text.toUpperCase()} speed={48}/></h2>
      <p>ONLY YOU CAN SEE THIS RESULT</p>
    </div>
  );
}

function UndertakerRevealOverlay({ result }) {
  if (!result) return null;
  const inheritedName = ROLE_NAMES[result.inheritedRole] || 'Unknown';
  const card = roleCardFor(result.inheritedRole);
  return (
    <div className="undertaker-reveal-overlay" role="alert" aria-live="assertive">
      <div className="undertaker-reveal-sigil" aria-hidden="true">⚰</div>
      <span>PRIVATE INHERITANCE · ONLY YOU CAN SEE THIS</span>
      <h2>{inheritedName}</h2>
      <p>You inherited the identity of {result.targetName || 'a departed soul'}.</p>
      <div className={`undertaker-inherited-mark undertaker-mark-${card.className}`}>{card.rank}<small>{card.roleName}</small></div>
      <strong>YOUR NEW ROLE BEGINS NEXT NIGHT</strong>
    </div>
  );
}

function Game({ snapshot, countdown, selectedTarget, setSelectedTarget, actNight, actUndertaker, vote, messageText, setMessageText, sendChat, chatEndRef, session, clock, serverOffset, onKickPlayer, onReadyToVote, onIdentityReady, narrationUnlocked, onEnableNarration, narrationPlaybackError, hapticsEnabled }) {
  const isInPerson = snapshot.gameMode === 'in_person';
  const isNight = snapshot.phase === 'night';
  const isMafiaWakeStep = ['mafia', 'mafia_clash'].includes(snapshot.nightStep);
  const isDiscussion = snapshot.phase === 'discussion';
  const isVoting = snapshot.phase === 'voting';
  const isTie = snapshot.phase === 'tieVoting';
  const isTransition = snapshot.phase === 'transition';
  const transitionElapsed = snapshot.transition?.startedAt ? Math.max(0, clock + serverOffset - snapshot.transition.startedAt) : 0;
  const isRoleAction = isNight && snapshot.me.alive && snapshot.me.roleActive !== false && (isInPerson
    ? (snapshot.me.role === 'mafia' ? isMafiaWakeStep : snapshot.me.role === 'angel' ? snapshot.nightStep === 'angel' : snapshot.me.role === 'sheriff' ? snapshot.nightStep === 'sheriff' : false)
    : ['mafia', 'sheriff', 'angel'].includes(snapshot.me.role));
  const isUndertakerWindow = isNight && snapshot.me.alive && snapshot.me.role === 'undertaker'
    && snapshot.me.roleActive !== false && !snapshot.me.undertakerUsed
    && (isInPerson ? snapshot.nightStep === 'undertaker' : true);
  const undertakerOptions = snapshot.me.undertakerOptions || [];
  const isVotePhase = snapshot.me.alive && (isVoting || isTie);
  const phaseTimer = countdown == null ? '—' : formatTime(countdown);
  const alivePlayers = snapshot.players.filter((player) => player.alive);
  const targetPlayers = alivePlayers.filter((player) => (player.id !== snapshot.me.id || (isNight && ['angel', 'mafia'].includes(snapshot.me.role))) && (!isTie || snapshot.tieCandidates.some((candidate) => candidate.id === player.id)));
  const voiceEnabled = !isInPerson && snapshot.me.alive && (isDiscussion || isTie || (isNight && snapshot.me.role === 'mafia' && snapshot.me.roleActive !== false));
  const identityStorageKey = `hollow-role-seen:${snapshot.code}:${snapshot.me.id}`;
  const [identityVisible, setIdentityVisible] = useState(false);
  // Always show the private role reveal when a player enters the live game.
  // The role itself is still stable in sessionStorage, so reconnecting cannot change it.
  const [identitySequence, setIdentitySequence] = useState('countdown');
  const [countdownNumber, setCountdownNumber] = useState(3);
  const [identityFlipped, setIdentityFlipped] = useState(false);
  const [hostControlsOpen, setHostControlsOpen] = useState(false);
  const [undertakerTarget, setUndertakerTarget] = useState('');
  const [sheriffReveal, setSheriffReveal] = useState(null);
  const seenSheriffResultRef = useRef(snapshot.me.privateResults?.[0]?.id || null);
  const mafiaCardIndex = snapshot.me.role === 'mafia' ? Math.max(0, snapshot.me.mafiaTeam.findIndex((member) => member.id === snapshot.me.id)) : 0;
  const roleCard = useMemo(() => roleCardFor(snapshot.me.role, mafiaCardIndex), [snapshot.me.role, mafiaCardIndex]);

  const identityReadySentRef = useRef(false);

  useEffect(() => {
    // A reconnecting player must not remain trapped behind the card overlay after
    // the room has already moved beyond the shared identity-reveal barrier.
    if (isInPerson && isNight && snapshot.nightStep !== 'role_reveal' && identitySequence !== 'done') {
      setIdentitySequence('done');
      setIdentityVisible(true);
    }
  }, [isInPerson, isNight, snapshot.nightStep, identitySequence]);

  useEffect(() => {
    if (identitySequence !== 'countdown') return undefined;
    let value = 3;
    setCountdownNumber(value);
    const timer = window.setInterval(() => {
      value -= 1;
      if (value <= 0) {
        window.clearInterval(timer);
        setIdentitySequence('card');
      } else {
        setCountdownNumber(value);
      }
    }, 850);
    return () => window.clearInterval(timer);
  }, [identitySequence]);

  useEffect(() => { setUndertakerTarget(''); }, [snapshot.round, snapshot.phase, snapshot.nightStep]);

  const finishIdentityReveal = () => {
    try { sessionStorage.setItem(identityStorageKey, 'seen'); } catch { /* The card still works without storage. */ }
    setIdentitySequence('done');
    setIdentityVisible(true);
    if (isInPerson && !identityReadySentRef.current) {
      identityReadySentRef.current = true;
      onIdentityReady?.();
    }
  };

  useEffect(() => {
    const latestResult = snapshot.me.privateResults?.[0];
    if (snapshot.me.role !== 'sheriff' || !latestResult || latestResult.undertakerTransfer || latestResult.id === seenSheriffResultRef.current) return undefined;
    seenSheriffResultRef.current = latestResult.id;
    setSheriffReveal(latestResult);
    const timer = window.setTimeout(() => setSheriffReveal(null), 2800);
    return () => window.clearTimeout(timer);
  }, [snapshot.me.privateResults?.[0]?.id, snapshot.me.role]);
  const [undertakerReveal, setUndertakerReveal] = useState(null);
  const seenUndertakerTransferRef = useRef(null);
  useEffect(() => {
    const latestResult = snapshot.me.privateResults?.[0];
    if (!latestResult?.undertakerTransfer || latestResult.id === seenUndertakerTransferRef.current) return undefined;
    seenUndertakerTransferRef.current = latestResult.id;
    setUndertakerReveal(latestResult);
    const timer = window.setTimeout(() => setUndertakerReveal(null), 4200);
    return () => window.clearTimeout(timer);
  }, [snapshot.me.privateResults?.[0]?.id]);

  const timerUrgent = countdown != null && countdown < 60_000;
  const disconnectedPlayers = snapshot.players.filter((player) => !player.connected && player.reconnectDeadline && player.reconnectDeadline > clock + serverOffset);
  const chatTitle = isNight ? 'THE WHISPERS' : 'THE TABLE WHISPERS';

  const ringPlayers = useMemo(() => snapshot.players.map((player, index) => {
    const angle = (Math.PI * 2 * index) / snapshot.players.length - Math.PI / 2;
    return { ...player, x: 50 + Math.cos(angle) * 39, y: 50 + Math.sin(angle) * 40 };
  }), [snapshot.players]);

  return (
    <section className="game-layout">
      {identitySequence !== 'done' && (
        <div className="identity-intro" role="dialog" aria-modal="true" aria-label="Your secret role">
          {identitySequence === 'countdown' ? (
            <div className="identity-countdown-stage">
              <span>THE HOUSE IS DEALING YOUR FATE</span>
              <strong key={countdownNumber}>{countdownNumber}</strong>
              <small>KEEP YOUR EYES ON THE CARD</small>
            </div>
          ) : (
            <div className="identity-intro-card-stage">
              <span className="identity-intro-kicker">ONE CARD. ONE SECRET. KEEP IT HIDDEN.</span>
              <RolePlayingCard
                card={roleCard}
                faceUp={identityFlipped}
                onFlip={() => { if (!identityFlipped) { setIdentityFlipped(true); setIdentitySequence('revealed'); } }}
              />
              {identityFlipped ? (
                <button className="primary-button identity-continue-button" onClick={finishIdentityReveal}>ENTER THE HOUSE <span>↗</span></button>
              ) : (
                <p className="identity-card-instruction">CLICK THE CARD TO REVEAL YOUR IDENTITY</p>
              )}
            </div>
          )}
        </div>
      )}
      {isInPerson && snapshot.narratorPaused && (
        <div className="narrator-paused-banner" role="status" aria-live="polite">
          <strong>THE VOICE OF THE HOUSE IS SILENT</strong>
          <span>The game clock is paused. The assigned narrator must reconnect, return to this screen and enable the house voice before the night continues.</span>
        </div>
      )}
      <div className="game-topline">
        <div><span className="room-pill">TABLE {snapshot.code}</span><span className="round-pill">ROUND {snapshot.round}</span></div>
        {!isTransition && <div className={`phase-clock ${timerUrgent ? 'urgent' : ''}`}><small>{isInPerson && isNight ? (snapshot.nightStep === 'role_reveal' ? 'IDENTITY WINDOW' : snapshot.nightStep === 'mafia_clash' ? 'FINAL MAFIA WINDOW' : ['mafia', 'angel', 'sheriff', 'undertaker'].includes(snapshot.nightStep) ? 'ACTION WINDOW' : 'THE HOUSE MOVES') : snapshot.phase === 'night' ? 'NIGHT ENDS IN' : snapshot.phase === 'discussion' ? 'DISCUSSION ENDS IN' : snapshot.phase === 'tieVoting' ? 'RECONSIDERATION ENDS IN' : 'VOTING ENDS IN'}</small><strong>{phaseTimer}</strong></div>}
      </div>
      <div className="game-heading" aria-live="polite" aria-atomic="true"><div className="eyebrow"><span /> {snapshot.phase === 'night' ? 'THE HOUSE HOLDS ITS BREATH' : 'THE LIVING HAVE THE FLOOR'} <span /></div><h1>{phaseTitle(snapshot)}</h1><p>{phaseDescription(snapshot)}</p></div>
      {disconnectedPlayers.length > 0 && (
        <div className="reconnect-banner" role="status" aria-live="polite">
          <strong>THE HOUSE IS HOLDING THEIR SEAT</strong>
          {disconnectedPlayers.map((player) => <span key={player.id}>{player.name} is reconnecting · {formatTime(player.reconnectDeadline - (clock + serverOffset))} remaining</span>)}
        </div>
      )}

      {isInPerson && snapshot.me.isNarrator && !narrationUnlocked && (
        <div className="narrator-unlock-banner" role="status">
          <div><strong>THE HOUSE VOICE IS MUTED ON THIS DEVICE</strong><span>{narrationPlaybackError || 'Enable audio to resume public announcements from this narrator phone.'}</span></div>
          <button type="button" className="outline-button" onClick={onEnableNarration}>ENABLE HOUSE VOICE</button>
        </div>
      )}

      {snapshot.announcement && !isTransition && (
        <div key={snapshot.announcement.id} className={`announcement announcement-${snapshot.announcement.accent || 'red'}`}>
          <div className="announcement-side">✦</div>
          <div><div className="announcement-kicker">{snapshot.announcement.kind === 'murder' ? 'MURDER REPORT' : snapshot.announcement.kind === 'elimination' ? 'ELIMINATION REPORT' : snapshot.announcement.kind === 'departure' ? 'DEPARTURE REPORT' : 'A MESSAGE FROM THE HOUSE'}</div><h2>{snapshot.announcement.title}</h2><p className="typewriter-text">{snapshot.announcement.text}</p></div>
          <div className="announcement-side">✦</div>
        </div>
      )}

      {isInPerson && isNight && snapshot.nightCue && (
        <section className={`in-person-night-banner in-person-step-${snapshot.nightStep}`} key={snapshot.nightCue.id}>
          <div className="in-person-night-sigil" aria-hidden="true">{snapshot.nightStep === 'mafia_clash' ? '⚔' : snapshot.nightStep === 'angel' ? '✧' : snapshot.nightStep === 'sheriff' ? '⌖' : snapshot.nightStep === 'undertaker' ? '⚰' : '☾'}</div>
          <div className="in-person-night-copy"><small>THE VOICE OF THE HOUSE · {String(snapshot.nightStep || '').replaceAll('_', ' ').toUpperCase()}</small><h2>{snapshot.nightCue.title}</h2><p>{snapshot.nightCue.text}</p>{snapshot.nightStep === 'role_reveal' && snapshot.identityReadiness && <span className="in-person-identity-progress">{snapshot.identityReadiness.ready} / {snapshot.identityReadiness.required} HAVE ENTERED</span>}</div>
          <span className="in-person-night-edge" aria-hidden="true" />
        </section>
      )}
      {isTransition && <CinematicTransition transition={snapshot.transition} announcement={snapshot.announcement} voteReveal={snapshot.voteReveal} elapsed={transitionElapsed} />}
      {sheriffReveal && <SheriffRevealOverlay result={sheriffReveal} />}
      {undertakerReveal && <UndertakerRevealOverlay result={undertakerReveal} />}

      {snapshot.me.role === 'mafia' && snapshot.me.alive && snapshot.me.roleActive !== false && identityVisible && (!isInPerson || !isNight || isMafiaWakeStep) && (
        <section className="mafia-stage-intel" aria-label="Private Mafia team">
          <div className="mafia-stage-heading"><small>CLASSIFIED · MAFIA ONLY</small><strong>THE INNER CIRCLE</strong><span>{snapshot.me.mafiaTeam.length} IN THE HOUSE</span></div>
          <div className="mafia-stage-members">
            {snapshot.me.mafiaTeam.map((member) => (
              <div className={`mafia-stage-member ${member.alive ? '' : 'member-fallen'}`} key={member.id}>
                <span className="mafia-stage-avatar">{avatarFor(member.avatar).face}</span>
                <span><strong>{member.name}{member.id === snapshot.me.id ? ' · YOU' : ''}</strong><small>{member.alive ? 'IN THE HUNT' : 'FALLEN'}</small></span>
              </div>
            ))}
          </div>
          {isNight && snapshot.actionProgress?.conflicting && <p className="mafia-conflict-note">CONFLICTING TARGETS · THE HOUSE MAY GRANT ONE 15-SECOND EXTENSION</p>}
          {isNight && snapshot.actionProgress?.conflictExtensionUsed && <p className="mafia-conflict-note">THE EXTRA 15 SECONDS HAVE BEEN GRANTED</p>}
        </section>
      )}

      <div className="game-main-grid">
        <section className={`table-stage ${isNight ? 'table-night' : ''}`}>
          <div className="haunted-mansion" aria-hidden="true">
            <svg viewBox="0 0 900 360" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="bungalowSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#08070d"/><stop offset=".62" stopColor="#1d1017"/><stop offset="1" stopColor="#090708"/></linearGradient>
                <radialGradient id="bungalowMoon"><stop offset="0" stopColor="#e8cdb0" stopOpacity=".58"/><stop offset="1" stopColor="#bb7e73" stopOpacity="0"/></radialGradient>
                <linearGradient id="bungalowWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#40302d"/><stop offset="1" stopColor="#120e11"/></linearGradient>
                <filter id="windowGlow"><feGaussianBlur stdDeviation="7"/></filter>
              </defs>
              <rect width="900" height="360" fill="url(#bungalowSky)"/>
              <circle cx="710" cy="80" r="110" fill="url(#bungalowMoon)"/>
              <circle cx="710" cy="80" r="37" fill="#c9ad98" opacity=".23"/>
              <path d="M0 230Q130 190 265 235T520 218T900 218V360H0Z" fill="#080709"/>
              <g fill="#070609" stroke="#20141a" strokeWidth="4">
                <path d="M0 280V103L36 55L72 103V280ZM20 124L36 88L54 124V280H20Z"/>
                <path d="M825 290V82L864 25L900 82V290Z"/>
                <path d="M94 295V155L128 99L160 155V295Z"/>
                <path d="M760 296V170L790 120L820 170V296Z"/>
              </g>
              <g fill="#1a1116" stroke="#4a292e" strokeWidth="5">
                <path d="M208 190L450 42L692 190V323H208Z"/>
                <path d="M177 190L450 20L723 190L694 204L450 62L205 204Z" fill="#0c090d" stroke="#6e343b" strokeWidth="8"/>
                <path d="M270 192V118L450 72L630 118V192Z" fill="#24171c"/>
                <path d="M300 192V145L450 105L600 145V192Z" fill="#0b080c" stroke="#78464a" strokeWidth="3"/>
                <path d="M246 194H654V324H246Z" fill="url(#bungalowWall)"/>
                <path d="M390 324V235Q450 185 510 235V324Z" fill="#09070a" stroke="#9a6252" strokeWidth="5"/>
                <path d="M414 324V247Q450 212 486 247V324Z" fill="#1c1016" stroke="#4c282d" strokeWidth="3"/>
                <path d="M190 195H710V211H190Z" fill="#100b10" stroke="#4c292f" strokeWidth="3"/>
              </g>
              <g fill="#a34b43" opacity=".9" filter="url(#windowGlow)">
                <rect x="286" y="216" width="48" height="53"/><rect x="566" y="216" width="48" height="53"/>
                <rect x="390" y="142" width="34" height="39"/><rect x="476" y="142" width="34" height="39"/>
              </g>
              <g fill="#d58a62" opacity=".5">
                <rect x="292" y="220" width="36" height="45"/><rect x="572" y="220" width="36" height="45"/>
                <rect x="395" y="146" width="25" height="31"/><rect x="481" y="146" width="25" height="31"/>
              </g>
              <g fill="#080609" stroke="#593038" strokeWidth="3">
                <path d="M352 326V292L450 251L548 292V326Z"/>
                <path d="M80 320L82 266L101 255L119 266L121 320ZM760 323L764 271L783 260L801 271L805 323Z"/>
                <path d="M130 328L137 295L145 328ZM700 330L707 294L715 330Z"/>
              </g>
              <g fill="#b84746" opacity=".7">
                <path d="M0 326Q130 295 245 330T490 323T720 330T900 318V360H0Z"/>
                <path d="M377 360Q450 308 523 360Z" fill="#0b080a"/>
              </g>
              <g fill="none" stroke="#bb7772" strokeOpacity=".13" strokeWidth="20">
                <path d="M-30 280Q100 235 250 281T550 275T930 270"/>
                <path d="M-30 324Q130 285 270 325T560 320T930 316"/>
              </g>
            </svg>
          </div>
          <div className="table-haze haze-a" /><div className="table-haze haze-b" />
          <div className="seat-ring">
            {ringPlayers.map((player) => (
              <button
                key={player.id}
                className={`seat ${!player.alive ? 'seat-dead' : ''} ${!player.connected ? 'seat-away' : ''} ${player.id === snapshot.me.id ? 'seat-you' : ''} ${selectedTarget === player.id ? 'seat-selected' : ''} ${targetPlayers.some((target) => target.id === player.id) && (isRoleAction || isVotePhase) ? 'seat-targetable' : ''}`}
                style={{ left: `${player.x}%`, top: `${player.y}%` }}
                onClick={() => {
                  if (targetPlayers.some((target) => target.id === player.id) && (isRoleAction || isVotePhase)) setSelectedTarget(player.id);
                }}
                disabled={!targetPlayers.some((target) => target.id === player.id) || (!isRoleAction && !isVotePhase)}
                title={player.name}
              >
                <span className={`seat-avatar avatar-tone-${snapshot.players.findIndex((item) => item.id === player.id) % 6}`}>{avatarFor(player.avatar).face}</span>
                <span className="seat-name">{player.name}{player.id === snapshot.me.id ? ' · YOU' : ''}</span>
                <span className="seat-role">{!player.alive ? (ROLE_NAMES[player.role] || 'GHOST') : !player.connected ? 'AWAY' : player.isHost ? 'HOST' : 'SEATED'}</span>
                {selectedTarget === player.id && <span className="target-mark">✦</span>}
              </button>
            ))}
          </div>
          <div className="round-table" aria-label="The Hollow Table, an endless dark well">
            <div className="void-well" aria-hidden="true"><i className="void-ring void-ring-one" /><i className="void-ring void-ring-two" /><i className="void-ring void-ring-three" /><i className="void-core" /></div>
            <div className="table-emblem">✦</div>
            <div className="table-name">THE HOLLOW<br /><em>TABLE</em></div>
            <span className="table-center-caption">THE DARK HAS NO BOTTOM</span>
          </div>
          <div className="table-floor-label">{snapshot.players.filter((player) => player.alive).length} SOULS REMAIN</div>
        </section>

        <aside className="game-sidebar">
          <div className="identity-wrap">
            <button className="identity-toggle" onClick={() => setIdentityVisible((current) => !current)}>
              <span aria-hidden="true">{identityVisible ? '◉' : '◈'}</span>
              {identityVisible ? 'HIDE YOUR IDENTITY' : 'CHECK YOUR IDENTITY'}
            </button>
            {identityVisible && <section className="panel role-panel">
            <RolePlayingCard card={roleCard} faceUp compact />
            <h2>{ROLE_NAMES[snapshot.me.role] || 'Unknown'}</h2>
            <p>{snapshot.me.roleDescription}</p>
            {snapshot.me.role === 'mafia' && (
              <div className="mafia-team"><small>YOUR INNER CIRCLE</small><div className="mafia-member-list">{snapshot.me.mafiaTeam.map((member) => <div className={`mafia-member ${member.alive ? '' : 'member-fallen'}`} key={member.id}><span>{avatarFor(member.avatar).face}</span><strong>{member.name}{member.id === snapshot.me.id ? ' · YOU' : ''}</strong><small>{member.alive ? 'ALIVE' : 'FALLEN'}</small></div>)}</div>
                <div className="mafia-coordination">
                  {snapshot.mafiaChoices?.map((choice) => (
                    <div key={choice.id}><span>{choice.name}</span><strong>{choice.targetName ? `→ ${choice.targetName}` : choice.connected ? 'CHOOSING' : 'OFFLINE · SKIPPED'}</strong></div>
                  ))}
                  <p>{snapshot.actionProgress?.mafiaTargetState === 'conflict' ? 'CONFLICTING TARGETS · FINAL WINDOW MAY OPEN' : snapshot.actionProgress?.mafiaTargetState === 'single' ? 'A TARGET HAS BEEN SUBMITTED' : 'WAITING FOR A TARGET'}</p>
                </div>
              </div>
            )}
            {snapshot.me.privateResults?.length > 0 && (
              <div className="private-results"><small>PRIVATE INVESTIGATION</small>{snapshot.me.privateResults.map((result) => <div key={result.id} className={`private-result result-${result.kind}`}>{result.text}</div>)}</div>
            )}
            </section>}
          </div>

          {isDiscussion && snapshot.me.alive && (
            <section className="panel readiness-panel">
              <div className="panel-kicker">THE DISCUSSION FLOOR</div>
              <div className="readiness-heading"><h3>Ready to vote?</h3><strong>{snapshot.discussionReadiness.ready}/{snapshot.discussionReadiness.required}</strong></div>
              <div className="readiness-track"><span style={{ width: `${snapshot.discussionReadiness.required ? (snapshot.discussionReadiness.ready / snapshot.discussionReadiness.required) * 100 : 0}%` }} /></div>
              <button className={`readiness-button ${snapshot.me.readyToVote ? 'is-ready' : ''}`} onClick={onReadyToVote}>
                {snapshot.me.readyToVote ? '✓ YOU ARE READY · UNDO' : 'I AM READY TO VOTE'}
              </button>
              <p>{snapshot.discussionReadiness.ready >= snapshot.discussionReadiness.required ? 'Everyone is ready. Voting is now open.' : 'Mark yourself ready when you have finished speaking. Once everyone is ready, voting opens immediately; otherwise the discussion timer remains in control.'}</p>
            </section>
          )}

          {isUndertakerWindow && (
            <section className="panel action-panel undertaker-action-panel">
              <div className="panel-kicker">PRIVATE · THE GRAVEYARD</div>
              <h3>Choose an identity to inherit</h3>
              {snapshot.me.myActionSubmitted ? (
                <p className="undertaker-private-status">Your decision is sealed for tonight. No one else is told whether you accepted or declined.</p>
              ) : undertakerOptions.length > 0 ? (
                <>
                  <p className="action-subtext">Your power may be used once. Choose one departed player. They remain eliminated; you keep your own name and seat. The inherited role starts next night. This decision is visible only to you.</p>
                  <div className="target-list undertaker-target-list">
                    {undertakerOptions.map((target) => (
                      <button key={target.id} className={`target-option ${undertakerTarget === target.id ? 'chosen' : ''}`} onClick={() => setUndertakerTarget(target.id)}>
                        <span className="target-avatar">{avatarFor(target.avatar).face}</span><span>{target.name}</span><i>{undertakerTarget === target.id ? '✦' : '○'}</i>
                      </button>
                    ))}
                  </div>
                  <button className="primary-button full-button" onClick={() => actUndertaker(undertakerTarget, false)} disabled={!undertakerTarget}>INHERIT THIS IDENTITY</button>
                  <button className="outline-button full-button undertaker-decline-button" onClick={() => actUndertaker(null, true)}>NOT THIS NIGHT · KEEP MY POWER</button>
                </>
              ) : (
                <p className="undertaker-private-status">The graveyard has no eligible identity yet. Your power remains unused. The public call is made every night regardless.</p>
              )}
            </section>
          )}

          {(isRoleAction || isVotePhase) && (
            <section className="panel action-panel">
              <div className="panel-kicker">{isNight ? 'PRIVATE NIGHT ACTION' : 'CAST YOUR VOTE'}</div>
              <h3>{isNight ? 'Choose one living player' : isTie ? 'Choose between the accused' : 'Who should leave the table?'}</h3>
              {isTie && <p className="action-subtext">Choose only between the names still accused.</p>}
              {isNight && snapshot.me.role === 'mafia' && <p className="action-subtext">{isInPerson ? 'Choose a living target. Every connected Mafia phone must submit. Any disagreement opens the 15-second CLASH OF OPINIONS window; if the Mafias still disagree, there is no murder.' : 'Choose a target. If only one target is submitted, that player is selected; conflicting targets earn one 15-second extension. You may revise your choice until the night ends.'}</p>}
              {isNight && snapshot.me.role === 'angel' && <p className="action-subtext">{isInPerson ? 'Choose one living soul to protect. Your first confirmation seals the choice and advances the night immediately.' : 'Choose who to protect. You may change your protection until the night ends.'}</p>}
              {isNight && snapshot.me.role === 'sheriff' && <p className="action-subtext">{isInPerson ? 'Choose one living soul to investigate. Your result appears only on this phone, then the night advances.' : 'Your first investigation is final. The result will appear privately in a full-screen reveal at dawn.'}</p>}
              {isInPerson && snapshot.me.role === 'mafia' && <div className="in-person-action-progress"><span>{snapshot.actionProgress?.submitted || 0} / {snapshot.actionProgress?.required || 0} MAFIA SUBMISSIONS</span><i><b style={{ width: `${snapshot.actionProgress?.required ? (snapshot.actionProgress.submitted / snapshot.actionProgress.required) * 100 : 0}%` }} /></i></div>}
              {targetPlayers.length > 0 ? (
                <div className="target-list">
                  {targetPlayers.map((player) => (
                    <button key={player.id} className={`target-option ${selectedTarget === player.id ? 'chosen' : ''}`} onClick={() => setSelectedTarget(player.id)}>
                      <span className="target-avatar">{avatarFor(player.avatar).face}</span><span>{player.name}</span><i>{selectedTarget === player.id ? '✦' : '○'}</i>
                    </button>
                  ))}
                </div>
              ) : <p className="empty-targets">No valid targets are available.</p>}
              <button className="primary-button full-button" onClick={isNight ? actNight : vote} disabled={!selectedTarget || (isNight && isInPerson && ['angel', 'sheriff'].includes(snapshot.me.role) && snapshot.me.myActionSubmitted) || (isNight && !isInPerson && snapshot.me.role === 'sheriff' && snapshot.me.myActionSubmitted)}>{isNight && isInPerson && snapshot.me.myActionSubmitted && snapshot.me.role === 'angel' ? 'PROTECTION SEALED' : isNight && snapshot.me.myActionSubmitted && snapshot.me.role === 'sheriff' ? 'INVESTIGATION LOCKED' : isNight && isInPerson && snapshot.me.role === 'angel' ? 'SEAL PROTECTION' : isNight && isInPerson && snapshot.me.role === 'sheriff' ? 'SEAL INVESTIGATION' : snapshot.me.myActionSubmitted ? (isInPerson ? 'UPDATE TARGET' : 'UPDATE ACTION') : isNight ? (isInPerson ? 'SUBMIT TARGET' : 'CONFIRM ACTION') : 'SUBMIT / CHANGE VOTE'}</button>

            </section>
          )}

          {isNight && !isRoleAction && snapshot.me.alive && <div className={`panel waiting-panel ${isInPerson ? 'in-person-waiting-panel' : ''}`}><div className="waiting-orbit">☾</div><h3>{isInPerson ? 'KEEP YOUR EYES CLOSED' : 'The town is asleep'}</h3><p>{isInPerson ? 'The house keeps the same public sequence every night. Keep your phone silent and your eyes closed; private actions appear only on the player’s own screen.' : 'Wait for the morning bell. The night actions are hidden from you.'}</p></div>}
          {!snapshot.me.alive && <div className="panel ghost-observer-panel"><div className="waiting-orbit">👁</div><h3>You are beyond the table</h3><p>The dead cannot vote, chat, or take night actions. Watch silently until the final verdict.</p></div>}

          {snapshot.me.isHost && (
            <div className="host-controls-wrap">
              <button className="host-controls-toggle" onClick={() => setHostControlsOpen((open) => !open)} aria-expanded={hostControlsOpen}>
                <span>♜</span> HOST CONTROLS <strong>{hostControlsOpen ? '− CLOSE' : '+ OPEN'}</strong>
              </button>
              {hostControlsOpen && (
                <section className="panel host-panel">
                  <div className="panel-header"><div><div className="panel-kicker">HOST AUTHORITY</div><h2>Manage the table</h2></div><span className="panel-symbol">♜</span></div>
                  <p className="host-panel-note">Remove a guest who is disrupting the game or cannot return. Their role stays secret until the final reveal.</p>
                  <div className="host-player-list">
                    {snapshot.players.filter((player) => player.id !== snapshot.me.id).map((player) => (
                      <div className="host-player-row" key={player.id}>
                        <span className="host-player-avatar">{avatarFor(player.avatar).face}</span>
                        <span className="host-player-name">{player.name}<small>{!player.connected ? 'OFFLINE' : !player.alive ? 'FALLEN' : 'IN GAME'}</small></span>
                        <button className="host-kick-button" onClick={() => onKickPlayer(player)}>REMOVE</button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {isInPerson ? (
            <section className="panel chat-panel in-person-room-reminder">
              <div className="panel-kicker">THE GATHERING IS PHYSICAL</div>
              <h2>THE ROOM IS YOUR VOICE</h2>
              <p>Speak across the table during daylight. At night, keep every phone silent and follow only the private call meant for your role.</p>
              <span>NO LIVEKIT · NO PHONE CHAT · ONE NARRATOR DEVICE</span>
            </section>
          ) : (
          <section className="panel chat-panel">
            <div className="panel-header"><div><div className="panel-kicker">LIVE CONVERSATION</div><h2>{chatTitle}</h2></div><span className="panel-symbol">☷</span></div>
            <div className={isNight && !identityVisible ? 'voice-concealed' : ''}>
              <Suspense fallback={<div className="voice-loading" role="status">PREPARING PRIVATE VOICE…</div>}>
                <VoiceRoom code={snapshot.code} token={session?.token} phase={snapshot.phase} round={snapshot.round} enabled={voiceEnabled} />
              </Suspense>
            </div>
            <div className="chat-log">
              {snapshot.chat.length === 0 && <div className="chat-empty">The walls are listening. Be the first to speak.</div>}
              {snapshot.chat.map((message) => (
                <div className={`chat-message ${message.playerId === snapshot.me.id ? 'chat-own' : ''}`} key={message.id}>
                  <span className="chat-avatar">{avatarFor(message.avatar).face}</span>
                  <div><small>{message.playerName}</small><p>{message.text}</p></div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input value={messageText} onChange={(event) => setMessageText(event.target.value.slice(0, 350))} placeholder={snapshot.me.alive ? 'Whisper to the table…' : 'The dead cannot speak…'} disabled={!snapshot.me.alive || !(isDiscussion || isVoting || isTie || (isNight && snapshot.me.role === 'mafia' && snapshot.me.roleActive !== false))} />
              <button type="submit" disabled={!messageText.trim() || !snapshot.me.alive}>↗</button>
            </form>
          </section>
          )}
        </aside>
      </div>

    </section>
  );
}

function EndGame({ snapshot, onLeave, onRematch, isHost, busy }) {
  const winningPlayers = snapshot.players.filter((player) => snapshot.winner === 'mafia' ? player.role === 'mafia' : player.role !== 'mafia');
  const winnerLabel = snapshot.winner === 'mafia' ? 'THE MAFIA WIN' : 'THE TOWN WINS';
  return (
    <section className={`endgame-layout endgame-${snapshot.winner || 'town'}`}>
      <div className="endgame-embers" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
      <div className="eyebrow"><span /> THE FINAL VERDICT <span /></div>
      <div className={`endgame-seal ${snapshot.winner === 'mafia' ? 'seal-mafia' : 'seal-town'}`}>{snapshot.winner === 'mafia' ? '☠' : '✧'}</div>
      <div className={`winner-banner ${snapshot.winner === 'mafia' ? 'winner-mafia' : 'winner-town'}`}>
        <span>THE WINNING FACTION</span>
        <strong>{winnerLabel}</strong>
        <small>{winningPlayers.length} SOUL{winningPlayers.length === 1 ? '' : 'S'} CLAIMED THE VICTORY</small>
      </div>
      <h1>{snapshot.winner === 'mafia' ? 'The house belongs to the Mafia.' : 'The town has broken the house’s curse.'}</h1>
      <p>{snapshot.announcement?.text}</p>

      <section className="winning-roster panel">
        <div className="panel-kicker">THE PLAYERS WHO WON</div>
        <h2>{snapshot.winner === 'mafia' ? 'The House’s Hidden Masters' : 'The Souls Who Saved the Town'}</h2>
        <div className="winning-roster-grid">
          {winningPlayers.map((player) => (
            <div className={`winning-player ${player.role === 'mafia' ? 'winning-mafia' : ''}`} key={player.id}>
              <span className="winning-avatar">{avatarFor(player.avatar).face}</span>
              <strong>{player.name}</strong>
              <small>{ROLE_NAMES[player.role] || player.role}</small>
              <em>{player.alive ? 'STILL STANDING' : 'FELL BEFORE THE VERDICT'}</em>
            </div>
          ))}
        </div>
      </section>

      {snapshot.lastDeathAnnouncement && (
        <div className={`announcement announcement-${snapshot.lastDeathAnnouncement.accent || 'red'} final-death-report`}>
          <div className="announcement-side">✦</div>
          <div><div className="announcement-kicker">FINAL REPORT · {snapshot.lastDeathAnnouncement.kind === 'murder' ? 'MURDER' : snapshot.lastDeathAnnouncement.kind === 'departure' ? 'DEPARTURE' : 'ELIMINATION'}</div><h2>{snapshot.lastDeathAnnouncement.title}</h2><p>{snapshot.lastDeathAnnouncement.text}</p></div>
          <div className="announcement-side">✦</div>
        </div>
      )}
      <section className="panel reveal-panel">
        <div className="panel-kicker">EVERY SECRET, REVEALED</div>
        <h2>The final table · every soul accounted for</h2>
        <div className="reveal-grid">
          {snapshot.players.map((player) => (
            <div className={`reveal-player ${player.role === 'mafia' ? 'reveal-mafia' : ''} ${player.alive ? 'reveal-living' : 'reveal-fallen'}`} key={player.id}>
              <span className="reveal-avatar">{avatarFor(player.avatar).face}</span>
              <span className="reveal-name">{player.name}</span>
              <span className="reveal-role">{ROLE_NAMES[player.role] || player.role}</span>
              <span className={`reveal-state ${player.alive ? 'still-alive' : ''}`}>{player.alive ? 'SURVIVED' : 'FALLEN'}</span>
            </div>
          ))}
        </div>
      </section>
      {isHost ? (
        <button className="primary-button end-button" onClick={onRematch} disabled={busy}>{busy ? 'GATHERING THE TABLE…' : 'PLAY AGAIN WITH THIS TABLE'} <span>↗</span></button>
      ) : (
        <p className="rematch-waiting" role="status">The host can reopen this table for a rematch. Your seat remains available while you stay connected.</p>
      )}
      <button className="outline-button end-button-secondary" onClick={onLeave}>RETURN TO THE ENTRANCE</button>
    </section>
  );
}

export default App;
