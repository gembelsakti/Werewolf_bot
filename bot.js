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

const delay = ms => new Promise(res => setTimeout(res, ms));
const createButton = (text, callback_data) => ({ text, callback_data });

let bot;

let game = {
  id: null,
  chatId: null,
  players: {}, // { userId: { name, role, alive, lover, kills } }
  phase: null, // 'join' | 'night' | 'day'
  nightActions: {}, // { lovers: [], kill: null, save: null }
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
  if (aliveWerewolves === 0) return 'villagers';
  if (aliveWerewolves >= aliveVillagers) return 'werewolves';
  return null;
}

async function announceWinner(winner) {
  await bot.sendMessage(game.chatId, `🏆 Game selesai! Pemenang: *${winner.toUpperCase()}*`, { parse_mode: 'Markdown' });
  // Update win stats
  await db.read();
  db.data.stats ||= {};
  for (const [id, p] of Object.entries(game.players)) {
    db.data.stats[id] ||= { name: p.name, kills: 0, gamesPlayed: 0, wins: 0 };
    if ((winner === 'villagers' && p.role !== 'Werewolf') ||
        (winner === 'werewolves' && p.role === 'Werewolf')) {
      db.data.stats[id].wins += 1;
    }
  }
  await db.write();
  resetGame();
}

async function startDayPhase() {
  game.phase = 'day';
  game.nightActions = {};
  game.votes = {};
  await bot.sendMessage(game.chatId, '☀️ Siang hari tiba! Diskusi dan voting dimulai. Pilih siapa yang akan dihukum mati.');

  const alive = Object.entries(game.players).filter(([_, p]) => p.alive);
  const buttons = alive.map(([id, p]) => [createButton(p.name, `vote_${id}`)]);

  await bot.sendMessage(game.chatId, '🗳️ Klik tombol untuk voting:', {
    reply_markup: { inline_keyboard: buttons },
  });

  // Day countdown 30 detik
  for (let t = 30; t > 0; t--) {
    await delay(1000);
    await bot.sendMessage(game.chatId, `☀️ Siang: ${t} detik tersisa`);
  }

  // Hitung voting
  await resolveVoting();
}

async function resolveVoting() {
  const voteCounts = {};
  for (const targetId of Object.values(game.votes)) {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  }
  let maxVotes = 0;
  let candidates = [];
  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      candidates = [targetId];
    } else if (count === maxVotes) {
      candidates.push(targetId);
    }
  }

  if (candidates.length !== 1 || maxVotes === 0) {
    await bot.sendMessage(game.chatId, '⚠️ Voting seri atau tidak ada voting. Tidak ada yang dihukum mati.');
  } else {
    const killedId = candidates[0];
    game.players[killedId].alive = false;
    await bot.sendMessage(game.chatId, `☠️ ${game.players[killedId].name} telah dihukum mati! Role: *${game.players[killedId].role}*`, { parse_mode: 'Markdown' });

    if (game.players[killedId].role === 'Hunter' && game.players[killedId].alive === false) {
      // Hunter retaliation logic, misalnya bunuh pemain lain (bisa dikembangkan)
      await bot.sendMessage(game.chatId, `🏹 Hunter menyerang sebelum mati!`);
    }

    const winner = isGameOver();
    if (winner) {
      await announceWinner(winner);
      return;
    }
  }
  // Lanjut malam berikutnya
  await startNightPhase();
}

async function resolveNight() {
  const killId = game.nightActions.kill;
  const saveId = game.nightActions.save;

  if (killId && killId !== saveId) {
    game.players[killId].alive = false;
    game.players[game.nightActions.kill].kills++;
    await bot.sendMessage(game.chatId, `☠️ ${game.players[killId].name} dibunuh semalam! Role: *${game.players[killId].role}*`, { parse_mode: 'Markdown' });

    const winner = isGameOver();
    if (winner) {
      await announceWinner(winner);
      return;
    }
  } else {
    await bot.sendMessage(game.chatId, `💊 Tidak ada kematian semalam.`);
  }
  // lanjut fase siang
  await startDayPhase();
}

function checkNightDone() {
  if (game.nightActions.kill && game.nightActions.save) {
    resolveNight().catch(console.error);
  }
}

async function startNightPhase() {
  game.phase = 'night';
  game.nightActions = {};
  await bot.sendMessage(game.chatId, "🌙 Malam tiba! Pemain yang beraksi, lakukan pilihan sekarang!");

  const alive = Object.entries(game.players).filter(([_, p]) => p.alive);

  // Kirim pesan countdown malam (15 detik)
  for (let t = 15; t > 0; t--) {
    await delay(1000);
    await bot.sendMessage(game.chatId, `🌙 Malam: ${t} detik tersisa`);
  }

  // Werewolf kill
  const wolf = alive.find(([_, p]) => p.role === "Werewolf");
  if (wolf) {
    const [wolfId] = wolf;
    const buttons = alive.filter(([id]) => id !== wolfId).map(([id, p]) => [createButton(p.name, `kill_${id}`)]);
    await bot.sendMessage(wolfId, "Pilih siapa yang ingin dibunuh:", { reply_markup: { inline_keyboard: buttons } });
  }

  // Seer reveal
  const seer = alive.find(([_, p]) => p.role === "Seer");
  if (seer) {
    const [seerId] = seer;
    const buttons = alive.filter(([id]) => id !== seerId).map(([id, p]) => [createButton(p.name, `reveal_${id}`)]);
    await bot.sendMessage(seerId, "Pilih siapa yang ingin dilihat role-nya:", { reply_markup: { inline_keyboard: buttons } });
  }

  // Doctor save
  const doc = alive.find(([_, p]) => p.role === "Doctor");
  if (doc) {
    const [docId] = doc;
    const buttons = alive.map(([id, p]) => [createButton(p.name, `save_${id}`)]);
    await bot.sendMessage(docId, "Pilih siapa yang ingin diselamatkan:", { reply_markup: { inline_keyboard: buttons } });
  }
}

function checkGameReadyToStart() {
  return Object.keys(game.players).length >= 5;
}

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

  // Command /play
  bot.onText(/\/play/, async msg => {
    if (!checkGameReadyToStart()) return bot.sendMessage(msg.chat.id, "Minimal 5 pemain!");

    game.id = nanoid();
    game.phase = 'join';
    bot.sendMessage(msg.chat.id, "🌙 Game dimulai! Role dibagikan...");

    const pIds = Object.keys(game.players);

    // Assign roles
    let roles = ["Werewolf", "Seer", "Doctor", "Hunter", "Cupid"];
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

  // Callback query
  bot.on('callback_query', async query => {
    const userId = query.from.id.toString();
    const data = query.data;

    if (data.startsWith("love_")) {
      game.nightActions.lovers ||= [];
      const target = data.split("_")[1];
      if (!game.nightActions.lovers.includes(target)) {
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

    if (data.startsWith("kill_")) {
      game.nightActions.kill = data.split("_")[1];
      await bot.answerCallbackQuery(query.id, { text: "✅ Target dipilih" });
      checkNightDone();
      return;
    }

    if (data.startsWith("reveal_")) {
      const targetId = data.split("_")[1];
      await bot.sendMessage(userId, `👀 Role ${game.players[targetId].name}: ${game.players[targetId].role}`);
      await bot.answerCallbackQuery(query.id, { text: "✅ Role ditampilkan" });
      return;
    }

    if (data.startsWith("save_")) {
      game.nightActions.save = data.split("_")[1];
      await bot.answerCallbackQuery(query.id, { text: "✅ Target diselamatkan" });
      checkNightDone();
      return;
    }

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
