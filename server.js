const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const questionBank = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 30000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
const rooms = new Map();              // code → room
const sessionIndex = new Map();       // sessionToken → { roomCode, playerIndex }

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function generateToken() {
  return crypto.randomUUID();
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

/**
 * Generate two boards with NO question overlap between players.
 * Picks 10 from each category pool, splits 5/5.
 */
function generateBoards() {
  const board1 = [];
  const board2 = [];
  let id1 = 0;
  let id2 = 0;

  for (const cat of CATEGORIES) {
    const pool = questionBank[cat.key] || [];
    const picked = shuffle(pool).slice(0, 10);
    for (let i = 0; i < 5; i++) {
      board1.push({
        id: id1++, category: cat.key, categoryLabel: cat.label,
        icon: cat.icon, question: picked[i]
      });
    }
    for (let i = 5; i < 10; i++) {
      board2.push({
        id: id2++, category: cat.key, categoryLabel: cat.label,
        icon: cat.icon, question: picked[i]
      });
    }
  }
  return [shuffle(board1), shuffle(board2)];
}

function touchRoom(room) {
  room.lastActivity = Date.now();
}

// Periodic cleanup of stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      for (const p of room.players) {
        if (p.sessionToken) sessionIndex.delete(p.sessionToken);
      }
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000);

// ── Client-safe views ──
function boardForClient(board, pickedCards) {
  return board.map(c => ({
    id: c.id, category: c.category, categoryLabel: c.categoryLabel, icon: c.icon,
    state: pickedCards[c.id] || null,   // 'kept' | 'skipped' | 'seen' | null
    question: pickedCards[c.id] === 'kept' ? c.question : undefined
  }));
}

function stateSnapshot(room, playerIndex) {
  const snap = {
    code: room.code,
    playerIndex,
    players: room.players.map(p => p ? p.name : null),
    phase: room.phase,
    partnerConnected: room.players[1 - playerIndex]?.connected || false
  };

  if (room.phase === 'picking') {
    snap.board = boardForClient(room.boards[playerIndex], room.pickedCards[playerIndex]);
    snap.myCount = room.collected[playerIndex].length;
    snap.ready = room.ready[playerIndex];
    snap.partnerReady = room.ready[1 - playerIndex];
  }

  if (room.phase === 'firing') {
    const r = room.firing.currentRound;
    snap.firing = {
      currentRound: r,
      currentQuestion: room.firing.currentQuestion,
      total: room.collected[r].length,
      revealed: room.firing.revealed,
      asker: room.players[r].name,
      answerer: room.players[r === 0 ? 1 : 0].name
    };
    if (room.firing.revealed) {
      const q = room.collected[r][room.firing.currentQuestion];
      snap.firing.revealedQuestion = q
        ? { question: q.question, category: q.category, categoryLabel: q.categoryLabel }
        : null;
    }
  }

  return snap;
}

function startNewRound(room) {
  const [b1, b2] = generateBoards();
  room.boards = [b1, b2];
  room.phase = 'picking';
  room.collected = [[], []];
  room.pickedCards = [{}, {}];
  room.ready = [false, false];
  room.firing = { currentRound: 0, currentQuestion: 0, revealed: false };
  touchRoom(room);

  for (let i = 0; i < 2; i++) {
    const player = room.players[i];
    if (player?.socketId) {
      io.to(player.socketId).emit('game-started', {
        board: boardForClient(room.boards[i], room.pickedCards[i]),
        playerIndex: i,
        players: room.players.map(p => p ? p.name : null)
      });
    }
  }
}

function broadcastToRoom(room, event, data) {
  for (const p of room.players) {
    if (p?.socketId) io.to(p.socketId).emit(event, data);
  }
}

// ── Socket.IO ──
io.on('connection', (socket) => {

  socket.on('resume-session', (token, cb) => {
    if (!token || !sessionIndex.has(token)) {
      return cb({ success: false });
    }
    const { roomCode, playerIndex } = sessionIndex.get(token);
    const room = rooms.get(roomCode);
    if (!room) {
      sessionIndex.delete(token);
      return cb({ success: false });
    }

    const player = room.players[playerIndex];
    if (!player || player.sessionToken !== token) {
      return cb({ success: false });
    }

    player.socketId = socket.id;
    player.connected = true;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerIndex = playerIndex;
    socket.sessionToken = token;
    touchRoom(room);

    cb({ success: true, state: stateSnapshot(room, playerIndex) });

    // Notify partner that we're back
    const partner = room.players[1 - playerIndex];
    if (partner?.socketId) {
      io.to(partner.socketId).emit('partner-reconnected');
    }
  });

  socket.on('create-room', (playerName, cb) => {
    const name = String(playerName || '').trim().slice(0, 20);
    if (!name) return cb({ success: false, error: 'Name required' });
    const code = generateCode();
    const token = generateToken();
    const room = {
      code,
      players: [
        { name, sessionToken: token, socketId: socket.id, connected: true },
        null
      ],
      phase: 'waiting',
      boards: [[], []],
      collected: [[], []],
      pickedCards: [{}, {}],
      ready: [false, false],
      firing: { currentRound: 0, currentQuestion: 0, revealed: false },
      lastActivity: Date.now()
    };
    rooms.set(code, room);
    sessionIndex.set(token, { roomCode: code, playerIndex: 0 });

    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 0;
    socket.sessionToken = token;

    cb({ success: true, code, playerIndex: 0, sessionToken: token });
  });

  socket.on('join-room', ({ code: rawCode, name: rawName }, cb) => {
    const code = String(rawCode || '').toUpperCase().trim();
    const name = String(rawName || '').trim().slice(0, 20);
    if (!name) return cb({ success: false, error: 'Name required' });
    const room = rooms.get(code);
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.players[1]) return cb({ success: false, error: 'Room is full' });
    if (room.phase !== 'waiting') return cb({ success: false, error: 'Game already started' });

    const token = generateToken();
    room.players[1] = { name, sessionToken: token, socketId: socket.id, connected: true };
    sessionIndex.set(token, { roomCode: code, playerIndex: 1 });
    touchRoom(room);

    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 1;
    socket.sessionToken = token;

    cb({ success: true, code, playerIndex: 1, sessionToken: token });

    broadcastToRoom(room, 'lobby-update', {
      players: room.players.map(p => p ? p.name : null)
    });
  });

  socket.on('start-game', (cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.players[0] || !room.players[1] || socket.playerIndex !== 0) {
      return cb && cb({ success: false });
    }
    startNewRound(room);
    cb && cb({ success: true });
  });

  socket.on('flip-card', (cardId, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return cb && cb({ success: false });
    const pi = socket.playerIndex;
    if (room.ready[pi]) return cb && cb({ success: false });
    const status = room.pickedCards[pi][cardId];
    if (status === 'kept' || status === 'skipped') return cb && cb({ success: false });

    const card = room.boards[pi].find(c => c.id === cardId);
    if (!card) return cb && cb({ success: false });

    if (!room.pickedCards[pi][cardId]) {
      room.pickedCards[pi][cardId] = 'seen';
    }
    touchRoom(room);
    cb && cb({ success: true, question: card.question, category: card.category, categoryLabel: card.categoryLabel });
  });

  socket.on('keep-card', (cardId) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return;
    const pi = socket.playerIndex;
    if (room.ready[pi] || room.collected[pi].length >= 5) return;

    const card = room.boards[pi].find(c => c.id === cardId);
    if (!card || room.pickedCards[pi][cardId] === 'kept') return;

    room.pickedCards[pi][cardId] = 'kept';
    room.collected[pi].push({
      question: card.question,
      category: card.category,
      categoryLabel: card.categoryLabel
    });
    touchRoom(room);
    socket.emit('card-kept', { cardId, count: room.collected[pi].length });

    if (room.collected[pi].length >= 5) {
      room.ready[pi] = true;
      socket.emit('picking-done');
      const partner = room.players[1 - pi];
      if (partner?.socketId) {
        io.to(partner.socketId).emit('partner-ready');
      }
      if (room.ready[0] && room.ready[1]) {
        room.phase = 'firing';
        room.firing = { currentRound: 0, currentQuestion: 0, revealed: false };
        broadcastToRoom(room, 'firing-start', {
          asker: room.players[0].name,
          answerer: room.players[1].name,
          total: room.collected[0].length
        });
      }
    }
  });

  socket.on('skip-card', (cardId) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'picking') return;
    const pi = socket.playerIndex;
    if (room.pickedCards[pi][cardId] === 'kept') return;
    room.pickedCards[pi][cardId] = 'skipped';
    touchRoom(room);
    socket.emit('card-skipped', { cardId });
  });

  socket.on('reveal-question', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;
    // Only the asker can reveal, and only once per question
    if (socket.playerIndex !== room.firing.currentRound) return;
    if (room.firing.revealed) return;
    const { currentRound, currentQuestion } = room.firing;
    const q = room.collected[currentRound][currentQuestion];
    if (!q) return;
    room.firing.revealed = true;
    touchRoom(room);
    broadcastToRoom(room, 'question-revealed', {
      question: q.question, category: q.category, categoryLabel: q.categoryLabel
    });
  });

  socket.on('next-question', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;
    // Only the asker can advance, and only after revealing (prevents double-click skipping)
    if (socket.playerIndex !== room.firing.currentRound) return;
    if (!room.firing.revealed) return;

    room.firing.currentQuestion++;
    room.firing.revealed = false;
    const { currentRound, currentQuestion } = room.firing;
    const questions = room.collected[currentRound];
    touchRoom(room);

    if (currentQuestion >= questions.length) {
      room.firing.currentRound++;
      room.firing.currentQuestion = 0;

      if (room.firing.currentRound >= 2) {
        room.phase = 'done';
        broadcastToRoom(room, 'game-over');
      } else {
        const r = room.firing.currentRound;
        broadcastToRoom(room, 'round-switch', {
          asker: room.players[r].name,
          answerer: room.players[r === 0 ? 1 : 0].name,
          total: room.collected[r].length
        });
      }
    } else {
      broadcastToRoom(room, 'advance-question', { index: currentQuestion, total: questions.length });
    }
  });

  socket.on('continue-round', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'firing') return;
    // Only at the start of a round, before reveal
    if (room.firing.currentQuestion !== 0 || room.firing.revealed) return;
    const r = room.firing.currentRound;
    broadcastToRoom(room, 'round-started', {
      asker: room.players[r].name,
      answerer: room.players[r === 0 ? 1 : 0].name,
      total: room.collected[r].length
    });
  });

  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    // Only allowed once the previous game is finished, and only by the host
    if (room.phase !== 'done') return;
    if (socket.playerIndex !== 0) return;
    if (!room.players[0] || !room.players[1]) return;
    startNewRound(room);
  });

  socket.on('leave-room', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const pi = socket.playerIndex;
    const player = room.players[pi];
    if (player?.sessionToken) {
      sessionIndex.delete(player.sessionToken);
    }

    const partner = room.players[1 - pi];

    // If we're in the lobby, just delete the slot. Past that, the game can't
    // continue without both players, so end it for everyone.
    if (room.phase === 'waiting') {
      room.players[pi] = null;
      if (partner?.socketId) {
        io.to(partner.socketId).emit('lobby-update', {
          players: room.players.map(p => p ? p.name : null)
        });
      }
      // No one left in the room? Drop it.
      if (!room.players[0] && !room.players[1]) {
        rooms.delete(room.code);
      }
    } else {
      // End the game; partner gets notified and the room is torn down.
      if (partner?.sessionToken) {
        sessionIndex.delete(partner.sessionToken);
      }
      if (partner?.socketId) {
        io.to(partner.socketId).emit('partner-left');
      }
      rooms.delete(room.code);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const pi = socket.playerIndex;
    const player = room.players[pi];
    if (player) {
      player.connected = false;
    }
    const partner = room.players[1 - pi];
    if (partner?.socketId) {
      io.to(partner.socketId).emit('partner-disconnected');
    }
    // Room stays in memory. Cleaned up by periodic sweep if inactive.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Between Us running on port ${PORT}`));
