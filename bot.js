// ================= INIT =================
const TelegramBot = require('node-telegram-bot-api');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const token = process.env.TOKEN;
if (!token) throw new Error("TOKEN belum diset");

const bot = new TelegramBot(token, { polling: true });
const db = new Low(new JSONFile('werewolf_db.json'));

(async () => {
  await db.read();
  db.data ||= { stats: {} };
  await db.write();
})();

const games = {};
const WOLF_ROLES = ['Werewolf','AlphaWolf','WolfCub','WolfMan','SnowWolf'];

// ================= UTIL =================
function narrate(type, name = '') {
  const t = {
    night: [
      '🌙 Malam sunyi menyelimuti desa...',
      '🌙 Kabut turun, pintu-pintu tertutup rapat...',
      '🌙 Angin dingin berhembus di desa...'
    ],
    day: [
      '☀️ Matahari terbit, warga mulai berkumpul...',
      '☀️ Desa kembali ramai oleh bisik-bisik...',
      '☀️ Pagi membuka rahasia malam...'
    ],
    kill: [
      `☠️ ${name} ditemukan tak bernyawa.`,
      `🩸 Jeritan terdengar... ${name} mati.`,
      `⚰️ Desa berduka. ${name} tewas.`
    ],
    vote: [
      `⚖️ Warga sepakat. ${name} dihukum.`,
      `🔥 Amarah massa menimpa ${name}.`,
      `🗳️ Voting berakhir, ${name} dieliminasi.`
    ]
  };
  return t[type][Math.floor(Math.random() * t[type].length)];
}

function getGame(chatId) {
  games[chatId] ||= {
    id: nanoid(),
    chatId,
    phase: 'join',
    players: {},
    votes: {},
    night: {},
    lastProtected: null,
    mainMessageId: null
  };
  return games[chatId];
}

function alive(game) {
  return Object.entries(game.players).filter(([_, p]) => p.alive);
}

function wolves(game) {
  return alive(game).filter(([_, p]) => WOLF_ROLES.includes(p.role));
}

async function clearKeyboard(game) {
  if (!game.mainMessageId) return;
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: game.chatId, message_id: game.mainMessageId }
    );
  } catch {}
}

// ================= ROLE ASSIGN =================
function assignRoles(game) {
  const ids = Object.keys(game.players);
  const n = ids.length;
  const wolfCount = Math.max(1, Math.floor(n / 4));

  let roles = [
    'Seer','GuardianAngel','Hunter','Gunner','Chemist',
    'AlphaWolf','WolfCub','WolfMan','SnowWolf','Lycan','Doppelganger'
  ];

  while (roles.filter(r => WOLF_ROLES.includes(r)).length < wolfCount)
    roles.push('Werewolf');

  roles = roles.slice(0, n);
  while (roles.length < n) roles.push('Villager');
  roles.sort(() => Math.random() - 0.5);

  ids.forEach((id, i) => {
    const r = roles[i];
    game.players[id] = {
      ...game.players[id],
      role: r,
      alive: true,
      kills: 0,
      used: {}
    };
    bot.sendMessage(id, `🎭 Role kamu: *${r}*`, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(game.chatId, `⚠️ ${game.players[id].name} belum /start bot`));
  });
}

// ================= WIN =================
function checkWin(game) {
  const w = wolves(game).length;
  const v = alive(game).length - w;
  if (w === 0) return 'Villagers';
  if (w >= v) return 'Werewolves';
  return null;
}

async function endGame(game, winner) {
  await clearKeyboard(game);
  await bot.editMessageText(
    `🏆 *${winner} MENANG!*`,
    { chat_id: game.chatId, message_id: game.mainMessageId, parse_mode: 'Markdown' }
  );

  await db.read();
  for (const [id, p] of Object.entries(game.players)) {
    db.data.stats[id] ||= { name: p.name, games: 0, wins: 0, kills: 0 };
    db.data.stats[id].games++;
    db.data.stats[id].kills += p.kills;
    if (
      (winner === 'Villagers' && !WOLF_ROLES.includes(p.role)) ||
      (winner === 'Werewolves' && WOLF_ROLES.includes(p.role))
    ) db.data.stats[id].wins++;
  }
  await db.write();
  delete games[game.chatId];
}

// ================= NIGHT =================
async function startNight(game) {
  game.phase = 'night';
  game.night = { kill: null, protect: null };

  if (!game.mainMessageId) {
    const msg = await bot.sendMessage(game.chatId, narrate('night'));
    game.mainMessageId = msg.message_id;
  } else {
    await bot.editMessageText(
      narrate('night'),
      { chat_id: game.chatId, message_id: game.mainMessageId }
    );
  }

  // Werewolf
  wolves(game).forEach(([id]) => {
    const btn = alive(game)
      .filter(([pid]) => pid !== id)
      .map(([pid, p]) => [{ text: p.name, callback_data: `kill_${pid}` }]);
    bot.sendMessage(id, '🐺 Pilih target', { reply_markup: { inline_keyboard: btn } });
  });

  // Seer
  alive(game).filter(([_, p]) => p.role === 'Seer' && !p.used.seer)
    .forEach(([id]) => {
      const btn = alive(game)
        .filter(([pid]) => pid !== id)
        .map(([pid, p]) => [{ text: p.name, callback_data: `see_${pid}` }]);
      bot.sendMessage(id, '👁️ Cek role', { reply_markup: { inline_keyboard: btn } });
    });

  // Guardian Angel
  alive(game).filter(([_, p]) => p.role === 'GuardianAngel')
    .forEach(([id]) => {
      const btn = alive(game)
        .filter(([pid]) => pid !== game.lastProtected)
        .map(([pid, p]) => [{ text: p.name, callback_data: `protect_${pid}` }]);
      bot.sendMessage(id, '👼 Lindungi', { reply_markup: { inline_keyboard: btn } });
    });

  setTimeout(() => resolveNight(game), 120000);
}

async function resolveNight(game) {
  if (game.phase !== 'night') return;
  await clearKeyboard(game);

  if (game.night.kill && game.night.kill !== game.night.protect) {
    const t = game.night.kill;
    game.players[t].alive = false;
    wolves(game).forEach(([id]) => game.players[id].kills++);
    await bot.editMessageText(
      narrate('kill', game.players[t].name),
      { chat_id: game.chatId, message_id: game.mainMessageId }
    );
  } else {
    await bot.editMessageText(
      '💊 Tidak ada kematian malam ini.',
      { chat_id: game.chatId, message_id: game.mainMessageId }
    );
  }

  const win = checkWin(game);
  if (win) return endGame(game, win);
  startDay(game);
}

// ================= DAY =================
async function startDay(game) {
  game.phase = 'day';
  game.votes = {};

  await bot.editMessageText(
    narrate('day'),
    { chat_id: game.chatId, message_id: game.mainMessageId }
  );

  const btn = alive(game).map(([id, p]) => [{ text: p.name, callback_data: `vote_${id}` }]);
  await bot.editMessageReplyMarkup(
    { inline_keyboard: btn },
    { chat_id: game.chatId, message_id: game.mainMessageId }
  );

  setTimeout(() => resolveDay(game), 180000);
}

async function resolveDay(game) {
  if (game.phase !== 'day') return;
  await clearKeyboard(game);

  const c = {};
  Object.values(game.votes).forEach(v => c[v] = (c[v] || 0) + 1);
  const target = Object.keys(c).sort((a, b) => c[b] - c[a])[0];

  if (target) {
    game.players[target].alive = false;
    await bot.editMessageText(
      narrate('vote', game.players[target].name),
      { chat_id: game.chatId, message_id: game.mainMessageId }
    );
  }

  const win = checkWin(game);
  if (win) return endGame(game, win);
  startNight(game);
}

// ================= COMMAND =================
bot.onText(/\/join/, msg => {
  const g = getGame(msg.chat.id);
  if (g.phase !== 'join') return;
  g.players[msg.from.id] = { name: msg.from.first_name, alive: true, kills: 0, used: {} };
  bot.sendMessage(msg.chat.id, `✅ ${msg.from.first_name} join`);
});

bot.onText(/\/play/, msg => {
  const g = getGame(msg.chat.id);
  if (Object.keys(g.players).length < 5)
    return bot.sendMessage(msg.chat.id, 'Minimal 5 pemain');
  assignRoles(g);
  startNight(g);
});

bot.onText(/\/stopgame/, msg => {
  delete games[msg.chat.id];
  bot.sendMessage(msg.chat.id, '🛑 Game dihentikan admin');
});

bot.onText(/\/forcenight/, msg => {
  const g = games[msg.chat.id];
  if (!g) return;
  startNight(g);
});

// ================= STATS =================
bot.onText(/\/stats/, async msg => {
  await db.read();
  let t = '📊 Statistik:\n';
  for (const s of Object.values(db.data.stats))
    t += `${s.name} | Game:${s.games} Win:${s.wins} Kill:${s.kills}\n`;
  bot.sendMessage(msg.chat.id, t);
});

bot.onText(/\/leaderboard/, async msg => {
  await db.read();
  const arr = Object.values(db.data.stats)
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
    .slice(0, 10);
  let t = '🏆 Leaderboard:\n';
  arr.forEach((s, i) => t += `${i + 1}. ${s.name} W:${s.wins} K:${s.kills}\n`);
  bot.sendMessage(msg.chat.id, t);
});

// ================= CALLBACK =================
bot.on('callback_query', q => {
  const g = games[q.message.chat.id];
  if (!g) return;
  const uid = q.from.id;
  if (!g.players[uid] || !g.players[uid].alive) return;

  const d = q.data;
  if (d.startsWith('kill_')) g.night.kill = d.split('_')[1];
  if (d.startsWith('protect_')) {
    g.night.protect = d.split('_')[1];
    g.lastProtected = d.split('_')[1];
  }
  if (d.startsWith('see_')) {
    const t = d.split('_')[1];
    bot.sendMessage(uid, `👁️ ${g.players[t].name}: ${g.players[t].role}`);
    g.players[uid].used.seer = true;
  }
  if (d.startsWith('vote_') && g.phase === 'day')
    g.votes[uid] = d.split('_')[1];

  bot.answerCallbackQuery(q.id);
});

console.log('🐺 Werewolf Bot v4 READY');
