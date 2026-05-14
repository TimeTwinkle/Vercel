// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// 配置Socket.io跨域
const io = new Server(server, {
  cors: {
    origin: "*", // 生产环境替换为你的前端域名
    methods: ["GET", "POST"]
  }
});

// 游戏常量（和前端保持一致）
const CARD_TYPES = ["老爷","枪","狗","鸡","虫子"];
const PREDATION = { "老爷":["枪","狗","鸡"], "枪":["狗","鸡"], "狗":["鸡","虫子"], "鸡":["虫子"], "虫子":["老爷","枪"] };
const CARDS_PER_TYPE = 12;
const TOTAL_CARDS = 60;

// 房间存储：roomId => { players, gameState, ... }
const rooms = {};

// 生成随机房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 洗牌发牌逻辑
function dealCards(playerCount) {
  let deck = [];
  CARD_TYPES.forEach(c => deck.push(...Array(CARDS_PER_TYPE).fill(c)));
  // 洗牌
  for (let i = deck.length-1; i>0; i--) { 
    const j = Math.floor(Math.random()*(i+1)); 
    [deck[i], deck[j]] = [deck[j], deck[i]]; 
  }
  // 平均分牌
  const perPlayer = Math.floor(TOTAL_CARDS / playerCount);
  const hands = [];
  for (let i=0; i<playerCount; i++) {
    hands.push(deck.splice(0, perPlayer));
  }
  // 剩余牌补到前几个玩家（保证总数60）
  let idx = 0;
  while(deck.length > 0) {
    hands[idx].push(deck.pop());
    idx = (idx+1) % playerCount;
  }
  return hands;
}

// 游戏核心逻辑（简化版，和前端单机逻辑对齐）
class RoomGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = []; // 玩家列表：{ id, name, hand, score, playedCard, eliminated }
    this.round = 1;
    this.phase = "WAITING"; // WAITING/PLAY/TIEBREAKER/END
    this.tieLevel = 0;
    this.tiebreakGroup = [];
    this.playedCards = {};
    this.lastReview = null;
  }

  // 添加玩家
  addPlayer(playerId, playerName) {
    if (this.phase !== "WAITING") return false;
    this.players.push({
      id: playerId,
      name: playerName,
      hand: [],
      score: 0,
      playedCard: null,
      eliminated: false
    });
    return true;
  }

  // 开始游戏
  startGame() {
    if (this.players.length < 2) return false;
    this.phase = "PLAY";
    // 发牌
    const hands = dealCards(this.players.length);
    this.players.forEach((p, idx) => {
      p.hand = hands[idx];
      p.playedCard = null;
      p.score = 0;
      p.eliminated = false;
    });
    return true;
  }

  // 玩家出牌
  playerPlay(playerId, cardType) {
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.eliminated || this.phase !== "PLAY" && this.phase !== "TIEBREAKER") return false;
    if (this.phase === "TIEBREAKER" && !this.tiebreakGroup.includes(playerId)) return false;
    if (!player.hand.includes(cardType)) return false;
    
    // 移除手牌，记录出牌
    player.hand.splice(player.hand.indexOf(cardType), 1);
    player.playedCard = cardType;
    this.playedCards[playerId] = cardType;

    // 检查是否所有活跃玩家都出完牌
    const activePlayers = this.getActivePlayers();
    const allPlayed = activePlayers.every(p => p.playedCard !== null);
    if (allPlayed) {
      this.resolveRound();
    }
    return true;
  }

  // 获取活跃玩家（未淘汰）
  getActivePlayers() {
    const active = this.players.filter(p => !p.eliminated);
    if (this.phase === "TIEBREAKER") {
      return active.filter(p => this.tiebreakGroup.includes(p.id));
    }
    return active;
  }

  // 判断卡牌克制关系
  isPredator(c1, c2) {
    return PREDATION[c1]?.includes(c2) || false;
  }

  // 结算回合
  resolveRound() {
    const active = this.getActivePlayers();
    const cards = {};
    active.forEach(p => cards[p.id] = p.playedCard);

    // 全出相同牌：收回手牌，重新出
    if (active.length > 1 && active.every(p => cards[p.id] === cards[active[0].id])) {
      active.forEach(p => {
        p.hand.push(cards[p.id]);
        p.playedCard = null;
        delete this.playedCards[p.id];
      });
      this.broadcast("round_retry", { msg: "全出相同牌，重新出" });
      return;
    }

    // 排名玩家
    const rankedGroups = this.rankPlayers(active, cards);
    let hasTie = false;
    for (let group of rankedGroups) {
      if (group.length > 1) {
        hasTie = true;
        this.startTiebreaker(group.map(p => p.id));
        return;
      }
    }

    // 无平局：分配猎物牌
    const flatRanks = rankedGroups.flat();
    const { scores, rewards, eliminated } = this.distributePrey(flatRanks, active);
    this.lastReview = { cards, scores, rewards, eliminated };

    // 检查游戏结束（仅剩1人）
    if (this.getActivePlayers().length <= 1) {
      this.phase = "END";
      const ranking = this.players.sort((a,b) => b.hand.length - a.hand.length || b.score - a.score);
      this.broadcast("game_end", { ranking });
      return;
    }

    // 进入下一回合
    this.nextRound();
  }

  // 玩家排名（按克制关系计分）
  rankPlayers(activePlayers, cards) {
    if (activePlayers.length <= 1) return [activePlayers];
    const scores = {};
    activePlayers.forEach(p => scores[p.id] = 0);
    
    // 两两比较计分
    for (let i=0; i<activePlayers.length; i++) {
      for (let j=i+1; j<activePlayers.length; j++) {
        const p1 = activePlayers[i], p2 = activePlayers[j];
        if (this.isPredator(cards[p1.id], cards[p2.id])) {
          scores[p1.id]++;
          scores[p2.id]--;
        } else if (this.isPredator(cards[p2.id], cards[p1.id])) {
          scores[p2.id]++;
          scores[p1.id]--;
        }
      }
    }

    // 按分数分组
    const groups = {};
    activePlayers.forEach(p => {
      const s = scores[p.id];
      if (!groups[s]) groups[s] = [];
      groups[s].push(p);
    });

    // 按分数降序排列分组
    const sortedScores = Object.keys(groups).map(Number).sort((a,b) => b-a);
    const result = [];
    sortedScores.forEach(s => result.push(groups[s]));
    return result;
  }

  // 加赛逻辑
  startTiebreaker(groupIds) {
    this.phase = "TIEBREAKER";
    this.tieLevel++;
    this.tiebreakGroup = groupIds;
    // 重置加赛玩家的出牌状态
    this.players.forEach(p => {
      if (groupIds.includes(p.id)) {
        p.playedCard = null;
        delete this.playedCards[p.id];
      }
    });
    this.broadcast("tiebreaker_start", { groupIds });
  }

  // 分配猎物牌
  distributePrey(rankedPlayers, activePlayers) {
    const cards = {};
    activePlayers.forEach(p => cards[p.id] = this.playedCards[p.id]);
    const scores = this.calculateScores(cards, activePlayers);
    const preyPool = { ...cards };
    const rewards = {};
    activePlayers.forEach(p => rewards[p.id] = []);

    // 按排名分配克制的牌
    for (let p of rankedPlayers) {
      if (!preyPool[p.id]) continue;
      for (let tid of Object.keys(preyPool)) {
        if (tid !== p.id && this.isPredator(cards[p.id], preyPool[tid])) {
          rewards[p.id].push(preyPool[tid]);
          delete preyPool[tid];
        }
      }
    }

    // 剩余牌归原玩家
    for (let pid of Object.keys(preyPool)) {
      rewards[pid].push(preyPool[pid]);
    }

    // 更新玩家手牌和分数，检查淘汰
    let eliminated = [];
    activePlayers.forEach(p => {
      p.hand.push(...rewards[p.id]);
      p.score += scores[p.id];
      if (p.hand.length === 0) {
        p.eliminated = true;
        eliminated.push(p.id);
      }
      p.playedCard = null; // 重置出牌状态
      delete this.playedCards[p.id];
    });

    return { scores, rewards, eliminated };
  }

  // 计算回合分数
  calculateScores(cards, activePlayers) {
    const scores = {};
    activePlayers.forEach(p => scores[p.id] = 0);
    for (let i=0; i<activePlayers.length; i++) {
      for (let j=i+1; j<activePlayers.length; j++) {
        const p1 = activePlayers[i], p2 = activePlayers[j];
        if (this.isPredator(cards[p1.id], cards[p2.id])) {
          scores[p1.id]++;
          scores[p2.id]--;
        } else if (this.isPredator(cards[p2.id], cards[p1.id])) {
          scores[p2.id]++;
          scores[p1.id]--;
        }
      }
    }
    return scores;
  }

  // 下一回合
  nextRound() {
    this.phase = "PLAY";
    this.round++;
    this.tieLevel = 0;
    this.tiebreakGroup = [];
    this.broadcast("round_next", { round: this.round });
  }

  // 广播房间内事件
  broadcast(event, data) {
    io.to(this.roomId).emit(event, data);
  }

  // 获取房间状态（给前端同步）
  getState() {
    return {
      roomId: this.roomId,
      phase: this.phase,
      round: this.round,
      tieLevel: this.tieLevel,
      tiebreakGroup: this.tiebreakGroup,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        score: p.score,
        eliminated: p.eliminated,
        played: p.playedCard !== null
      })),
      playedCards: this.playedCards,
      lastReview: this.lastReview
    };
  }
}

// Socket.io事件处理
io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  // 创建房间
  socket.on('create_room', (playerName, callback) => {
    const roomId = generateRoomId();
    const game = new RoomGame(roomId);
    game.addPlayer(socket.id, playerName);
    rooms[roomId] = game;
    socket.join(roomId);
    callback({ success: true, roomId, playerId: socket.id });
    // 广播房间玩家更新
    game.broadcast("room_players", game.players.map(p => ({ id: p.id, name: p.name })));
  });

  // 加入房间
  socket.on('join_room', ({ roomId, playerName }, callback) => {
    const game = rooms[roomId];
    if (!game || game.phase !== "WAITING") {
      callback({ success: false, msg: "房间不存在或已开始游戏" });
      return;
    }
    // 添加玩家
    const added = game.addPlayer(socket.id, playerName);
    if (!added) {
      callback({ success: false, msg: "无法加入房间" });
      return;
    }
    socket.join(roomId);
    callback({ success: true, playerId: socket.id });
    // 广播房间玩家更新
    game.broadcast("room_players", game.players.map(p => ({ id: p.id, name: p.name })));
    // 同步房间状态给新玩家
    socket.emit("room_state", game.getState());
  });

  // 开始游戏
  socket.on('start_game', (roomId, callback) => {
    const game = rooms[roomId];
    if (!game || game.phase !== "WAITING" || game.players.length < 2) {
      callback({ success: false, msg: "无法开始游戏（人数不足或非等待状态）" });
      return;
    }
    const started = game.startGame();
    if (!started) {
      callback({ success: false, msg: "游戏启动失败" });
      return;
    }
    callback({ success: true });
    // 广播游戏开始，同步初始状态
    game.broadcast("game_start", game.getState());
    // 给每个玩家发送自己的手牌
    game.players.forEach(p => {
      io.to(p.id).emit("player_hand", { hand: p.hand });
    });
  });

  // 玩家出牌
  socket.on('player_play', ({ roomId, cardType }, callback) => {
    const game = rooms[roomId];
    if (!game) {
      callback({ success: false, msg: "房间不存在" });
      return;
    }
    const played = game.playerPlay(socket.id, cardType);
    if (!played) {
      callback({ success: false, msg: "出牌失败（无效操作）" });
      return;
    }
    callback({ success: true });
    // 广播出牌事件和最新状态
    game.broadcast("player_played", { playerId: socket.id, cardType });
    game.broadcast("room_state", game.getState());
  });

  // 获取房间状态
  socket.on('get_room_state', (roomId, callback) => {
    const game = rooms[roomId];
    if (!game) {
      callback({ success: false });
      return;
    }
    callback({ success: true, state: game.getState() });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('玩家断开:', socket.id);
    // 清理房间中离线玩家
    Object.values(rooms).forEach(game => {
      const playerIdx = game.players.findIndex(p => p.id === socket.id);
      if (playerIdx !== -1) {
        game.players.splice(playerIdx, 1);
        // 广播玩家离开
        game.broadcast("player_leave", { playerId: socket.id });
        // 如果房间无玩家，删除房间
        if (game.players.length === 0) {
          delete rooms[game.roomId];
        } else if (game.phase === "PLAY" && game.getActivePlayers().length <= 1) {
          // 剩余1人直接结束游戏
          game.phase = "END";
          const ranking = game.players.sort((a,b) => b.hand.length - a.hand.length || b.score - a.score);
          game.broadcast("game_end", { ranking });
        }
      }
    });
  });
});

// 启动服务
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`服务端运行在端口 ${PORT}`);
});
