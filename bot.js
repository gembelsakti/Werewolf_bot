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
    night: ['🌙 Malam sunyi menyelimuti desa...','🌙 Kabut tebal turun...'],
    day: ['☀️ Pagi tiba, warga berkumpul...','☀️ Desa kembali hidup...'],
    kill: [`☠️ ${name} ditemukan tewas.`,`🩸 ${name} menjadi korban.`],
    vote: [`⚖️ ${name} dihukum massa.`,`🔥 ${name} dieliminasi.`]
  };
  return t[type][Math.floor(Math.random()*t[type].length)];
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
    mainMessageId: null,
    wolfRage: false
  };
  return games[chatId];
}

const alive = g => Object.entries(g.players).filter(([_,p])=>p.alive);
const wolves = g => alive(g).filter(([_,p])=>WOLF_ROLES.includes(p.role));

async function clearKeyboard(g){
  if(!g.mainMessageId) return;
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id:g.chatId, message_id:g.mainMessageId }
    );
  } catch {}
}

// ================= ROLE ASSIGN =================
function assignRoles(game){
  const ids = Object.keys(game.players);
  const n = ids.length;
  const wolfCount = Math.max(1, Math.floor(n/4));

  let roles = [
    'Seer','GuardianAngel','Hunter','Gunner','Chemist',
    'AlphaWolf','WolfCub','WolfMan','SnowWolf','Lycan','Doppelganger'
  ];

  while (roles.filter(r=>WOLF_ROLES.includes(r)).length < wolfCount)
    roles.push('Werewolf');

  roles = roles.slice(0,n);
  while(roles.length<n) roles.push('Villager');
  roles.sort(()=>Math.random()-0.5);

  ids.forEach((id,i)=>{
    game.players[id] = {
      ...game.players[id],
      role: roles[i],
      alive:true,
      kills:0,
      used:{}
    };
    bot.sendMessage(id,`🎭 Role kamu: *${roles[i]}*`,{parse_mode:'Markdown'})
      .catch(()=>bot.sendMessage(game.chatId,`⚠️ ${game.players[id].name} belum /start bot`));
  });
}

// ================= WIN =================
function checkWin(g){
  const w = wolves(g).length;
  const v = alive(g).length - w;
  if (w===0) return 'Villagers';
  if (w>=v) return 'Werewolves';
  return null;
}

async function endGame(g,winner){
  await clearKeyboard(g);
  await bot.editMessageText(
    `🏆 *${winner} MENANG!*`,
    {chat_id:g.chatId,message_id:g.mainMessageId,parse_mode:'Markdown'}
  );

  await db.read();
  for(const [id,p] of Object.entries(g.players)){
    db.data.stats[id] ||= {name:p.name,games:0,wins:0,kills:0};
    db.data.stats[id].games++;
    db.data.stats[id].kills+=p.kills;
    if(
      (winner==='Villagers'&&!WOLF_ROLES.includes(p.role))||
      (winner==='Werewolves'&&WOLF_ROLES.includes(p.role))
    ) db.data.stats[id].wins++;
  }
  await db.write();
  delete games[g.chatId];
}

// ================= NIGHT =================
async function startNight(g){
  g.phase='night';
  g.night={ wolfVotes:{}, kill:null, protect:null, poison:null };

  if(!g.mainMessageId){
    const m=await bot.sendMessage(g.chatId,narrate('night'));
    g.mainMessageId=m.message_id;
  } else {
    await bot.editMessageText(narrate('night'),{
      chat_id:g.chatId,message_id:g.mainMessageId
    });
  }

  // WEREWOLF VOTE
  wolves(g).forEach(([id,p])=>{
    const btn=alive(g).filter(([pid])=>pid!==id)
      .map(([pid,pl])=>[{text:pl.name,callback_data:`kill_${pid}`}]);
    bot.sendMessage(id,'🐺 Pilih target',{reply_markup:{inline_keyboard:btn}});
  });

  // SEER
  alive(g).filter(([_,p])=>p.role==='Seer'&&!p.used.seer)
    .forEach(([id])=>{
      const btn=alive(g).filter(([pid])=>pid!==id)
        .map(([pid,pl])=>[{text:pl.name,callback_data:`see_${pid}`}]);
      bot.sendMessage(id,'👁️ Cek role',{reply_markup:{inline_keyboard:btn}});
    });

  // GA
  alive(g).filter(([_,p])=>p.role==='GuardianAngel')
    .forEach(([id])=>{
      const btn=alive(g).filter(([pid])=>pid!==g.lastProtected)
        .map(([pid,pl])=>[{text:pl.name,callback_data:`protect_${pid}`}]);
      bot.sendMessage(id,'👼 Lindungi',{reply_markup:{inline_keyboard:btn}});
    });

  // CHEMIST
  alive(g).filter(([_,p])=>p.role==='Chemist')
    .forEach(([id,p])=>{
      const btn=[];
      if(!p.used.heal)
        btn.push(...alive(g).map(([pid,pl])=>[{text:`💊 ${pl.name}`,callback_data:`heal_${pid}`}]));
      if(!p.used.poison)
        btn.push(...alive(g).map(([pid,pl])=>[{text:`☠️ ${pl.name}`,callback_data:`poison_${pid}`}]));
      if(btn.length)
        bot.sendMessage(id,'👨‍🔬 Aksi Chemist',{reply_markup:{inline_keyboard:btn}});
    });

  setTimeout(()=>resolveNight(g),120000);
}

async function resolveNight(g){
  if(g.phase!=='night')return;
  await clearKeyboard(g);

  let dead=[];

  // wolf vote tally
  const tally={};
  for(const [uid,t] of Object.entries(g.night.wolfVotes)){
    const r=g.players[uid].role;
    const weight=r==='AlphaWolf'?2:1;
    tally[t]=(tally[t]||0)+weight;
  }
  g.night.kill=Object.keys(tally).sort((a,b)=>tally[b]-tally[a])[0];

  if(g.night.kill && g.night.kill!==g.night.protect){
    dead.push(g.night.kill);
  }
  if(g.night.poison) dead.push(g.night.poison);

  dead.forEach(id=>{
    if(g.players[id]?.alive){
      g.players[id].alive=false;
      wolves(g).forEach(([wid])=>g.players[wid].kills++);
    }
  });

  if(dead.length){
    await bot.editMessageText(
      narrate('kill',g.players[dead[0]].name),
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );
  } else {
    await bot.editMessageText(
      '💊 Tidak ada kematian malam ini.',
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );
  }

  const win=checkWin(g);
  if(win) return endGame(g,win);
  startDay(g);
}

// ================= DAY =================
async function startDay(g){
  g.phase='day';
  g.votes={};

  await bot.editMessageText(
    narrate('day'),
    {chat_id:g.chatId,message_id:g.mainMessageId}
  );

  const btn=alive(g).map(([id,p])=>[{text:p.name,callback_data:`vote_${id}`}]);
  await bot.editMessageReplyMarkup(
    {inline_keyboard:btn},
    {chat_id:g.chatId,message_id:g.mainMessageId}
  );

  setTimeout(()=>resolveDay(g),180000);
}

async function resolveDay(g){
  if(g.phase!=='day')return;
  await clearKeyboard(g);

  const c={};
  Object.values(g.votes).forEach(v=>c[v]=(c[v]||0)+1);
  const target=Object.keys(c).sort((a,b)=>c[b]-c[a])[0];

  if(target){
    g.players[target].alive=false;
    await bot.editMessageText(
      narrate('vote',g.players[target].name),
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );
  }

  const win=checkWin(g);
  if(win) return endGame(g,win);
  startNight(g);
}

// ================= COMMAND =================
bot.onText(/\/join/,msg=>{
  const g=getGame(msg.chat.id);
  if(g.phase!=='join')return;
  g.players[msg.from.id]={name:msg.from.first_name,alive:true,kills:0,used:{}};
  bot.sendMessage(msg.chat.id,`✅ ${msg.from.first_name} join`);
});

bot.onText(/\/play/,msg=>{
  const g=getGame(msg.chat.id);
  if(Object.keys(g.players).length<5)
    return bot.sendMessage(msg.chat.id,'Minimal 5 pemain');
  assignRoles(g);
  startNight(g);
});

bot.onText(/\/stopgame/,async msg=>{
  const admins=await bot.getChatAdministrators(msg.chat.id);
  if(!admins.some(a=>a.user.id===msg.from.id)) return;
  delete games[msg.chat.id];
  bot.sendMessage(msg.chat.id,'🛑 Game dihentikan admin');
});

bot.onText(/\/forcenight/,async msg=>{
  const admins=await bot.getChatAdministrators(msg.chat.id);
  if(!admins.some(a=>a.user.id===msg.from.id)) return;
  const g=games[msg.chat.id];
  if(g) startNight(g);
});

// ================= STATS =================
bot.onText(/\/stats/,async msg=>{
  await db.read();
  let t='📊 Statistik:\n';
  for(const s of Object.values(db.data.stats))
    t+=`${s.name} | G:${s.games} W:${s.wins} K:${s.kills}\n`;
  bot.sendMessage(msg.chat.id,t);
});

bot.onText(/\/leaderboard/,async msg=>{
  await db.read();
  const arr=Object.values(db.data.stats)
    .sort((a,b)=>b.wins-a.wins||b.kills-a.kills).slice(0,10);
  let t='🏆 Leaderboard:\n';
  arr.forEach((s,i)=>t+=`${i+1}. ${s.name} W:${s.wins} K:${s.kills}\n`);
  bot.sendMessage(msg.chat.id,t);
});

// ================= CALLBACK =================
bot.on('callback_query',q=>{
  const g=games[q.message.chat.id];
  if(!g)return;
  const uid=q.from.id;
  if(!g.players[uid]?.alive)return;

  const d=q.data;

  if(d.startsWith('kill_')) g.night.wolfVotes[uid]=d.split('_')[1];
  if(d.startsWith('protect_')){
    g.night.protect=d.split('_')[1];
    g.lastProtected=d.split('_')[1];
  }
  if(d.startsWith('see_')){
    const t=d.split('_')[1];
    let seen=g.players[t].role;
    if(seen==='WolfMan') seen='Villager';
    if(seen==='Lycan') seen='Werewolf';
    bot.sendMessage(uid,`👁️ ${g.players[t].name}: ${seen}`);
    g.players[uid].used.seer=true;
  }
  if(d.startsWith('heal_')){
    g.night.protect=d.split('_')[1];
    g.players[uid].used.heal=true;
  }
  if(d.startsWith('poison_')){
    g.night.poison=d.split('_')[1];
    g.players[uid].used.poison=true;
  }
  if(d.startsWith('vote_')&&g.phase==='day')
    g.votes[uid]=d.split('_')[1];

  bot.answerCallbackQuery(q.id);
});

console.log('🐺 Werewolf Bot v5 FINAL READY');
