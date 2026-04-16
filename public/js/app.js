(function () {
  var STORAGE_KEY = 'betweenUs_sessionToken';
  var NAME_KEY = 'betweenUs_name';

  var socket = io({
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
  });

  var sessionToken = localStorage.getItem(STORAGE_KEY) || null;
  var myName = localStorage.getItem(NAME_KEY) || '';
  var myIndex = -1;
  var roomCode = '';
  var partnerName = '';
  var currentCardId = null;
  var currentBoard = [];
  var firingRevealed = false;
  var firingTotal = 5;
  var firingIndex = 0;
  var hasResumed = false;

  // ── DOM refs ──
  var screens = {
    welcome: document.getElementById('screen-welcome'),
    lobby: document.getElementById('screen-lobby'),
    board: document.getElementById('screen-board'),
    waiting: document.getElementById('screen-waiting'),
    firing: document.getElementById('screen-firing'),
    end: document.getElementById('screen-end')
  };

  var nameInput = document.getElementById('my-name');
  var btnCreate = document.getElementById('btn-create');
  var codeInput = document.getElementById('room-code-input');
  var btnJoin = document.getElementById('btn-join');
  var welcomeError = document.getElementById('welcome-error');

  var displayCode = document.getElementById('display-code');
  var lobbyPlayers = document.getElementById('lobby-players');
  var btnStartGame = document.getElementById('btn-start-game');

  var boardMyName = document.getElementById('board-my-name');
  var boardMyCount = document.getElementById('board-my-count');
  var cardGrid = document.getElementById('card-grid');

  var questionModal = document.getElementById('question-modal');
  var modalCard = document.getElementById('modal-card');
  var modalCategory = document.getElementById('modal-category');
  var modalQuestion = document.getElementById('modal-question');
  var modalSkip = document.getElementById('modal-skip');
  var modalKeep = document.getElementById('modal-keep');

  var transitionOverlay = document.getElementById('transition-overlay');
  var transitionTitle = document.getElementById('transition-title');
  var transitionSub = document.getElementById('transition-sub');
  var transitionBtn = document.getElementById('transition-btn');

  var firingWho = document.getElementById('firing-who');
  var firingCard = document.getElementById('firing-card');
  var firingCategory = document.getElementById('firing-category');
  var firingQuestionText = document.getElementById('firing-question-text');
  var firingRevealHint = document.getElementById('firing-reveal-hint');
  var firingProgress = document.getElementById('firing-progress');
  var firingNextBtn = document.getElementById('firing-next-btn');

  var btnPlayAgain = document.getElementById('btn-play-again');
  var disconnectModal = document.getElementById('disconnect-modal');

  // ── Session storage helpers ──
  function saveSession(token) {
    sessionToken = token;
    localStorage.setItem(STORAGE_KEY, token);
  }

  function clearSession() {
    sessionToken = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  function saveName(name) {
    myName = name;
    localStorage.setItem(NAME_KEY, name);
  }

  // ── Screen management ──
  function showScreen(name) {
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.remove('active');
    });
    screens[name].classList.add('active');
    // Close any open modals
    questionModal.classList.remove('active');
    transitionOverlay.classList.remove('active');
  }

  // ── Welcome screen ──
  function checkWelcome() {
    var name = nameInput.value.trim();
    btnCreate.disabled = !name;
    var code = codeInput.value.trim();
    btnJoin.disabled = !code;
  }

  if (myName) nameInput.value = myName;
  checkWelcome();

  nameInput.addEventListener('input', checkWelcome);
  codeInput.addEventListener('input', function () {
    codeInput.value = codeInput.value.toUpperCase();
    checkWelcome();
  });

  btnCreate.addEventListener('click', function () {
    var name = nameInput.value.trim();
    if (!name) return;
    saveName(name);
    welcomeError.textContent = '';
    socket.emit('create-room', name, function (res) {
      if (res.success) {
        roomCode = res.code;
        myIndex = res.playerIndex;
        saveSession(res.sessionToken);
        displayCode.textContent = roomCode;
        lobbyPlayers.innerHTML = '<p class="lobby-player">' + name + ' (you)</p>';
        btnStartGame.disabled = true;
        btnStartGame.textContent = 'Start Game';
        showScreen('lobby');
      }
    });
  });

  btnJoin.addEventListener('click', function () {
    var name = nameInput.value.trim();
    if (!name) {
      welcomeError.textContent = 'Enter your name first';
      return;
    }
    saveName(name);
    var code = codeInput.value.trim().toUpperCase();
    welcomeError.textContent = '';
    socket.emit('join-room', { code: code, name: name }, function (res) {
      if (res.success) {
        roomCode = res.code;
        myIndex = res.playerIndex;
        saveSession(res.sessionToken);
        displayCode.textContent = roomCode;
        showScreen('lobby');
      } else {
        welcomeError.textContent = res.error || 'Could not join room';
      }
    });
  });

  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !btnCreate.disabled) btnCreate.click();
  });
  codeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !btnJoin.disabled) btnJoin.click();
  });

  // ── Lobby ──
  socket.on('lobby-update', function (data) {
    renderLobby(data.players);
  });

  function renderLobby(players) {
    var html = '';
    var playerCount = 0;
    for (var i = 0; i < 2; i++) {
      var p = players[i];
      if (p) {
        playerCount++;
        var suffix = (i === myIndex) ? ' (you)' : '';
        html += '<p class="lobby-player">' + p + suffix + '</p>';
        if (i !== myIndex) partnerName = p;
      } else {
        html += '<p class="lobby-player lobby-empty">Waiting...</p>';
      }
    }
    lobbyPlayers.innerHTML = html;

    if (myIndex === 0) {
      btnStartGame.disabled = playerCount < 2;
      btnStartGame.textContent = 'Start Game';
    } else {
      btnStartGame.textContent = 'Waiting for host...';
      btnStartGame.disabled = true;
    }
  }

  btnStartGame.addEventListener('click', function () {
    socket.emit('start-game', function () {});
  });

  // ── Game started ──
  socket.on('game-started', function (data) {
    var players = data.players;
    myIndex = data.playerIndex !== undefined ? data.playerIndex : myIndex;
    partnerName = players[myIndex === 0 ? 1 : 0];
    boardMyName.textContent = myName;
    boardMyCount.textContent = '0 / 5';
    currentBoard = data.board;
    renderBoard(data.board);
    showScreen('board');
  });

  function renderBoard(board) {
    cardGrid.innerHTML = '';
    for (var i = 0; i < board.length; i++) {
      var card = board[i];
      var el = document.createElement('div');
      el.className = 'card';
      el.setAttribute('data-id', card.id);
      el.setAttribute('data-category', card.category);
      el.innerHTML =
        '<div class="card-inner">' +
          '<div class="card-front"><span class="card-icon">' + card.icon + '</span></div>' +
          '<div class="card-back"><p class="card-category">' + card.categoryLabel + '</p><p class="card-question"></p></div>' +
        '</div>';

      // Restore state if present (from resume-session)
      if (card.state === 'kept') {
        el.classList.add('kept');
      } else if (card.state === 'skipped') {
        el.classList.add('skipped');
      }

      (function (c, e) {
        e.addEventListener('click', function () {
          if (e.classList.contains('kept') || e.classList.contains('skipped')) return;
          flipAndReveal(c.id, e);
        });
      })(card, el);
      cardGrid.appendChild(el);
    }
  }

  function flipAndReveal(cardId, cardEl) {
    socket.emit('flip-card', cardId, function (res) {
      if (!res || !res.success) return;
      cardEl.classList.add('flipped');
      var qEl = cardEl.querySelector('.card-question');
      if (qEl) qEl.textContent = res.question;

      currentCardId = cardId;
      setTimeout(function () {
        modalCard.className = 'modal-card ' + res.category;
        modalCategory.textContent = res.categoryLabel;
        modalQuestion.textContent = res.question;
        questionModal.classList.add('active');
      }, 350);
    });
  }

  modalKeep.addEventListener('click', function () {
    if (currentCardId === null) return;
    questionModal.classList.remove('active');
    socket.emit('keep-card', currentCardId);
    var el = cardGrid.querySelector('[data-id="' + currentCardId + '"]');
    if (el) {
      el.classList.add('kept');
      el.classList.remove('flipped');
    }
    currentCardId = null;
  });

  modalSkip.addEventListener('click', function () {
    if (currentCardId === null) return;
    questionModal.classList.remove('active');
    socket.emit('skip-card', currentCardId);
    var el = cardGrid.querySelector('[data-id="' + currentCardId + '"]');
    if (el) {
      el.classList.add('skipped');
      el.classList.remove('flipped');
    }
    currentCardId = null;
  });

  socket.on('card-kept', function (data) {
    boardMyCount.textContent = data.count + ' / 5';
  });

  socket.on('waiting-for-partner', function () {
    showScreen('waiting');
  });

  socket.on('picking-done', function () {
    showScreen('waiting');
  });

  socket.on('partner-ready', function () {
    // Visual hint partner is ready
  });

  // ── Firing phase ──
  socket.on('firing-start', function (data) {
    firingTotal = data.total;
    firingIndex = 0;
    showTransition(
      'Time to talk!',
      data.asker + ' will ask ' + data.answerer + ' first.',
      function () {
        socket.emit('continue-round');
      }
    );
  });

  socket.on('round-started', function (data) {
    firingIndex = 0;
    firingTotal = data.total;
    showFiringScreen(data.asker, data.answerer, false);
  });

  function showTransition(title, sub, callback) {
    transitionTitle.textContent = title;
    transitionSub.textContent = sub;
    transitionOverlay.classList.add('active');
    var handler = function () {
      transitionBtn.removeEventListener('click', handler);
      transitionOverlay.classList.remove('active');
      callback();
    };
    transitionBtn.addEventListener('click', handler);
  }

  function showFiringScreen(asker, answerer, keepRevealed) {
    firingWho.innerHTML = '<span>' + asker + '</span>, ask <span>' + answerer + '</span>:';
    if (!keepRevealed) {
      firingCard.className = 'firing-card';
      firingCategory.textContent = '';
      firingQuestionText.textContent = '';
      firingRevealHint.textContent = 'Tap to reveal';
      firingRevealHint.style.display = '';
      firingNextBtn.classList.add('hidden');
      firingRevealed = false;
    }
    renderFiringProgress(firingIndex, firingTotal);
    showScreen('firing');
  }

  function showRevealedQuestion(q) {
    firingRevealed = true;
    firingCard.className = 'firing-card ' + q.category;
    firingCategory.textContent = q.categoryLabel;
    firingQuestionText.textContent = q.question;
    firingQuestionText.style.animation = 'none';
    firingQuestionText.offsetHeight;
    firingQuestionText.style.animation = 'fadeIn 0.4s ease';
    firingRevealHint.style.display = 'none';
    firingNextBtn.classList.remove('hidden');
  }

  firingCard.addEventListener('click', function () {
    if (!firingRevealed) {
      socket.emit('reveal-question');
    }
  });

  socket.on('question-revealed', function (data) {
    showRevealedQuestion(data);
  });

  firingNextBtn.addEventListener('click', function () {
    firingNextBtn.classList.add('hidden');
    socket.emit('next-question');
  });

  socket.on('advance-question', function (data) {
    firingIndex = data.index;
    firingTotal = data.total;
    firingRevealed = false;
    firingCard.className = 'firing-card';
    firingCategory.textContent = '';
    firingQuestionText.textContent = '';
    firingRevealHint.textContent = 'Tap to reveal';
    firingRevealHint.style.display = '';
    firingNextBtn.classList.add('hidden');
    renderFiringProgress(firingIndex, firingTotal);
  });

  socket.on('round-switch', function (data) {
    firingIndex = 0;
    firingTotal = data.total;
    showTransition(
      'Switch!',
      'Now ' + data.asker + ' asks ' + data.answerer + '.',
      function () {
        socket.emit('continue-round');
      }
    );
  });

  socket.on('game-over', function () {
    showScreen('end');
  });

  function renderFiringProgress(current, total) {
    var html = '';
    for (var i = 0; i < total; i++) {
      var cls = 'progress-dot';
      if (i < current) cls += ' filled';
      else if (i === current) cls += ' current';
      html += '<span class="' + cls + '"></span>';
    }
    firingProgress.innerHTML = html;
  }

  // ── Play again ──
  btnPlayAgain.addEventListener('click', function () {
    socket.emit('play-again');
  });

  // ── Disconnect / reconnect ──
  socket.on('partner-disconnected', function () {
    // Soft notification only, don't show modal (partner may reconnect)
  });

  socket.on('partner-reconnected', function () {
    // Partner is back
  });

  socket.on('partner-left', function () {
    disconnectModal.classList.add('active');
  });

  // ── Session restore ──
  function restoreFromState(state) {
    roomCode = state.code;
    myIndex = state.playerIndex;
    myName = state.players[myIndex] || myName;
    saveName(myName);
    partnerName = state.players[1 - myIndex] || '';

    if (state.phase === 'waiting') {
      displayCode.textContent = roomCode;
      renderLobby(state.players);
      showScreen('lobby');
      return;
    }

    if (state.phase === 'picking') {
      boardMyName.textContent = myName;
      boardMyCount.textContent = (state.myCount || 0) + ' / 5';
      currentBoard = state.board || [];
      renderBoard(currentBoard);
      if (state.ready) {
        showScreen('waiting');
      } else {
        showScreen('board');
      }
      return;
    }

    if (state.phase === 'firing') {
      firingIndex = state.firing.currentQuestion;
      firingTotal = state.firing.total;
      showFiringScreen(state.firing.asker, state.firing.answerer, false);
      if (state.firing.revealed && state.firing.revealedQuestion) {
        showRevealedQuestion(state.firing.revealedQuestion);
      }
      return;
    }

    if (state.phase === 'done') {
      showScreen('end');
      return;
    }
  }

  // Try to resume on every (re)connect
  socket.on('connect', function () {
    if (!sessionToken) return;
    socket.emit('resume-session', sessionToken, function (res) {
      if (res && res.success) {
        hasResumed = true;
        restoreFromState(res.state);
      } else if (!hasResumed) {
        // Token invalid, clear it
        clearSession();
      }
    });
  });

  // Welcome screen is shown by default — if resume succeeds, it will switch
})();
