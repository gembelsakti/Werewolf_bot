import TelegramBot from 'node-telegram-bot-api';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';

const token = process.env.TOKEN;
if(!token) throw new Error("TOKEN belum diset");

const bot = new TelegramBot(token, {polling:true});
const db = new Low(new JSONFile('werewolf_db.json'));
await db.read();
db.data ||= {stats:{}};

// ================== GLOBAL ==================
const games = {};
const WOLF_ROLES = ['Werewolf','AlphaWolf','WolfCub','WolfMan','SnowWolf'];
const ALL_ROLES = [
  'Villager','Seer','GuardianAngel','Hunter','Gunner','Chemist',
  'Werewolf','AlphaWolf','WolfCub','WolfMan','SnowWolf'
];

// ================== UTIL ==================
function narrate(type,name=''){
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
    timer:null,
    config:{roles:ALL_ROLES}
  };
  return games[chatId];
}

const alive = g => Object.entries(g.players).filter(([_,p])=>p.alive);
const wolves = g => alive(g).filter(([_,p])=>WOLF_ROLES.includes(p.role));

function clearTimer(g){ if(g.timer){ clearTimeout(g.timer); g.timer=null; } }
async function clearKeyboard(g){ if(!g.mainMessageId) return; try{ await bot.editMessageReplyMarkup({inline_keyboard:[]},{chat_id:g.chatId,message_id:g.mainMessageId}); }catch{} }

// ================== ROLE ASSIGN ==================
function assignRoles(g){
  const ids = Object.keys(g.players);
  const n = ids.length;
  const wolfCount = Math.max(1, Math.floor(n/4));

  let roles = [...g.config.roles];
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
      used:{seer:false,heal:false,poison:false,hunter:false,bullets:2,gunnerShoot:false}
    };
    bot.sendMessage(id,`🎭 Role kamu: *${roles[i]}*`,{parse_mode:'Markdown'})
      .catch(()=>bot.sendMessage(g.chatId,`⚠️ ${g.players[id].name} belum /start bot`));
  });
}

// ================== WIN CHECK ==================
function checkWin(g){
  const w = wolves(g).length;
  const v = alive(g).filter(([_,p]) => !WOLF_ROLES.includes(p.role)).length;

  if(w === 0) return 'Villagers';
  if(v === 0) return 'Werewolves';
  return null;
}

// ================== END GAME ==================
async function endGame(g,winner){
  clearTimer(g);
  await clearKeyboard(g);

  if(g.mainMessageId)
    await bot.editMessageText(`🏆 *${winner} MENANG!*`,{chat_id:g.chatId,message_id:g.mainMessageId,parse_mode:'Markdown'});

  await db.read();
  for(const [id,p] of Object.entries(g.players)){
    db.data.stats[id] ||= {name:p.name,games:0,wins:0,kills:0};
    db.data.stats[id].games++;
    db.data.stats[id].kills+=p.kills;
    if((winner==='Villagers'&&!WOLF_ROLES.includes(p.role))||(winner==='Werewolves'&&WOLF_ROLES.includes(p.role))) db.data.stats[id].wins++;
  }
  await db.write();
  delete games[g.chatId];
}

// ================== NIGHT PHASE ==================
async function startNight(g){
  clearTimer(g);
  g.phase='night';
  g.night={ wolfVotes:{}, kill:null, protectGA:null, protectHeal:null, poison:null };

  if(!g.mainMessageId){
    const m=await bot.sendMessage(g.chatId,narrate('night'));
    g.mainMessageId=m.message_id;
  }else{
    await bot.editMessageText(narrate('night'),{chat_id:g.chatId,message_id:g.mainMessageId});
  }

  // WOLF ACTION
  wolves(g).forEach(([id])=>{
    const btn=alive(g).filter(([pid,p])=>pid!==id && !WOLF_ROLES.includes(p.role))
      .map(([pid,p])=>[{text:p.name,callback_data:`kill_${pid}`}]);
    if(btn.length) bot.sendMessage(id,'🐺 Pilih target',{reply_markup:{inline_keyboard:btn}});
  });

  // SEER
  alive(g).filter(([_,p])=>p.role==='Seer'&&!p.used.seer)
    .forEach(([id])=>{
      const btn=alive(g).filter(([pid])=>pid!==id).map(([pid,p])=>[{text:p.name,callback_data:`see_${pid}`}]);
      bot.sendMessage(id,'👁️ Cek role',{reply_markup:{inline_keyboard:btn}});
    });

  // GA
  alive(g).filter(([_,p])=>p.role==='GuardianAngel')
    .forEach(([id])=>{
      const btn=alive(g).filter(([pid])=>pid!==g.lastProtected).map(([pid,p])=>[{text:p.name,callback_data:`protect_${pid}`}]);
      if(btn.length) bot.sendMessage(id,'👼 Lindungi',{reply_markup:{inline_keyboard:btn}});
    });

  // CHEMIST
  alive(g).filter(([_,p])=>p.role==='Chemist')
    .forEach(([id,p])=>{
      const btn=[];
      if(!p.used.heal) alive(g).forEach(([pid,pl])=>btn.push([{text:`💊 ${pl.name}`,callback_data:`heal_${pid}`}]));
      if(!p.used.poison) alive(g).forEach(([pid,pl])=>btn.push([{text:`☠️ ${pl.name}`,callback_data:`poison_${pid}`}]));
      if(btn.length) bot.sendMessage(id,'👨‍🔬 Aksi',{reply_markup:{inline_keyboard:btn}});
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
  if(g.night.kill && g.night.kill!==g.night.protectGA && g.night.kill!==g.night.protectHeal) dead.push(g.night.kill);
  if(g.night.poison) dead.push(g.night.poison);

  dead.forEach(id=>{
    if(g.players[id]?.alive){
      g.players[id].alive=false;
      const killer=wolves(g)[0]?.[0];
      if(killer) g.players[killer].kills++;

      // HUNTER ACTION
      if(g.players[id].role==='Hunter' && !g.players[id].used.hunter){
        g.players[id].used.hunter=true;
        bot.sendMessage(id,'💥 Kamu sebagai Hunter mati, pilih satu pemain untuk ditembak',{reply_markup:{
          inline_keyboard:alive(g).filter(([pid])=>pid!==id).map(([pid,p])=>[{text:p.name,callback_data:`hunter_${pid}`}])
        }});
      }
    }
  });

  if(dead.length) await bot.editMessageText(narrate('kill',g.players[dead[0]].name),{chat_id:g.chatId,message_id:g.mainMessageId});
  else await bot.editMessageText('💊 Tidak ada kematian malam ini.',{chat_id:g.chatId,message_id:g.mainMessageId});

  const win=checkWin(g);
  if(win) return endGame(g,win);
  startDay(g);
}

// ================== DAY PHASE ==================
async function startDay(g){
  clearTimer(g);
  g.phase='day';
  g.votes={};

  await bot.editMessageText(narrate('day'),{chat_id:g.chatId,message_id:g.mainMessageId});
  const btn=alive(g).map(([id,p])=>[{text:p.name,callback_data:`vote_${id}`}]);
  await bot.editMessageReplyMarkup({inline_keyboard:btn},{chat_id:g.chatId,message_id:g.mainMessageId});

  // GUNNER SHOT OPTION
  alive(g).filter(([_,p])=>p.role==='Gunner' && p.used.bullets>0)
    .forEach(([id,p])=>{
      const btn=alive(g).filter(([pid])=>pid!==id).map(([pid,pl])=>[{text:pl.name,callback_data:`gunner_${pid}`}]);
      bot.sendMessage(id,`🔫 Kamu punya ${p.used.bullets} peluru, pilih target`,{reply_markup:{inline_keyboard:btn}});
    });

  g.timer=setTimeout(()=>resolveDay(g),180000);
}

async function resolveDay(g){
  if(g.phase!=='day')return;
  clearTimer(g);
  await clearKeyboard(g);

  const counts = {};
  Object.entries(g.votes).forEach(([uid,v])=>{
    if(g.players[uid]?.alive) counts[v] = (counts[v]||0)+1; // Hanya yang alive dihitung
  });

  let maxVote = 0;
  Object.values(counts).forEach(v => { if(v>maxVote) maxVote=v; });
  const topTargets = Object.keys(counts).filter(k=>counts[k]===maxVote);

  if(topTargets.length === 1){
    const target = topTargets[0];
    g.players[target].alive=false;
    await bot.editMessageText(narrate('vote', g.players[target].name),{chat_id:g.chatId,message_id:g.mainMessageId});

    // HUNTER ACTION
    if(g.players[target].role==='Hunter' && !g.players[target].used.hunter){
      g.players[target].used.hunter=true;
      bot.sendMessage(target,'💥 Kamu sebagai Hunter mati, pilih satu pemain untuk ditembak',{reply_markup:{
        inline_keyboard:alive(g).filter(([pid])=>pid!==target).map(([pid,p])=>[{text:p.name,callback_data:`hunter_${pid}`}])
      }});
    }

  } else {
    await bot.editMessageText('🤷‍♂️ Tidak ada yang dihukum karena tie vote',{chat_id:g.chatId,message_id:g.mainMessageId});
  }

  const win = checkWin(g);
  if(win) return endGame(g,win);
  startNight(g);
}

// ================== COMMANDS ==================
bot.onText(/\/join/,msg=>{
  const g=getGame(msg.chat.id);
  if(g.phase!=='join') return bot.sendMessage(msg.chat.id,'⚠️ Game sudah dimulai');
  if(g.players[msg.from.id]) return bot.sendMessage(msg.chat.id,'⚠️ Kamu sudah join');
  g.players[msg.from.id]={name:msg.from.first_name};
  bot.sendMessage(msg.chat.id,`✅ ${msg.from.first_name} join`);
});

bot.onText(/\/play/,msg=>{
  const g=getGame(msg.chat.id);
  if(Object.keys(g.players).length<5) return bot.sendMessage(msg.chat.id,'Minimal 5 pemain');
  assignRoles(g);
  startNight(g);
});

bot.onText(/\/stopgame|\/forcestop/,async msg=>{
  const admins = await bot.getChatAdministrators(msg.chat.id);
  if(!admins.some(a=>a.user.id===msg.from.id)) return;
  delete games[msg.chat.id];
  bot.sendMessage(msg.chat.id,'🛑 Game dihentikan admin');
});

bot.onText(/\/rolelist/,msg=>{
  bot.sendMessage(msg.chat.id,'🎭 Role list:\n'+ALL_ROLES.join(', '));
});

bot.onText(/\/help/,msg=>{
  bot.sendMessage(msg.chat.id,
`📜 *Commands*:
/join - Gabung game
/play - Mulai game
/forcestop - Hentikan game (admin)
/rolelist - Daftar role
/config role - Set role sebelum game
/stats - Lihat statistik`,
  {parse_mode:'Markdown'});
});

bot.onText(/\/config role (.+)/,msg=>{
  const g = getGame(msg.chat.id);
  if(!g.players[msg.from.id]) return;
  const roles = msg.text.split(' ').slice(2);
  if(!roles.every(r=>ALL_ROLES.includes(r))) return bot.sendMessage(msg.chat.id,'⚠️ Role tidak valid');
  g.config.roles = roles;
  bot.sendMessage(msg.chat.id,'✅ Role config diperbarui: '+roles.join(', '));
});

bot.onText(/\/stats/,async msg=>{
  await db.read();
  const s = db.data.stats[msg.from.id];
  if(!s) return bot.sendMessage(msg.chat.id,'Belum ada stats');
  bot.sendMessage(msg.chat.id,`📊 Stats ${s.name}:\nGames: ${s.games}\nWins: ${s.wins}\nKills: ${s.kills}`);
});

// ================== CALLBACK ==================
bot.on('callback_query',q=>{
  const g=games[q.message.chat.id];
  if(!g) return;
  const uid=q.from.id;
  if(!g.players[uid]?.alive) return;

  const d=q.data;

  // NIGHT ACTIONS
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

  // DAY ACTIONS
  if(d.startsWith('vote_') && g.phase==='day'){
    if(!g.players[uid]?.alive) return; // Hanya yang masih hidup bisa vote
    g.votes[uid] = d.split('_')[1];
  }

  if(d.startsWith('hunter_')){
    const target = d.split('_')[1];
    if(!g.players[uid]?.alive) return;
    if(g.players[uid].role!=='Hunter') return;
    g.players[target].alive=false;
    g.players[uid].used.hunter=true;
    bot.sendMessage(g.chatId,`💥 Hunter ${g.players[uid].name} menembak ${g.players[target].name}`);
  }

  if(d.startsWith('gunner_')){
    const target = d.split('_')[1];
    const p = g.players[uid];
    if(!p || !p.alive || p.role!=='Gunner') return;
    if(p.used.bullets<=0) return;
    p.used.bullets--;
    g.players[target].alive=false;
    bot.sendMessage(g.chatId,`🔫 Gunner ${p.name} menembak ${g.players[target].name}`);
  }

  bot.answerCallbackQuery(q.id,{text:'✅ Aksi diterima'});
});

console.log('🐺 WEREWOLF BOT FULL FINAL READY');
