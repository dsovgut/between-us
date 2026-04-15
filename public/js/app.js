(function () {
  var socket = io();
  var myName = '';
  var myIndex = -1;
  var roomCode = '';
  var partnerName = '';
  var currentCardId = null;
  var firingRevealed = false;
  var firingTotal = 5;
  var firingIndex = 0;

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

  // ── Screen management ──
  function showScreen(name) {
    Object.keys(screens).forEach(function (key) {
      screens[key].classList.remove('active');
    });
    screens[name].classList.add('active');
  }

  // ── Welcome screen ──
  function checkWelcome() {
    var name = nameInput.value.trim();
    btnCreate.disabled = !name;
    var code = codeInput.value.trim();
    btnJoin.disabled = !code;
  }

  nameInput.addEventListener('input', checkWelcome);
  codeInput.addEventListener('input', function () {
    codeInput.value = codeInput.value.toUpperCase();
    checkWelcome();
  });

  btnCreate.addEventListener('click', function () {
    myName = nameInput.value.trim();
    welcomeError.textContent = '';
    socket.emit('create-room', myName, function (res) {
      if (res.success) {
        roomCode = res.code;
        myIndex = res.playerIndex;
        displayCode.textContent = roomCode;
        lobbyPlayers.innerHTML = '<p class="lobby-player">' + myName + ' (you)</p>';
        btnStartGame.disabled = true;
        showScreen('lobby');
      }
    });
  });

  btnJoin.addEventListener('click', function () {
    myName = nameInput.value.trim();
    var code = codeInput.value.trim().toUpperCase();
    welcomeError.textContent = '';
    socket.emit('join-room', { code: code, name: myName }, function (res) {
      if (res.success) {
        roomCode = res.code;
        myIndex = res.playerIndex;
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
    var html = '';
    for (var i = 0; i < data.players.length; i++) {
      var suffix = (i === myIndex) ? ' (you)' : '';
      html += '<p class="lobby-player">' + data.players[i] + suffix + '</p>';
      if (i !== myIndex) partnerName = data.players[i];
    }
    lobbyPlayers.innerHTML = html;

    if (myIndex === 0) {
      btnStartGame.disabled = data.players.length < 2;
      btnStartGame.textContent = 'Start Game';
    } else {
      btnStartGame.textContent = 'Waiting for host...';
      btnStartGame.disabled = true;
    }
  });

  btnStartGame.addEventListener('click', function () {
    socket.emit('start-game', function () {});
  });

  // ── Game started → Board ──
  socket.on('game-started', function (data) {
    var players = data.players;
    partnerName = players[myIndex === 0 ? 1 : 0];
    boardMyName.textContent = myName;
    boardMyCount.textContent = '0 / 5';
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
      if (!res.success) return;
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
    showFiringScreen(data.asker, data.answerer);
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

  function showFiringScreen(asker, answerer) {
    firingWho.innerHTML = '<span>' + asker + '</span>, ask <span>' + answerer + '</span>:';
    firingCard.className = 'firing-card';
    firingCategory.textContent = '';
    firingQuestionText.textContent = '';
    firingRevealHint.textContent = 'Tap to reveal';
    firingRevealHint.style.display = '';
    firingNextBtn.classList.add('hidden');
    firingRevealed = false;
    renderFiringProgress(firingIndex, firingTotal);
    showScreen('firing');
  }

  firingCard.addEventListener('click', function () {
    if (!firingRevealed) {
      socket.emit('reveal-question');
    }
  });

  socket.on('question-revealed', function (data) {
    firingRevealed = true;
    firingCard.className = 'firing-card ' + data.category;
    firingCategory.textContent = data.categoryLabel;
    firingQuestionText.textContent = data.question;
    firingQuestionText.style.animation = 'none';
    firingQuestionText.offsetHeight;
    firingQuestionText.style.animation = 'fadeIn 0.4s ease';
    firingRevealHint.style.display = 'none';
    firingNextBtn.classList.remove('hidden');
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

  // ── Disconnect ──
  socket.on('partner-disconnected', function () {
    disconnectModal.classList.add('active');
  });
})();
