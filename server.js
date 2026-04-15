const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const questionBank = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CATEGORIES = [
  { key: 'hypothetical', label: 'Hypotheticals', icon: '\u{1F52E}' },
  { key: 'childhood',    label: 'Childhood',     icon: '\u{1F9F8}' },
  { key: 'spicy',        label: 'Spicy',         icon: '\u{1F525}' },
  { key: 'dreams',       label: 'Dreams',        icon: '\u{1F680}' },
  { key: 'love',         label: 'Love',          icon: '\u{1F497}' }
];

function generateBoard() {
  const cards = [];
  let id = 0;
  for (const cat of CATEGORIES) {
    const pool = questionBank[cat.key] || [];
    const picked = shuffle(pool).slice(0, 5);
    for (const question of picked) {
      cards.push({ id: id++, category: cat.key, categoryLabel: cat.label, icon: cat.icon, question });
    }
  }
  return shuffle(cards);
}

// ── Socket.IO ──
io.on('connection', (socket) => {

  socket.on('create-room', (playerName, cb) => {
    const code = generateCode();
    rooms.set(code, {
      code,
      players: [{ name: playerName, socketId: socket.id }],
      phase: 'waiting',
      board: [],
      collected: [[], []],
      pickedCards: [{}, {}],
      ready: [false, false],
      firing: { currentRound: 0, currentQuestion: 0 }
    });
    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 0;
    cb({ success: true, code, playerIndex: 0 });
  });

  socket.on('join-room', ({ code: rawCode, name }, cb) => {
    const code = (rawCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.players.length >= 2) return cb({ success: false, error: 'Room is full' });
    if (room.phase !== 'waiting') return cb({ success: false, error: 'Game already started' });

    room.players.push({ name, socketId: socket.id });
    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 1;
    cb({ success: true, code, playerIndex: 1 });

    io.to(code).emit('lobby-update', { players: room.players.map(p => p.name) });
  });

  socket.on('start-game', (cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.players.length < 2 || socket.playerIndex !== 0) {
      return cb && cb({ success: false });
    }
    startNewRound(room);
    cb && cb({ success: true });
  });

  socket.on('flip-card', (cardId, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return cb({ success: false });
    const pi = socket.playerIndex;
    if (room.ready[pi]) return cb({ success: false });
    if (room.pickedCards[pi][cardId] === 'kept') return cb({ success: false });

    const card = room.board.find(c => c.id === cardId);
    if (!card) return cb({ success: false });

    room.pickedCards[pi][cardId] = 'seen';
    cb({ success: true, question: card.question, category: card.category, categoryLabel: card.categoryLabel });
  });

  socket.on('keep-card', (cardId) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return;
    const pi = socket.playerIndex;
    if (room.ready[pi] || room.collected[pi].length >= 5) return;

    const card = room.board.find(c => c.id === cardId);
    if (!card || room.pickedCards[pi][cardId] === 'kept') return;

    room.pickedCards[pi][cardId] = 'kept';
    room.collected[pi].push({ question: card.question, category: card.category, categoryLabel: card.categoryLabel });
    socket.emit('card-kept', { cardId, count: room.collected[pi].length });

    if (room.collected[pi].length >= 5) {
      room.ready[pi] = true;
      socket.emit('picking-done');
      if (room.ready[0] && room.ready[1]) {
        room.phase = 'firing';
        room.firing = { currentRound: 0, currentQuestion: 0 };
        io.to(room.code).emit('firing-start', {
          asker: room.players[0].name,
          answerer: room.players[1].name,
          total: room.collected[0].length
        });
      } else {
        socket.emit('waiting-for-partner');
      }
    }
  });

  socket.on('skip-card', (cardId) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return;
    const pi = socket.playerIndex;
    room.pickedCards[pi][cardId] = 'skipped';
    socket.emit('card-skipped', { cardId });
  });

  socket.on('reveal-question', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;
    const { currentRound, currentQuestion } = room.firing;
    const q = room.collected[currentRound][currentQuestion];
    if (!q) return;
    io.to(room.code).emit('question-revealed', { question: q.question, category: q.category, categoryLabel: q.categoryLabel });
  });

  socket.on('next-question', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;

    room.firing.currentQuestion++;
    const { currentRound, currentQuestion } = room.firing;
    const questions = room.collected[currentRound];

    if (currentQuestion >= questions.length) {
      room.firing.currentRound++;
      room.firing.currentQuestion = 0;

      if (room.firing.currentRound >= 2) {
        room.phase = 'done';
        io.to(room.code).emit('game-over');
      } else {
        const r = room.firing.currentRound;
        io.to(room.code).emit('round-switch', {
          asker: room.players[r].name,
          answerer: room.players[r === 0 ? 1 : 0].name,
          total: room.collected[r].length
        });
      }
    } else {
      io.to(room.code).emit('advance-question', { index: currentQuestion, total: questions.length });
    }
  });

  socket.on('continue-round', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;
    const r = room.firing.currentRound;
    io.to(room.code).emit('round-started', {
      asker: room.players[r].name,
      answerer: room.players[r === 0 ? 1 : 0].name,
      total: room.collected[r].length
    });
  });

  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    startNewRound(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const other = room.players.find(p => p.socketId !== socket.id);
    if (other) io.to(other.socketId).emit('partner-disconnected');
    setTimeout(() => {
      const r = rooms.get(socket.roomCode);
      if (!r) return;
      const alive = r.players.some(p => io.sockets.sockets.get(p.socketId)?.connected);
      if (!alive) rooms.delete(socket.roomCode);
    }, 120000);
  });

  function startNewRound(room) {
    room.board = generateBoard();
    room.phase = 'picking';
    room.collected = [[], []];
    room.pickedCards = [{}, {}];
    room.ready = [false, false];
    room.firing = { currentRound: 0, currentQuestion: 0 };

    const boardForClient = room.board.map(c => ({
      id: c.id, category: c.category, categoryLabel: c.categoryLabel, icon: c.icon
    }));
    io.to(room.code).emit('game-started', { board: boardForClient, players: room.players.map(p => p.name) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Between Us running on port ${PORT}`));
