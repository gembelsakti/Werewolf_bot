// bot.js
const TelegramBot = require('node-telegram-bot-api');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const token = process.env.TOKEN; // Gunakan environment variable di Railway
const bot = new TelegramBot(token, { polling: true });

// DB setup
const adapter = new JSONFile('werewolf_db.json');
const db = new Low(adapter);
await db.read();
db.data ||= { stats: {} };
await db.write();

// Utils
const delay = ms => new Promise(res => setTimeout(res, ms));
const createButton = (text, callback_data) => ({ text, callback_data });

// GAME STATE
let game = {
  id: null,
  chatId: null,
  players: {},
  phase: null,
  nightActions: {},
  votes: {},
};

// ===== COMMANDS =====
bot.onText(/\/join/, msg => {
  if (game.phase && game.phase !== 'join') return bot.sendMessage(msg.chat.id, "❌ Game sedang berjalan");
  game.chatId = msg.chat.id;
  game.players[msg.from.id] = { name: msg.from.first_name, role: null, alive: true, lover: null, kills: 0 };
  bot.sendMessage(msg.chat.id, `✅ ${msg.from.first_name} bergabung!`);
});

bot.onText(/\/play/, async msg => {
  const pIds = Object.keys(game.players);
  if (pIds.length < 5) return bot.sendMessage(msg.chat.id, "Minimal 5 pemain!");

  game.id = nanoid();
  game.phase = 'night';
  bot.sendMessage(msg.chat.id, "🌙 Game dimulai! Role dibagikan...");

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
    bot.sendMessage(cupid, "💘 Pilih 2 pemain yang menjadi Lovers:", { reply_markup: { inline_keyboard: buttons } });
  } else startNightPhase();
});

bot.onText(/\/stats/, msg => {
  let text = "📊 Statistik Pemain:\n";
  Object.values(game.players).forEach(p => {
    text += `${p.name} - Role: ${p.role} - ${p.alive ? "✅ Hidup" : "💀 Mati"} - Kills: ${p.kills}\n`;
  });
  bot.sendMessage(msg.chat.id, text);
});

// ===== INLINE CALLBACKS =====
bot.on('callback_query', query => {
  const userId = query.from.id;
  const data = query.data;

  if (data.startsWith("love_")) {
    game.nightActions.lovers ||= [];
    if (game.nightActions.lovers.includes(data.split("_")[1])) return;
    game.nightActions.lovers.push(data.split("_")[1]);
    bot.answerCallbackQuery(query.id, { text: "✅ Pilihan diterima" });
    if (game.nightActions.lovers.length >= 2) {
      const [l1, l2] = game.nightActions.lovers;
      game.players[l1].lover = l2;
      game.players[l2].lover = l1;
      bot.sendMessage(game.chatId, "💘 Lovers telah dipilih!");
      startNightPhase();
    }
    return;
  }

  if (data.startsWith("kill_")) {
    game.nightActions.kill = data.split("_")[1];
    bot.answerCallbackQuery(query.id, { text: "✅ Target dipilih" });
    checkNightDone();
    return;
  }

  if (data.startsWith("reveal_")) {
    const targetId = data.split("_")[1];
    bot.sendMessage(userId, `👀 Role ${game.players[targetId].name}: ${game.players[targetId].role}`);
    bot.answerCallbackQuery(query.id, { text: "✅ Role ditampilkan" });
    return;
  }

  if (data.startsWith("save_")) {
    game.nightActions.save = data.split("_")[1];
    bot.answerCallbackQuery(query.id, { text: "✅ Target diselamatkan" });
    checkNightDone();
    return;
  }

  if (data.startsWith("vote_") && game.phase === 'day') {
    game.votes[userId] = data.split("_")[1];
    bot.answerCallbackQuery(query.id, { text: "✅ Vote diterima" });
  }
});

// ===== NIGHT PHASE =====
async function startNightPhase() {
  game.phase = 'night';
  game.nightActions = {};
  bot.sendMessage(game.chatId, "🌙 Malam tiba! Pemain yang beraksi, lakukan pilihan sekarang!");

  // Countdown Malam
  for (let t = 10; t > 0; t--) {
    await delay(1000);
    bot.sendMessage(game.chatId, `🌙 Malam: ${t} detik tersisa`);
  }

  const alive = Object.entries(game.players).filter(([id, p]) => p.alive);

  const wolf = alive.find(([id, p]) => p.role === "Werewolf");
  if (wolf) {
    const [wolfId] = wolf;
    const buttons = alive.filter(([id]) => id !== wolfId).map(([id, p]) => [createButton(p.name, `kill_${id}`)]);
    bot.sendMessage(wolfId, "Pilih siapa yang ingin dibunuh:", { reply_markup: { inline_keyboard: buttons } });
  }

  const seer = alive.find(([id, p]) => p.role === "Seer");
  if (seer) {
    const [seerId] = seer;
    const buttons = alive.filter(([id]) => id !== seerId).map(([id, p]) => [createButton(p.name, `reveal_${id}`)]);
    bot.sendMessage(seerId, "Pilih siapa yang ingin dilihat role-nya:", { reply_markup: { inline_keyboard: buttons } });
  }

  const doc = alive.find(([id, p]) => p.role === "Doctor");
  if (doc) {
    const [docId] = doc;
    const buttons = alive.map(([id, p]) => [createButton(p.name, `save_${id}`)]);
    bot.sendMessage(docId, "Pilih siapa yang ingin diselamatkan:", { reply_markup: { inline_keyboard: buttons } });
  }

  setTimeout(resolveNight, 15000);
}

function checkNightDone() {
  if (game.nightActions.kill && game.nightActions.save) resolveNight();
}

// Night & day resolve logic sama seperti versi sebelumnya
// Tambahkan startDayPhase(), resolveVoting(), checkWinCondition(), resetGame() sesuai script final sebelumnya
// (untuk mempersingkat, logika lengkap tetap sama)
