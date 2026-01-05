// bot.js
const TelegramBot = require('node-telegram-bot-api');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const token = process.env.TOKEN;
if (!token) {
  console.error("ERROR: TOKEN environment variable belum diset");
  process.exit(1);
}

const adapter = new JSONFile('werewolf_db.json');
const db = new Low(adapter);

let bot;

let game = {
  id: null,
  chatId: null,
  players: {}, // { userId: { name, role, alive, lover, kills } }
  phase: null, // 'join' | 'night' | 'day'
  nightActions: {}, // { lovers: [], kill: null, save: null, werewolfVotes: {} }
  votes: {}, // { voterId: targetId }
};

async function saveStats() {
  await db.read();
  db.data.stats ||= {};
  for (const [id, player] of Object.entries(game.players)) {
    db.data.stats[id] ||= { name: player.name, kills: 0, gamesPlayed: 0, wins: 0 };
    db.data.stats[id].kills += player.kills;
    db.data.stats[id].gamesPlayed += 1;
  }
  await db.write();
}

function resetGame() {
  game.id = null;
  game.chatId = null;
  game.players = {};
  game.phase = null;
  game.nightActions = {};
  game.votes = {};
}

function isGameOver() {
  const alive = Object.values(game.players).filter(p => p.alive);
  const aliveWerewolves = alive.filter(p => p.role === 'Werewolf').length;
  const aliveVillagers = alive.length - aliveWerewolves;

  // check Lovers win
  const lovers = Object.values(game.players).filter(p => p.lover);
  if (lovers.length === 2 && lovers.every(p => p.alive)) return 'lovers';

  if (aliveWerewolves === 0) return 'villagers';
  if (aliveWerewolves >= aliveVillagers) return 'werewolves';
  return null;
}

async function announceWinner(winner) {
  let winnerText = winner.toUpperCase();
  if (winner === 'lovers') winnerText = 'LOVERS 💘';

  await bot.sendMessage(game.chatId, `🏆 Game selesai! Pemenang: *${winnerText}*`, { parse_mode: 'Markdown' });

  // Update win stats
  await db.read();
  db.data.stats ||= {};
  for (const [id, p] of Object.entries(game.players)) {
    db.data.stats[id] ||= { name: p.name, kills: 0, gamesPlayed: 0, wins: 0 };
    if ((winner === 'villagers' && p.role !== 'Werewolf') ||
        (winner === 'werewolves' && p.role === 'Werewolf') ||
        (winner === 'lovers' && p.lover)) {
      db.data.stats[id].wins += 1;
    }
  }
  await db.write();
  resetGame();
}

function createButton(text, callback_data) {
  return { text, callback_data };
}

function startCountdown(chatId, duration, textPrefix, callback) {
  let t = duration;
  const timer = setInterval(async () => {
    if (t <= 0) {
      clearInterval(timer);
      if (callback) callback();
      return;
    }
    await bot.sendMessage(chatId, `${textPrefix}: ${t} detik tersisa`);
    t--;
  }, 1000);
}

// ---------------- Day Phase ----------------
async function startDayPhase() {
  game.phase = 'day';
  game.nightActions = {};
  game.votes = {};

  await bot.sendMessage(game.chatId, '☀️ Siang hari tiba! Diskusi dan voting dimulai.');

  const alive = Object.entries(game.players).filter(([_, p]) => p.alive);
  const buttons = alive.map(([id, p]) => [createButton(p.name, `vote_${id}`)]);

  await bot.sendMessage(game.chatId, '🗳️ Klik tombol untuk voting:', {
    reply_markup: { inline_keyboard: buttons },
  });

  startCountdown(game.chatId, 30, "☀️ Siang", async () => {
    await resolveVoting();
  });
}

async function resolveVoting() {
  const voteCounts = {};
  for (const targetId of Object.values(game.votes)) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;

  let maxVotes = 0, candidates = [];
  for (const [id, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) { maxVotes = count; candidates = [id]; }
    else if (count === maxVotes) candidates.push(id);
  }

  if (candidates.length !== 1 || maxVotes === 0) {
    await bot.sendMessage(game.chatId, '⚠️ Voting seri atau tidak ada voting. Tidak ada yang dihukum mati.');
  } else {
    const killedId = candidates[Math.floor(Math.random() * candidates.length)];
    game.players[killedId].alive = false;

    await bot.sendMessage(game.chatId, `☠️ ${game.players[killedId].name} telah dihukum mati! Role: *${game.players[killedId].role}*`, { parse_mode: 'Markdown' });

    // private vote results
    for (const [voterId, target] of Object.entries(game.votes)) {
      await bot.sendMessage(voterId, `🗳️ Kamu memilih ${game.players[target].name}`);
    }

    if (game.players[killedId].role === 'Hunter') {
      await bot.sendMessage(game.chatId, `🏹 Hunter menyerang sebelum mati!`);
      // Optional: add Hunter retaliation logic
    }

    const winner = isGameOver();
    if (winner) {
      await announceWinner(winner);
      return;
    }
  }
  await startNightPhase();
}

// ---------------- Night Phase ----------------
async function startNightPhase() {
  game.phase = 'night';
  game.nightActions = { werewolfVotes: {}, lovers: [], kill: null, save: null };

  await bot.sendMessage(game.chatId, "🌙 Malam tiba! Pemain yang beraksi, lakukan pilihan sekarang!");

  const alive = Object.entries(game.players).filter(([_, p]) => p.alive);

  // Werewolves choose target
  const wolves = alive.filter(([_, p]) => p.role === 'Werewolf');
  for (const [wolfId] of wolves) {
    const buttons = alive.filter(([id]) => id !== wolfId).map(([id, p]) => [createButton(p.name, `kill_${id}`)]);
    await bot.sendMessage(wolfId, "🩸 Pilih siapa yang ingin dibunuh:", { reply_markup: { inline_keyboard: buttons } });
  }

  // Seer
  const seer = alive.find(([_, p]) => p.role === 'Seer');
  if (seer) {
    const [seerId] = seer;
    const buttons = alive.filter(([id]) => id !== seerId).map(([id, p]) => [createButton(p.name, `reveal_${id}`)]);
    await bot.sendMessage(seerId, "👁️ Pilih siapa yang ingin dilihat role-nya:", { reply_markup: { inline_keyboard: buttons } });
  }

  // Doctor
  const doc = alive.find(([_, p]) => p.role === 'Doctor');
  if (doc) {
    const [docId] = doc;
    const buttons = alive.map(([id, p]) => [createButton(p.name, `save_${id}`)]);
    await bot.sendMessage(docId, "💊 Pilih siapa yang ingin diselamatkan:", { reply_markup: { inline_keyboard: buttons } });
  }

  // countdown (optional, for info)
  startCountdown(game.chatId, 15, "🌙 Malam", async () => {
    await resolveNight();
  });
}

async function resolveNight() {
  const killId = game.nightActions.kill;
  const saveId = game.nightActions.save;

  if (killId && killId !== saveId) {
    game.players[killId].alive = false;
    game.players[killId].kills++;

    await bot.sendMessage(game.chatId, `☠️ ${game.players[killId].name} dibunuh semalam! Role: *${game.players[killId].role}*`, { parse_mode: 'Markdown' });

    const winner = isGameOver();
    if (winner) {
      await announceWinner(winner);
      return;
    }
  } else {
    await bot.sendMessage(game.chatId, `💊 Tidak ada kematian semalam.`);
  }
  await startDayPhase();
}

function checkNightDone() {
  if (game.nightActions.kill && game.nightActions.save !== undefined) {
    resolveNight().catch(console.error);
  }
}

// ---------------- Game Ready ----------------
function checkGameReadyToStart() {
  return Object.keys(game.players).length >= 5;
}

// ---------------- INIT BOT ----------------
async function init() {
  await db.read();
  db.data ||= { stats: {} };
  await db.write();

  bot = new TelegramBot(token, { polling: true });

  // Command /join
  bot.onText(/\/join/, msg => {
    if (game.phase && game.phase !== 'join') return bot.sendMessage(msg.chat.id, "❌ Game sedang berjalan");
    game.chatId = msg.chat.id;
    game.players[msg.from.id] = { name: msg.from.first_name, role: null, alive: true, lover: null, kills: 0 };
    bot.sendMessage(msg.chat.id, `✅ ${msg.from.first_name} bergabung!`);
  });

  // Command /leave
  bot.onText(/\/leave/, msg => {
    if (!game.players[msg.from.id]) return bot.sendMessage(msg.chat.id, "❌ Kamu belum bergabung");
    if (game.phase !== 'join') return bot.sendMessage(msg.chat.id, "❌ Tidak bisa keluar saat game berjalan");

    delete game.players[msg.from.id];
    bot.sendMessage(msg.chat.id, `👋 ${msg.from.first_name} keluar dari game.`);
  });

  // Command /play
  bot.onText(/\/play/, async msg => {
    if (!checkGameReadyToStart()) return bot.sendMessage(msg.chat.id, "Minimal 5 pemain!");

    game.id = nanoid();
    game.phase = 'join';
    bot.sendMessage(msg.chat.id, "🌙 Game dimulai! Role dibagikan...");

    const pIds = Object.keys(game.players);

    // Assign roles
    let roles = ["Werewolf", "Werewolf", "Seer", "Doctor", "Hunter", "Cupid"];
    roles = roles.concat(Array(pIds.length - roles.length).fill("Villager"));
    roles.sort(() => Math.random() - 0.5);

    pIds.forEach((id, idx) => {
      game.players[id].role = roles[idx];
      bot.sendMessage(id, `🎭 Role kamu: *${roles[idx]}*`, { parse_mode: "Markdown" });
    });

    // Cupid pick lovers
    const cupid = pIds.find(id => game.players[id].role === "Cupid");
    if (cupid) {
      const buttons = pIds.filter(id => id !== cupid).map(id => [createButton(game.players[id].name, `love_${id}`)]);
      await bot.sendMessage(cupid, "💘 Pilih 2 pemain yang menjadi Lovers:", { reply_markup: { inline_keyboard: buttons } });
    } else {
      await startNightPhase();
    }
  });

  // Command /stats
  bot.onText(/\/stats/, async msg => {
    await db.read();
    db.data.stats ||= {};
    let text = "📊 Statistik Pemain:\n";
    for (const [id, stat] of Object.entries(db.data.stats)) {
      text += `${stat.name} - Games: ${stat.gamesPlayed || 0}, Wins: ${stat.wins || 0}, Kills: ${stat.kills || 0}\n`;
    }
    bot.sendMessage(msg.chat.id, text);
  });

  // Command /leaderboard
  bot.onText(/\/leaderboard/, async msg => {
    await db.read();
    db.data.stats ||= {};
    const stats = Object.values(db.data.stats);

    stats.sort((a,b) => b.wins - a.wins || b.kills - a.kills);
    let text = "🏆 Leaderboard:\n";
    stats.slice(0, 10).forEach((s, i) => {
      text += `${i+1}. ${s.name} - Wins: ${s.wins}, Games: ${s.gamesPlayed}, Kills: ${s.kills}\n`;
    });
    bot.sendMessage(msg.chat.id, text);
  });

  // Command /stopgame
  bot.onText(/\/stopgame/, msg => {
    if (!game.id) return bot.sendMessage(msg.chat.id, "❌ Tidak ada game yang berjalan");

    resetGame();
    bot.sendMessage(msg.chat.id, "🛑 Game dihentikan oleh admin.");
  });

  // Callback queries
  bot.on('callback_query', async query => {
    const userId = query.from.id.toString();
    const data = query.data;

    // Lovers
    if (data.startsWith("love_")) {
      game.nightActions.lovers ||= [];
      const target = data.split("_")[1];
      if (!game.nightActions.lovers.includes(target) && target !== userId) {
        game.nightActions.lovers.push(target);
        await bot.answerCallbackQuery(query.id, { text: "✅ Pilihan diterima" });
      }
      if (game.nightActions.lovers.length >= 2) {
        const [l1, l2] = game.nightActions.lovers;
        game.players[l1].lover = l2;
        game.players[l2].lover = l1;
        await bot.sendMessage(game.chatId, "💘 Lovers telah dipilih!");
        await startNightPhase();
      }
      return;
    }

    // Werewolf kill
    if (data.startsWith("kill_")) {
      const targetId = data.split("_")[1];
      game.nightActions.werewolfVotes[userId] = targetId;
      await bot.answerCallbackQuery(query.id, { text: "✅ Target dipilih" });

      const aliveWerewolves = Object.entries(game.players)
        .filter(([_, p]) => p.alive && p.role === "Werewolf")
        .map(([id]) => id);

      if (aliveWerewolves.every(id => game.nightActions.werewolfVotes[id])) {
        // count votes
        const voteCounts = {};
        Object.values(game.nightActions.werewolfVotes).forEach(v => voteCounts[v] = (voteCounts[v] || 0) + 1);
        let maxVotes = 0, candidates = [];
        for (const [id, count] of Object.entries(voteCounts)) {
          if (count > maxVotes) { maxVotes = count; candidates = [id]; }
          else if (count === maxVotes) candidates.push(id);
        }
        const killedId = candidates[Math.floor(Math.random() * candidates.length)];
        game.nightActions.kill = killedId;
        checkNightDone();
      }
      return;
    }

    // Seer reveal
    if (data.startsWith("reveal_")) {
      const targetId = data.split("_")[1];
      await bot.sendMessage(userId, `👀 Role ${game.players[targetId].name}: ${game.players[targetId].role}`);
      await bot.answerCallbackQuery(query.id, { text: "✅ Role ditampilkan" });
      return;
    }

    // Doctor save
    if (data.startsWith("save_")) {
      game.nightActions.save = data.split("_")[1];
      await bot.answerCallbackQuery(query.id, { text: "✅ Target diselamatkan" });
      checkNightDone();
      return;
    }

    // Day vote
    if (data.startsWith("vote_") && game.phase === 'day') {
      game.votes[userId] = data.split("_")[1];
      await bot.answerCallbackQuery(query.id, { text: "✅ Vote diterima" });
      return;
    }
  });

  console.log('Bot siap dan polling berjalan');
}

init().catch(err => {
  console.error('Gagal inisialisasi bot:', err);
  process.exit(1);
});
