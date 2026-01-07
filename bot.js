// ================== INIT ==================
const TelegramBot = require('node-telegram-bot-api');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');

const token = process.env.TOKEN;
if (!token) throw new Error("TOKEN belum diset");

const bot = new TelegramBot(token, { polling: true });
const db = new Low(new JSONFile('werewolf_db.json'));

const games = {}; // multi game support

// ================== GAME FACTORY ==================
function createGame(chatId) {
  return {
    id: nanoid(),
    chatId,
    phase: 'join',
    players: {},
    votes: {},
    night: {},
    lastProtected: null
  };
}

// ================== UTIL ==================
function alivePlayers(game) {
  return Object.entries(game.players).filter(([_, p]) => p.alive);
}

function wolves(game) {
  return alivePlayers(game).filter(([_, p]) =>
    ['Werewolf','AlphaWolf','WolfCub','WolfMan','SnowWolf'].includes(p.role)
  );
}

// ================== ROLE ASSIGN ==================
function assignRoles(game) {
  const ids = Object.keys(game.players);
  const n = ids.length;
  const wolfCount = Math.max(1, Math.floor(n / 4));

  let roles = [];

  roles.push('Seer','GuardianAngel','Hunter','Gunner');
  roles.push('AlphaWolf','WolfCub');

  while (roles.filter(r => r.includes('Wolf')).length < wolfCount) {
    roles.push('Werewolf');
  }

  roles.push('WolfMan','SnowWolf','Lycan','Chemist','Doppelganger');

  roles = roles.slice(0, n);
  while (roles.length < n) roles.push('Villager');

  roles.sort(() => Math.random() - 0.5);

  ids.forEach((id,i)=>{
    game.players[id].role = roles[i];
    bot.sendMessage(id, `🎭 Role kamu: *${roles[i]}*`, { parse_mode:'Markdown' });
  });
}

// ================== GAME LOGIC ==================
function checkWin(game) {
  const alive = alivePlayers(game);
  const wolfAlive = wolves(game).length;
  const villAlive = alive.length - wolfAlive;

  if (wolfAlive === 0) return 'Villagers';
  if (wolfAlive >= villAlive) return 'Werewolves';
  return null;
}

async function endGame(game, winner) {
  await bot.sendMessage(game.chatId, `🏆 *${winner} MENANG!*`, { parse_mode:'Markdown' });
  delete games[game.chatId];
}

// ================== NIGHT ==================
async function startNight(game) {
  game.phase = 'night';
  game.night = {
    wolfVotes:{},
    kill:null,
    protect:null,
    used:{}
  };

  await bot.sendMessage(game.chatId, "🌙 Malam tiba.");

  // Werewolf
  wolves(game).forEach(([id])=>{
    const buttons = alivePlayers(game)
      .filter(([pid])=>pid!==id)
      .map(([pid,p])=>[{ text:p.name, callback_data:`kill_${pid}`}]);

    bot.sendMessage(id,"🐺 Pilih target:",{reply_markup:{inline_keyboard:buttons}});
  });

  // Seer
  const seer = alivePlayers(game).find(([_,p])=>p.role==='Seer');
  if (seer) {
    const [id] = seer;
    const buttons = alivePlayers(game)
      .filter(([pid])=>pid!==id)
      .map(([pid,p])=>[{ text:p.name, callback_data:`see_${pid}`}]);
    bot.sendMessage(id,"👁️ Cek role:",{reply_markup:{inline_keyboard:buttons}});
  }

  // Guardian Angel
  const ga = alivePlayers(game).find(([_,p])=>p.role==='GuardianAngel');
  if (ga) {
    const [id] = ga;
    const buttons = alivePlayers(game)
      .filter(([pid])=>pid!==game.lastProtected)
      .map(([pid,p])=>[{ text:p.name, callback_data:`protect_${pid}`}]);
    bot.sendMessage(id,"👼 Lindungi:",{reply_markup:{inline_keyboard:buttons}});
  }

  setTimeout(()=>resolveNight(game),15000);
}

async function resolveNight(game) {
  if (game.phase!=='night') return;

  const kill = game.night.kill;
  const save = game.night.protect;

  if (kill && kill!==save) {
    game.players[kill].alive=false;
    wolves(game).forEach(([id])=>game.players[id].kills++);
    await bot.sendMessage(game.chatId,`☠️ ${game.players[kill].name} mati.`);
  } else {
    await bot.sendMessage(game.chatId,"💊 Tidak ada kematian.");
  }

  const win = checkWin(game);
  if (win) return endGame(game,win);

  startDay(game);
}

// ================== DAY ==================
async function startDay(game) {
  game.phase='day';
  game.votes={};

  await bot.sendMessage(game.chatId,"☀️ Diskusi & voting dimulai.");

  const buttons = alivePlayers(game)
    .map(([id,p])=>[{ text:p.name, callback_data:`vote_${id}`}]);

  await bot.sendMessage(game.chatId,"🗳️ Voting:",{reply_markup:{inline_keyboard:buttons}});

  setTimeout(()=>resolveDay(game),30000);
}

async function resolveDay(game) {
  if (game.phase!=='day') return;

  const counts={};
  Object.values(game.votes).forEach(v=>counts[v]=(counts[v]||0)+1);

  let max=0,target=null;
  for (const id in counts) {
    if (counts[id]>max) { max=counts[id]; target=id; }
  }

  if (target) {
    game.players[target].alive=false;
    await bot.sendMessage(game.chatId,`☠️ ${game.players[target].name} dihukum.`);
  }

  const win = checkWin(game);
  if (win) return endGame(game,win);

  startNight(game);
}

// ================== COMMAND ==================
bot.onText(/\/join/, msg=>{
  const chatId=msg.chat.id;
  games[chatId] ||= createGame(chatId);
  const game=games[chatId];

  if (game.phase!=='join') return;
  game.players[msg.from.id]={
    name:msg.from.first_name,
    role:null,
    alive:true,
    kills:0
  };
  bot.sendMessage(chatId,`✅ ${msg.from.first_name} bergabung`);
});

bot.onText(/\/play/, msg=>{
  const game=games[msg.chat.id];
  if (!game || Object.keys(game.players).length<5)
    return bot.sendMessage(msg.chat.id,"Minimal 5 pemain");

  assignRoles(game);
  startNight(game);
});

// ================== CALLBACK ==================
bot.on('callback_query', q=>{
  const chatId=q.message.chat.id;
  const game=games[chatId];
  if (!game) return;

  const uid=q.from.id;
  if (!game.players[uid] || !game.players[uid].alive) return;

  const data=q.data;

  if (data.startsWith('kill_')) {
    game.night.wolfVotes[uid]=data.split('_')[1];
    const votes=Object.values(game.night.wolfVotes);
    if (votes.length===wolves(game).length) {
      game.night.kill=votes[Math.floor(Math.random()*votes.length)];
    }
  }

  if (data.startsWith('protect_')) {
    game.night.protect=data.split('_')[1];
    game.lastProtected=data.split('_')[1];
  }

  if (data.startsWith('see_')) {
    const t=data.split('_')[1];
    bot.sendMessage(uid,`👁️ ${game.players[t].name}: ${game.players[t].role}`);
  }

  if (data.startsWith('vote_') && game.phase==='day') {
    game.votes[uid]=data.split('_')[1];
  }

  bot.answerCallbackQuery(q.id);
});

// ================== ABOUT COMMAND ==================
const about = {
  VG:"👱 Villager\nTidak punya kemampuan.",
  WW:"🐺 Werewolf\nBunuh tiap malam.",
  Seer:"👁️ Seer\nCek role tiap malam.",
  Gunner:"🔫 Gunner\nTembak 1x siang.",
  GA:"👼 Guardian Angel\nLindungi malam.",
  DG:"🎭 Doppelgänger\nCopy role target.",
  Hunter:"🎯 Hunter\nBalas saat mati.",
  Chemist:"👨‍🔬 Chemist\nPoison & Heal.",
  AlphaWolf:"⚡ Alpha Wolf\nVote 2x.",
  WolfCub:"🐶 Wolf Cub\nRage jika Alpha mati.",
  WolfMan:"👱🌚 WolfMan\nSeer lihat Villager.",
  Lycan:"🐺🌝 Lycan\nSeer lihat Wolf.",
  SnowWolf:"🐺☃️ Snow Wolf\nKill tanpa reveal."
};

Object.keys(about).forEach(k=>{
  bot.onText(new RegExp(`/about${k}`),msg=>{
    bot.sendMessage(msg.chat.id,about[k]);
  });
});

console.log("🐺 Werewolf Bot v2 READY");
