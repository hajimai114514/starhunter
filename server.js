// server.js
// 双人联机井字棋服务端
// 技术栈：Node.js + Express + Socket.IO
// 说明：棋盘状态、回合、胜负全部由服务端维护，客户端只能发送落子位置

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// 创建 Express 应用
const app = express();
// 创建 HTTP 服务器（Socket.IO 需要挂载在 http server 上）
const server = http.createServer(app);
// 初始化 Socket.IO，允许跨域（部署后同源也可）
const io = new Server(server, {
  cors: { origin: '*' }
});

// 托管 public 文件夹作为静态资源
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 内存中的房间数据
// rooms[roomId] = {
//   board: Array(9),        // 棋盘，0-8 共 9 格，null 表示空
//   players: [              // 玩家列表，最多 2 人
//     { clientId, socketId, name, symbol, online }
//   ],
//   turn: 'X' | 'O',        // 当前轮到谁
//   winner: 'X' | 'O' | null,
//   isDraw: boolean,
//   gameOver: boolean,
//   restartVotes: ['X','O'] // 已同意重开的符号列表
// }
// ============================================================
const rooms = {};

// 创建空棋盘
function createBoard() {
  return Array(9).fill(null);
}

// 胜负判断：横、竖、斜三连
// 返回获胜符号 'X'/'O'，无胜者返回 null
function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // 横向
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // 纵向
    [0, 4, 8], [2, 4, 6]             // 斜向
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// 平局判断：棋盘已满且无胜者
function checkDraw(board) {
  return board.every(cell => cell !== null);
}

// 构造要广播给客户端的游戏状态
function buildGameState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  return {
    roomId,
    board: room.board,
    // 只暴露必要的玩家信息，不暴露 clientId / socketId
    players: room.players.map(p => ({
      name: p.name,
      symbol: p.symbol,
      online: p.online
    })),
    turn: room.turn,
    winner: room.winner,
    isDraw: room.isDraw,
    gameOver: room.gameOver,
    restartVotes: room.restartVotes
  };
}

// 向房间内所有玩家广播最新状态
function broadcastRoom(roomId) {
  const state = buildGameState(roomId);
  if (state) {
    io.to(roomId).emit('gameState', state);
  }
}

// 根据 socket.id 找到所在房间和玩家
function findPlayerBySocket(socketId) {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    const player = room.players.find(p => p.socketId === socketId);
    if (player) {
      return { roomId, room, player };
    }
  }
  return null;
}

// 处理玩家断开连接
function handleDisconnect(socket) {
  const found = findPlayerBySocket(socket.id);
  if (!found) return;

  const { roomId, room, player } = found;
  // 标记为离线，但保留玩家身份以便重连
  player.online = false;
  player.socketId = null;

  // 通知房间内另一人对手离开
  socket.to(roomId).emit('opponentLeft', {
    message: '对手已离开，等待重连'
  });

  // 广播最新状态（含 online 字段）
  broadcastRoom(roomId);

  // 如果房间内所有玩家都离线了，清理房间（释放内存）
  const allOffline = room.players.every(p => !p.online);
  if (allOffline) {
    delete rooms[roomId];
    console.log(`房间 ${roomId} 已清空，已删除`);
  }
}

// ============================================================
// Socket.IO 连接处理
// ============================================================
io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  // ---------- 加入房间 ----------
  socket.on('join', ({ name, roomId, clientId }) => {
    // 输入清洗
    name = (name || '玩家').toString().trim() || '玩家';
    roomId = (roomId || '').toString().trim();
    clientId = (clientId || '').toString().trim();

    if (!roomId) {
      socket.emit('error', { message: '请输入房间号' });
      return;
    }

    // 房间不存在则创建
    if (!rooms[roomId]) {
      rooms[roomId] = {
        board: createBoard(),
        players: [],
        turn: 'X',
        winner: null,
        isDraw: false,
        gameOver: false,
        restartVotes: []
      };
    }

    const room = rooms[roomId];

    // 优先用 clientId 查找是否是老玩家重连
    let player = room.players.find(p => p.clientId === clientId && clientId);

    if (player) {
      // ===== 老玩家重连 =====
      player.socketId = socket.id;
      player.online = true;
      socket.join(roomId);
      // 定向告知自己的符号和昵称
      socket.emit('assignedSymbol', {
        symbol: player.symbol,
        name: player.name
      });
      broadcastRoom(roomId);
      console.log(`玩家 ${player.name} 重连房间 ${roomId}，符号 ${player.symbol}`);
      return;
    }

    // ===== 新玩家加入 =====
    // 检查房间是否已满
    if (room.players.length >= 2) {
      socket.emit('error', { message: '房间已满' });
      return;
    }

    // 第一个进入的是 X，第二个是 O
    const symbol = room.players.length === 0 ? 'X' : 'O';
    player = {
      clientId: clientId || socket.id, // 没传 clientId 就用 socket.id 兜底
      socketId: socket.id,
      name,
      symbol,
      online: true
    };
    room.players.push(player);
    socket.join(roomId);

    // 定向告知自己的符号
    socket.emit('assignedSymbol', { symbol, name });
    // 广播房间状态（两人时对方也能收到更新）
    broadcastRoom(roomId);
    console.log(`玩家 ${name} 加入房间 ${roomId}，符号 ${symbol}`);
  });

  // ---------- 落子 ----------
  socket.on('move', ({ index }) => {
    const found = findPlayerBySocket(socket.id);
    if (!found) {
      socket.emit('error', { message: '你还没有加入房间' });
      return;
    }

    const { roomId, room, player } = found;

    // 校验 1：游戏是否已结束
    if (room.gameOver) {
      socket.emit('error', { message: '游戏已结束，请点击重开' });
      return;
    }

    // 校验 2：是否轮到该玩家
    if (room.turn !== player.symbol) {
      socket.emit('error', { message: '还没轮到你' });
      return;
    }

    // 校验 3：index 合法性
    index = Number(index);
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      socket.emit('error', { message: '非法落子位置' });
      return;
    }

    // 校验 4：格子是否为空
    if (room.board[index] !== null) {
      socket.emit('error', { message: '该格子已被占用' });
      return;
    }

    // 通过校验，落子
    room.board[index] = player.symbol;

    // 判断胜负
    const winner = checkWinner(room.board);
    if (winner) {
      room.winner = winner;
      room.gameOver = true;
    } else if (checkDraw(room.board)) {
      // 平局
      room.isDraw = true;
      room.gameOver = true;
    } else {
      // 切换回合
      room.turn = room.turn === 'X' ? 'O' : 'X';
    }

    // 广播最新棋盘状态
    broadcastRoom(roomId);
  });

  // ---------- 重开 ----------
  socket.on('restart', () => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return;

    const { roomId, room, player } = found;

    // 记录该玩家的重开投票（去重）
    if (!room.restartVotes.includes(player.symbol)) {
      room.restartVotes.push(player.symbol);
    }

    // 只有一方同意，提示等待
    if (room.restartVotes.length < room.players.length) {
      socket.emit('error', { message: '等待对方同意重开' });
      broadcastRoom(roomId);
      return;
    }

    // 双方都同意，重置棋盘
    room.board = createBoard();
    room.turn = 'X';
    room.winner = null;
    room.isDraw = false;
    room.gameOver = false;
    room.restartVotes = [];

    broadcastRoom(roomId);
  });

  // ---------- 断开连接 ----------
  socket.on('disconnect', () => {
    handleDisconnect(socket);
    console.log('玩家断开:', socket.id);
  });
});

// 监听端口，支持 Render 等平台通过环境变量 PORT 指定
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`井字棋服务器运行在端口 ${PORT}`);
});
