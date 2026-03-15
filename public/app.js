/* ═══════════════════════════════════════════════════════
   80s Music Quiz — Game Logic
═══════════════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  songs: [],
  players: [
    { name: 'Player 1', score: 0 },
    { name: 'Player 2', score: 0 },
  ],
  roundsPerPlayer: 5,
  totalRounds: 10,
  currentRound: 0,          // 0-based global round index
  currentPlayerIndex: 0,    // 0 or 1
  questions: [],             // shuffled songs for this game
  currentQuestion: null,
  canReplay: true,
  audioPlayed: false,
  timerInterval: null,
  timerSeconds: 15,
  timerRunning: false,
  audio: null,
  progressInterval: null,
  answered: false,
  preloadAudio: null,        // preloaded Audio object
  preloadForId: null,        // song.id of the preloaded audio
  doubleActive: false,       // double-down chosen for current turn
};

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const show  = el => el.classList.remove('hidden');
const hide  = el => el.classList.add('hidden');

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`screen-${name}`);
  if (el) el.classList.add('active');
}

// ── Shuffle (Fisher-Yates) ────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Double Down ──────────────────────────────────────────────────────────────

function activateDouble() {
  const p = state.players[state.currentPlayerIndex];
  if (p.doubleUsed) return;

  const btn = $('btn-double');
  if (btn.classList.contains('activated')) {
    // Toggle off
    btn.classList.remove('activated');
    btn.querySelector('span').textContent = '⚡ DOUBLE DOWN';
    state.doubleActive = false;
  } else {
    // Toggle on
    btn.classList.add('activated');
    btn.querySelector('span').textContent = '⚡ DOUBLE ACTIVE!';
    state.doubleActive = true;
  }
}

// ── Preloading ───────────────────────────────────────────────────────────────

function preloadSong(roundIndex) {
  if (roundIndex < 0 || roundIndex >= state.totalRounds) return;
  const song = state.questions[roundIndex];
  if (!song) return;
  if (state.preloadForId === song.id) return; // already preloaded

  if (state.preloadAudio) {
    state.preloadAudio.src = '';
    state.preloadAudio = null;
    state.preloadForId = null;
  }

  const audio = new Audio(`snippets/${song.filename}`);
  audio.preload = 'auto';
  state.preloadAudio = audio;
  state.preloadForId = song.id;
}

// ── Init ─────────────────────────────────────────────────────────────────────

function attachListeners() {
  $('btn-start').addEventListener('click', startGame);
  $('btn-ready').addEventListener('click', startQuestion);
  $('btn-double').addEventListener('click', activateDouble);
  $('btn-play').addEventListener('click', playSnippet);
  $('btn-replay').addEventListener('click', replaySnippet);
  $('btn-next').addEventListener('click', nextRound);
  $('btn-play-again').addEventListener('click', resetToWelcome);
}

async function init() {
  try {
    const res  = await fetch('songs.json');
    const data = await res.json();
    state.songs = data.songs;
  } catch (e) {
    console.error('Failed to load songs.json:', e);
    alert('Could not load songs.json.\nMake sure you are running this from a local HTTP server.\n\n  cd public && python3 -m http.server 8090');
    return;
  }

  showScreen('welcome');
}

// ── Start Game ───────────────────────────────────────────────────────────────

function startGame() {
  const name1 = $('player1-name').value.trim() || 'Player 1';
  const name2 = $('player2-name').value.trim() || 'Player 2';
  const rounds = parseInt($('rounds-select').value, 10);

  const category = $('category-select').value;

  state.players[0].name       = name1;
  state.players[0].score      = 0;
  state.players[0].doubleUsed = false;
  state.players[1].name       = name2;
  state.players[1].score      = 0;
  state.players[1].doubleUsed = false;
  state.roundsPerPlayer  = rounds;
  state.totalRounds      = rounds * 2;
  state.currentRound     = 0;
  state.currentPlayerIndex = 0;
  state.category = category;

  // Filter pool by category
  const pool = category === 'all'
    ? state.songs
    : state.songs.filter(s => s.category === category);

  if (pool.length < state.totalRounds) {
    alert(`Not enough songs in this category!\nNeed ${state.totalRounds}, only ${pool.length} available.\nTry fewer rounds or a different category.`);
    return;
  }
  state.questions = shuffle(pool).slice(0, state.totalRounds);

  showTurnScreen();
}

// ── Turn Screen ──────────────────────────────────────────────────────────────

function showTurnScreen() {
  const p = state.players[state.currentPlayerIndex];

  $('turn-player-name').textContent = p.name;
  $('turn-round-info').textContent  =
    `Round ${state.currentRound + 1} of ${state.totalRounds}`;
  $('turn-p1-name').textContent  = state.players[0].name;
  $('turn-p1-score').textContent = state.players[0].score;
  $('turn-p2-name').textContent  = state.players[1].name;
  $('turn-p2-score').textContent = state.players[1].score;

  // Highlight active player
  $('turn-scores').querySelectorAll('.score-box').forEach((box, i) => {
    box.classList.toggle('active-player', i === state.currentPlayerIndex);
  });

  // Double-down button: show only if this player hasn't used it yet
  const doubleBtn = $('btn-double');
  if (p.doubleUsed) {
    doubleBtn.classList.add('used');
    doubleBtn.disabled = true;
    doubleBtn.querySelector('span').textContent = '⚡ DOUBLE USED';
  } else {
    doubleBtn.classList.remove('used', 'activated');
    doubleBtn.disabled = false;
    doubleBtn.querySelector('span').textContent = '⚡ DOUBLE DOWN';
  }

  preloadSong(state.currentRound);
  showScreen('turn');
}

// ── Start Question ───────────────────────────────────────────────────────────

function startQuestion() {
  const song = state.questions[state.currentRound];
  state.currentQuestion = song;
  state.canReplay   = true;
  state.audioPlayed = false;
  state.answered    = false;
  stopTimer();

  // Lock in the double-down choice and mark it used
  if (state.doubleActive) {
    state.players[state.currentPlayerIndex].doubleUsed = true;
  }
  const banner = $('double-active-banner');
  if (state.doubleActive) banner.classList.remove('hidden');
  else banner.classList.add('hidden');

  const p = state.players[state.currentPlayerIndex];

  // Header
  $('q-player-icon').textContent = state.currentPlayerIndex === 0 ? '🎸' : '🎹';
  $('q-player-name').textContent = p.name;
  $('q-round-num').textContent   = state.currentRound + 1;
  $('q-total-rounds').textContent = state.totalRounds;
  $('q-score').textContent       = p.score;

  // Reset audio controls
  $('vinyl').classList.remove('spinning');
  $('vinyl-label') && ($('vinyl').querySelector('.vinyl-label').textContent = '?');
  $('btn-play').disabled = false;
  $('btn-play-icon').textContent = '▶';
  $('btn-play-text').textContent = 'PLAY SNIPPET';
  hide($('audio-progress-wrap'));
  $('audio-progress-bar').style.width = '0%';
  hide($('btn-replay'));
  hide($('options-zone'));

  // Cleanup previous audio
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  clearInterval(state.progressInterval);

  showScreen('question');
}

// ── Play Snippet ─────────────────────────────────────────────────────────────

function playSnippet() {
  const song = state.currentQuestion;
  if (!song) return;

  $('btn-play').disabled = true;
  $('btn-play-icon').textContent = '♫';
  $('btn-play-text').textContent = 'LISTENING…';
  $('vinyl').classList.add('spinning');
  show($('audio-progress-wrap'));

  let audio;
  if (state.preloadForId === song.id && state.preloadAudio) {
    audio = state.preloadAudio;
    state.preloadAudio = null;
    state.preloadForId = null;
  } else {
    audio = new Audio(`snippets/${song.filename}`);
  }
  state.audio = audio;

  audio.onerror = () => {
    console.warn(`Audio not found: ${song.filename}`);
    $('vinyl').classList.remove('spinning');
    $('btn-play-icon').textContent = '⚠';
    $('btn-play-text').textContent = 'FILE MISSING';
    // Still show options so game can continue
    showOptionsAndStartTimer();
  };

  const duration = (song.duration || 5) * 1000; // ms
  const startTime = Date.now();

  // Progress bar
  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const pct = Math.min((elapsed / duration) * 100, 100);
    $('audio-progress-bar').style.width = `${pct}%`;
    if (pct >= 100) clearInterval(state.progressInterval);
  }, 50);

  audio.play().catch(err => {
    console.warn('Audio play error:', err);
  });

  // Stop after duration
  const stopTimeout = setTimeout(() => {
    audio.pause();
    audio.currentTime = 0;
    clearInterval(state.progressInterval);
    $('audio-progress-bar').style.width = '100%';
    $('vinyl').classList.remove('spinning');
    state.audioPlayed = true;

    // Show replay button
    if (state.canReplay) {
      show($('btn-replay'));
      $('btn-replay').disabled = false;
    }

    showOptionsAndStartTimer();
  }, duration);

  // If audio ends before duration (short file)
  audio.onended = () => {
    clearTimeout(stopTimeout);
    clearInterval(state.progressInterval);
    $('audio-progress-bar').style.width = '100%';
    $('vinyl').classList.remove('spinning');
    state.audioPlayed = true;
    if (state.canReplay) {
      show($('btn-replay'));
      $('btn-replay').disabled = false;
    }
    showOptionsAndStartTimer();
  };
}

function replaySnippet() {
  if (!state.canReplay) return;
  state.canReplay = false;
  $('btn-replay').disabled = true;
  $('btn-replay').textContent = '↺ REPLAYED';

  // Reset timer while replaying
  stopTimer();
  hide($('options-zone'));

  // Replay
  const song = state.currentQuestion;
  const audio = new Audio(`snippets/${song.filename}`);
  state.audio = audio;

  show($('audio-progress-wrap'));
  $('audio-progress-bar').style.width = '0%';
  $('vinyl').classList.add('spinning');
  $('btn-play-icon').textContent = '♫';
  $('btn-play-text').textContent = 'REPLAYING…';

  const duration = (song.duration || 5) * 1000;
  const startTime = Date.now();

  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const pct = Math.min((elapsed / duration) * 100, 100);
    $('audio-progress-bar').style.width = `${pct}%`;
    if (pct >= 100) clearInterval(state.progressInterval);
  }, 50);

  audio.play().catch(() => {});

  const onDone = () => {
    audio.pause();
    clearInterval(state.progressInterval);
    $('audio-progress-bar').style.width = '100%';
    $('vinyl').classList.remove('spinning');
    $('btn-play-icon').textContent = '✓';
    $('btn-play-text').textContent = 'SNIPPET PLAYED';
    showOptionsAndStartTimer();
  };

  setTimeout(onDone, duration);
  audio.onended = () => { clearTimeout(); onDone(); };
}

// ── Options ──────────────────────────────────────────────────────────────────

function buildOptions(correctSong) {
  // Wrong options: prefer same category so the correct answer isn't obvious
  let pool = state.songs.filter(s => s.id !== correctSong.id);
  if (state.category !== 'all') {
    const sameCategory = pool.filter(s => s.category === correctSong.category);
    if (sameCategory.length >= 2) pool = sameCategory;
  }
  const wrong = shuffle(pool).slice(0, 2);

  const options = shuffle([
    { song: correctSong, correct: true },
    { song: wrong[0],    correct: false },
    { song: wrong[1],    correct: false },
  ]);
  return options;
}

function showOptionsAndStartTimer() {
  const song    = state.currentQuestion;
  const options = buildOptions(song);
  state.currentOptions = options;

  const grid = $('options-grid');
  grid.innerHTML = '';
  const letters = ['A', 'B', 'C'];

  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.dataset.index = i;
    btn.innerHTML = `
      <span class="option-letter">${letters[i]}</span>
      <span class="option-text">${opt.song.title} — ${opt.song.artist}</span>
      <span class="option-year">${opt.song.year}</span>
    `;
    btn.addEventListener('click', () => selectAnswer(i));
    grid.appendChild(btn);
  });

  $('btn-play-icon').textContent = '✓';
  $('btn-play-text').textContent = 'SNIPPET PLAYED';
  show($('options-zone'));
  startTimer();
}

// ── Answer Selection ──────────────────────────────────────────────────────────

function selectAnswer(index) {
  // Accept the click if not yet answered, OR if we are still inside the
  // grace window (player clicked before the deadline but timeOut fired first)
  const withinGrace = state.timerDeadline &&
    (Date.now() - state.timerDeadline) <= TIMER_GRACE_MS;
  if (state.answered && !withinGrace) return;
  state.answered = true;
  stopTimer();

  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }

  const options = state.currentOptions;
  const chosen  = options[index];
  const isCorrect = chosen.correct;

  // Reveal all options
  const btns = $('options-grid').querySelectorAll('.option-btn');
  btns.forEach((btn, i) => {
    btn.disabled = true;
    if (options[i].correct) {
      btn.classList.add(i === index ? 'correct' : 'reveal');
    } else if (i === index) {
      btn.classList.add('wrong');
    }
  });

  // Update score (double-down: +2 correct, -1 wrong)
  if (state.doubleActive) {
    state.players[state.currentPlayerIndex].score += isCorrect ? 2 : -1;
  } else if (isCorrect) {
    state.players[state.currentPlayerIndex].score += 1;
  }

  // Show result after brief pause
  setTimeout(() => showResult(isCorrect), 900);
}

// Time-out: auto-select wrong
function timeOut() {
  if (state.answered) return;
  state.answered = true;
  stopTimer();

  if (state.audio) { state.audio.pause(); state.audio = null; }

  // Reveal correct answer
  const options = state.currentOptions || [];
  const btns = $('options-grid').querySelectorAll('.option-btn');
  btns.forEach((btn, i) => {
    btn.disabled = true;
    if (options[i] && options[i].correct) btn.classList.add('reveal');
  });

  // Double-down penalty on timeout
  if (state.doubleActive) {
    state.players[state.currentPlayerIndex].score -= 1;
  }

  setTimeout(() => showResult(false), 900);
}

// ── Timer ────────────────────────────────────────────────────────────────────

const TIMER_DURATION = 15;
const TIMER_GRACE_MS = 300; // window after display hits 0 where clicks still count

function startTimer() {
  state.timerSeconds  = TIMER_DURATION;
  state.timerDeadline = Date.now() + TIMER_DURATION * 1000;
  state.timerRunning  = true;
  updateTimerDisplay();

  // Poll every 100ms so the display stays accurate regardless of drift
  state.timerInterval = setInterval(() => {
    const remaining = Math.ceil((state.timerDeadline - Date.now()) / 1000);
    if (remaining !== state.timerSeconds) {
      state.timerSeconds = remaining;
      updateTimerDisplay();
    }
    if (state.timerSeconds <= 0) {
      stopTimer();
      // Grace period: defer timeOut() so any click already in the event
      // queue (player tapped just before the deadline) is processed first.
      setTimeout(timeOut, TIMER_GRACE_MS);
    }
  }, 100);
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerRunning = false;
}

function updateTimerDisplay() {
  const display = $('timer-display');
  const bar     = $('timer-bar');
  const secs    = Math.max(0, state.timerSeconds);
  const urgent  = secs <= 5;

  display.textContent = secs;
  display.classList.toggle('urgent', urgent);
  bar.style.width    = `${(secs / 15) * 100}%`;
  bar.classList.toggle('urgent', urgent);
}

// ── Result Screen ─────────────────────────────────────────────────────────────

function showResult(isCorrect) {
  const song = state.currentQuestion;
  const banner = $('result-banner');

  banner.classList.remove('correct', 'wrong');
  banner.classList.add(isCorrect ? 'correct' : 'wrong');
  $('result-icon').textContent = isCorrect ? '🎉' : '💀';
  $('result-text').textContent = isCorrect ? 'CORRECT!' : 'WRONG!';

  $('result-song-title').textContent  = song.title;
  $('result-song-artist').textContent = song.artist;
  $('result-song-year').textContent   = song.year;

  $('result-p1-name').textContent  = state.players[0].name;
  $('result-p1-score').textContent = state.players[0].score;
  $('result-p2-name').textContent  = state.players[1].name;
  $('result-p2-score').textContent = state.players[1].score;

  // Highlight active player score box
  ['result-p1-box', 'result-p2-box'].forEach((id, i) => {
    $(id).classList.toggle('active-player', i === state.currentPlayerIndex);
  });

  // Button label
  const isLastRound = state.currentRound >= state.totalRounds - 1;
  $('btn-next').querySelector('span').textContent =
    isLastRound ? 'SEE FINAL SCORES ▶' : 'NEXT ROUND ▶';

  // Preload next song while player reads the result screen
  preloadSong(state.currentRound + 1);

  showScreen('result');
}

// ── Next Round ────────────────────────────────────────────────────────────────

function nextRound() {
  state.currentRound++;
  state.doubleActive = false;

  if (state.currentRound >= state.totalRounds) {
    showFinalScore();
    return;
  }

  // Alternate players
  state.currentPlayerIndex = state.currentRound % 2;
  showTurnScreen();
}

// ── Final Score ───────────────────────────────────────────────────────────────

function showFinalScore() {
  const p1 = state.players[0];
  const p2 = state.players[1];

  $('final-p1-name').textContent  = p1.name;
  $('final-p1-score').textContent = p1.score;
  $('final-p2-name').textContent  = p2.name;
  $('final-p2-score').textContent = p2.score;

  let winnerText, winnerIcon;
  if (p1.score > p2.score) {
    winnerText = `🎸 ${p1.name} WINS!`;
    winnerIcon = '🏆';
    $('final-p1-box').classList.add('winner');
    $('final-p2-box').classList.remove('winner');
  } else if (p2.score > p1.score) {
    winnerText = `🎹 ${p2.name} WINS!`;
    winnerIcon = '🏆';
    $('final-p2-box').classList.add('winner');
    $('final-p1-box').classList.remove('winner');
  } else {
    winnerText = "IT'S A TIE!";
    winnerIcon = '🤝';
    $('final-p1-box').classList.remove('winner');
    $('final-p2-box').classList.remove('winner');
  }

  $('winner-icon').textContent = winnerIcon;
  $('winner-text').textContent = winnerText;

  showScreen('final');
}

// ── Play Again ────────────────────────────────────────────────────────────────

function resetToWelcome() {
  if (state.audio) { state.audio.pause(); state.audio = null; }
  if (state.preloadAudio) { state.preloadAudio.src = ''; state.preloadAudio = null; }
  state.preloadForId = null;
  stopTimer();
  clearInterval(state.progressInterval);
  showScreen('welcome');
}

// ── Big Mode ("I'm Old") ──────────────────────────────────────────────────────

function initBigMode() {
  const isBig = localStorage.getItem('bigMode') === '1';
  setBigMode(isBig);
  $('btn-old-mode').addEventListener('click', () => {
    setBigMode(!document.documentElement.classList.contains('big-mode'));
  });
}

function setBigMode(on) {
  document.documentElement.classList.toggle('big-mode', on);
  $('old-mode-label').textContent = on ? 'NORMAL' : 'MAGNIFY';
  localStorage.setItem('bigMode', on ? '1' : '0');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  attachListeners();
  initBigMode();
  init();
});
