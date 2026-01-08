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
function narrate(type, name='') {
  const t = {
    night:['🌙 Malam sunyi menyelimuti desa...'],
    day:['☀️ Pagi tiba, warga berkumpul...'],
    kill:[`☠️ ${name} ditemukan tewas.`],
    vote:[`⚖️ ${name} dihukum massa.`]
  };
  return t[type][0];
}

function getGame(chatId){
  games[chatId] ||= {
    id:nanoid(),
    chatId,
    phase:'join',
    players:{},
    votes:{},
    night:{},
    lastProtected:null,
    mainMessageId:null,
    timer:null
  };
  return games[chatId];
}

const alive = g => Object.entries(g.players).filter(([_,p])=>p.alive);
const wolves = g => alive(g).filter(([_,p])=>WOLF_ROLES.includes(p.role));

function clearTimer(g){
  if(g.timer){ clearTimeout(g.timer); g.timer=null; }
}

async function clearKeyboard(g){
  if(!g.mainMessageId) return;
  try{
    await bot.editMessageReplyMarkup(
      {inline_keyboard:[]},
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );
  }catch{}
}

// ================= ROLE ASSIGN =================
function assignRoles(g){
  const ids = Object.keys(g.players);
  const n = ids.length;
  const wolfCount = Math.max(1, Math.floor(n/4));

  let roles = [
    'Seer','GuardianAngel','Hunter','Gunner','Chemist',
    'AlphaWolf','WolfCub','WolfMan','SnowWolf'
  ];

  while (roles.filter(r=>WOLF_ROLES.includes(r)).length < wolfCount)
    roles.push('Werewolf');

  roles = roles.slice(0,n);
  while(roles.length<n) roles.push('Villager');
  roles.sort(()=>Math.random()-0.5);

  ids.forEach((id,i)=>{
    g.players[id]={
      ...g.players[id],
      role:roles[i],
      alive:true,
      kills:0,
      used:{seer:false,heal:false,poison:false,hunter:false,bullets:2}
    };
    bot.sendMessage(id,`🎭 Role kamu: *${roles[i]}*`,{parse_mode:'Markdown'})
      .catch(()=>bot.sendMessage(g.chatId,`⚠️ ${g.players[id].name} belum /start bot`));
  });
}

// ================= WIN =================
function checkWin(g){
  const w = wolves(g).length;
  const v = alive(g).length - w;
  if(w===0) return 'Villagers';
  if(w>=v) return 'Werewolves';
  return null;
}

async function endGame(g,winner){
  clearTimer(g);
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
  clearTimer(g);
  g.phase='night';
  g.night={ wolfVotes:{}, kill:null, protectGA:null, protectHeal:null, poison:null };

  if(!g.mainMessageId){
    const m=await bot.sendMessage(g.chatId,narrate('night'));
    g.mainMessageId=m.message_id;
  }else{
    await bot.editMessageText(narrate('night'),{
      chat_id:g.chatId,message_id:g.mainMessageId
    });
  }

  // WOLF
  wolves(g).forEach(([id])=>{
    const btn=alive(g)
      .filter(([pid,p])=>pid!==id && !WOLF_ROLES.includes(p.role))
      .map(([pid,p])=>[{text:p.name,callback_data:`kill_${pid}`}]);
    bot.sendMessage(id,'🐺 Pilih target',{reply_markup:{inline_keyboard:btn}});
  });

  // SEER
  alive(g).filter(([_,p])=>p.role==='Seer'&&!p.used.seer)
    .forEach(([id])=>{
      const btn=alive(g).filter(([pid])=>pid!==id)
        .map(([pid,p])=>[{text:p.name,callback_data:`see_${pid}`}]);
      bot.sendMessage(id,'👁️ Cek role',{reply_markup:{inline_keyboard:btn}});
    });

  // GA
  alive(g).filter(([_,p])=>p.role==='GuardianAngel')
    .forEach(([id])=>{
      const btn=alive(g)
        .filter(([pid])=>pid!==g.lastProtected)
        .map(([pid,p])=>[{text:p.name,callback_data:`protect_${pid}`}]);
      bot.sendMessage(id,'👼 Lindungi',{reply_markup:{inline_keyboard:btn}});
    });

  // CHEMIST
  alive(g).filter(([_,p])=>p.role==='Chemist')
    .forEach(([id,p])=>{
      const btn=[];
      if(!p.used.heal)
        alive(g).forEach(([pid,pl])=>
          btn.push([{text:`💊 ${pl.name}`,callback_data:`heal_${pid}`}]));
      if(!p.used.poison)
        alive(g).forEach(([pid,pl])=>
          btn.push([{text:`☠️ ${pl.name}`,callback_data:`poison_${pid}`}]));
      if(btn.length)
        bot.sendMessage(id,'👨‍🔬 Aksi',{reply_markup:{inline_keyboard:btn}});
    });

  g.timer=setTimeout(()=>resolveNight(g),120000);
}

async function resolveNight(g){
  if(g.phase!=='night')return;
  clearTimer(g);
  await clearKeyboard(g);

  const tally={};
  for(const [uid,t] of Object.entries(g.night.wolfVotes)){
    const w=g.players[uid];
    const weight=w.role==='AlphaWolf'?2:1;
    tally[t]=(tally[t]||0)+weight;
  }
  g.night.kill=Object.keys(tally).sort((a,b)=>tally[b]-tally[a])[0];

  let dead=[];
  if(
    g.night.kill &&
    g.night.kill!==g.night.protectGA &&
    g.night.kill!==g.night.protectHeal
  ) dead.push(g.night.kill);

  if(g.night.poison) dead.push(g.night.poison);

  dead.forEach(id=>{
    if(g.players[id]?.alive){
      g.players[id].alive=false;
      const killer=wolves(g)[0]?.[0];
      if(killer) g.players[killer].kills++;
    }
  });

  if(dead.length)
    await bot.editMessageText(
      narrate('kill',g.players[dead[0]].name),
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );
  else
    await bot.editMessageText(
      '💊 Tidak ada kematian malam ini.',
      {chat_id:g.chatId,message_id:g.mainMessageId}
    );

  const win=checkWin(g);
  if(win) return endGame(g,win);
  startDay(g);
}

// ================= DAY =================
async function startDay(g){
  clearTimer(g);
  g.phase='day';
  g.votes={};

  await bot.editMessageText(
    narrate('day'),
    {chat_id:g.chatId,message_id:g.mainMessageId}
  );

  const btn=alive(g).map(([id,p])=>[
    {text:p.name,callback_data:`vote_${id}`}
  ]);

  await bot.editMessageReplyMarkup(
    {inline_keyboard:btn},
    {chat_id:g.chatId,message_id:g.mainMessageId}
  );

  g.timer=setTimeout(()=>resolveDay(g),180000);
}

async function resolveDay(g){
  if(g.phase!=='day')return;
  clearTimer(g);
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
  if(g.players[msg.from.id])
    return bot.sendMessage(msg.chat.id,'⚠️ Kamu sudah join');
  g.players[msg.from.id]={name:msg.from.first_name};
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

// ================= CALLBACK =================
bot.on('callback_query',q=>{
  const g=games[q.message.chat.id];
  if(!g) return;
  const uid=q.from.id;
  if(!g.players[uid]?.alive) return;

  const d=q.data;

  if(d.startsWith('kill_') && g.phase==='night'){
    if(!WOLF_ROLES.includes(g.players[uid].role)) return;
    if(g.night.wolfVotes[uid]) return;
    g.night.wolfVotes[uid]=d.split('_')[1];
  }

  if(d.startsWith('protect_') && g.phase==='night'){
    g.night.protectGA=d.split('_')[1];
    g.lastProtected=d.split('_')[1];
  }

  if(d.startsWith('see_') && g.phase==='night'){
    const t=d.split('_')[1];
    let r=g.players[t].role;
    if(r==='WolfMan') r='Villager';
    bot.sendMessage(uid,`👁️ ${g.players[t].name}: ${r}`);
    g.players[uid].used.seer=true;
  }

  if(d.startsWith('heal_') && g.phase==='night'){
    g.night.protectHeal=d.split('_')[1];
    g.players[uid].used.heal=true;
  }

  if(d.startsWith('poison_') && g.phase==='night'){
    g.night.poison=d.split('_')[1];
    g.players[uid].used.poison=true;
  }

  if(d.startsWith('vote_') && g.phase==='day')
    g.votes[uid]=d.split('_')[1];

  bot.answerCallbackQuery(q.id);
});

console.log('🐺 WEREWOLF BOT FINAL STABLE READY');
