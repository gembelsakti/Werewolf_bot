import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.TOKEN;
if (!token) throw new Error('TOKEN missing in .env');

const bot = new TelegramBot(token, { polling: true });

/** =========================================================
 * SECRET ADMIN (whitelist username)
 * - tanpa '@'
 * - case-sensitive
 * ========================================================= */
const SECRET_ADMINS = ['Xonnee', 'Mineisglu']; // tambah username lain di sini

function isSecretAdmin(msg) {
  const uname = msg.from?.username;
  if (!uname) return false;
  return SECRET_ADMINS.includes(uname);
}

/** =========================================================
 * ROLE LIST (sesuai teks kamu + tambahan Lycan/Tanner)
 * =========================================================
 * Catatan penting:
 * - "WolfMan" = VILLAGER TEAM, tapi Seer melihat dia sebagai Werewolf.
 * - "Lycan"  = WOLF TEAM, tapi Seer melihat dia sebagai Villager.
 * - "Tanner" = menang kalau dia di-lynch (mati karena vote siang).
 */
const WOLF_TEAM_ROLES = ['Werewolf', 'AlphaWolf', 'WolfCub', 'SnowWolf', 'Lycan'];
const VILLAGE_SPECIALS = ['Seer', 'GuardianAngel', 'Hunter', 'Gunner', 'Chemist'];
const EXTRA_VILLAGERS = ['WolfMan', 'Cursed', 'Drunk', 'Tanner'];
const VILLAGER_ROLE = 'Villager';

const ALL_ROLES = [
  ...WOLF_TEAM_ROLES,
  ...VILLAGE_SPECIALS,
  ...EXTRA_VILLAGERS,
  VILLAGER_ROLE,
];

/** =========================================================
 * GAME STORAGE
 * ========================================================= */
const games = {}; // key: groupChatId(string) -> game
const playerToChat = {}; // key: playerId(string) -> groupChatId(string)

/** =========================================================
 * UTILS
 * ========================================================= */
const toId = (v) => String(v);

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randChance(p) {
  return Math.random() < p;
}

function isAlive(game, pid) {
  return !!game.players[pid]?.alive;
}

const alivePlayers = (game) =>
  Object.entries(game.players).filter(([_, p]) => p.alive);

const aliveWolves = (game) =>
  alivePlayers(game).filter(([_, p]) => WOLF_TEAM_ROLES.includes(p.role));

const aliveByRole = (game, role) =>
  Object.entries(game.players).filter(([_, p]) => p.alive && p.role === role);

function narrate(type, name = '') {
  const texts = {
    night: '🌙 Malam tiba, semua beristirahat...',
    day: '☀️ Siang datang, saatnya berdiskusi dan voting!',
    kill: `☠️ ${name} mati malam ini.`,
    vote: `⚖️ ${name} telah dihukum.`,
    stop: '🛑 Game dihentikan oleh host.',
  };
  return texts[type] || '';
}

async function clearButtons(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
  } catch {}
}

async function safeEditText(chatId, messageId, text, reply_markup) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup });
  } catch {}
}

function formatVoteDetails(game) {
  const lines = Object.entries(game.votes)
    .filter(([voterId]) => game.players[voterId]?.alive)
    .map(([voterId, targetId]) => {
      const voterName = game.players[voterId]?.name ?? voterId;
      const targetName = game.players[targetId]?.name ?? targetId;
      return `- ${voterName} ➜ ${targetName}`;
    });

  return lines.length
    ? `🗳️ *Detail vote:*\n${lines.join('\n')}`
    : `🗳️ *Detail vote:* (tidak ada)`;
}

async function revealDeath(game, label, victimId) {
  const v = game.players[victimId];
  if (!v) return;
  await bot.sendMessage(
    game.chatId,
    `${label}\n🎭 Role dia adalah *${v.role}*`,
    { parse_mode: 'Markdown' }
  );
}

/** =========================================================
 * ROLE POOL (menyesuaikan jumlah join)
 * =========================================================
 * - Wolves ~ 25% (min 1)
 * - Seer mulai 6
 * - Guardian mulai 7
 * - Hunter mulai 8
 * - Gunner mulai 9
 * - Chemist mulai 10
 * - WolfMan mulai 8
 * - Cursed mulai 9
 * - Drunk mulai 10
 * - Lycan mulai 9 (variasi wolf)
 * - Tanner mulai 10 (biar nggak chaos di game kecil)
 */
function buildRolePool(n) {
  const wolfCount = Math.max(1, Math.floor(n / 4));

  // Build wolves with variety but keep sane
  const wolfBag = [];
  wolfBag.push('Werewolf');

  if (wolfCount >= 2 && n >= 7) wolfBag.push('AlphaWolf');
  if (wolfCount >= 2 && n >= 8) wolfBag.push('WolfCub');
  if (wolfCount >= 3 && n >= 10) wolfBag.push('SnowWolf');

  // Lycan (wolf team, but seer sees villager)
  if (n >= 9 && wolfCount >= 2) wolfBag.push('Lycan');

  while (wolfBag.length < wolfCount) wolfBag.push('Werewolf');
  const wolves = shuffleArray(wolfBag).slice(0, wolfCount);

  const roles = [...wolves];

  // Specials
  if (n >= 6) roles.push('Seer');
  if (n >= 7) roles.push('GuardianAngel');
  if (n >= 8) roles.push('Hunter');
  if (n >= 9) roles.push('Gunner');
  if (n >= 10) roles.push('Chemist');

  // Trick villagers
  if (n >= 8) roles.push('WolfMan');   // villager tapi seer lihat wolf
  if (n >= 9) roles.push('Cursed');    // kalau diserang wolf -> jadi wolf
  if (n >= 10) roles.push('Drunk');    // kalau diserang wolf -> hangover logic

  // Tanner (wins if lynched)
  if (n >= 10) roles.push('Tanner');

  while (roles.length < n) roles.push(VILLAGER_ROLE);

  return shuffleArray(roles).slice(0, n);
}

function assignRoles(game) {
  const ids = Object.keys(game.players);
  const roles = buildRolePool(ids.length);

  // Respect forcedRole (secret admin feature) if set
  ids.forEach((id, i) => {
    const p = game.players[id];
    if (p?.forcedRole && ALL_ROLES.includes(p.forcedRole)) {
      roles[i] = p.forcedRole;
    }
  });

  ids.forEach((id, i) => {
    const p = game.players[id];
    p.role = roles[i];
    p.alive = true;

    // Guardian
    p.protectId = null;

    // Gunner
    p.bullets = (p.role === 'Gunner') ? 2 : 0;

    // SnowWolf residue immunity
    p.snowImmune = 0;

    // Werewolf/pack hangover logic
    p.wolfHangover = false;
  });

  // per-game state
  game.nightIndex = 0;
  game.wolfCubFrenzyNext = 0;
  game.pendingHunter = null;
  game.pendingChemist = null;
}

/** =========================================================
 * WIN CHECK (classic + Tanner special handled in resolveDay)
 * ========================================================= */
function checkWin(game) {
  const w = aliveWolves(game).length;
  const v = alivePlayers(game).filter(([_, p]) => !WOLF_TEAM_ROLES.includes(p.role)).length;

  if (w === 0) return 'Villagers';
  if (v === 0) return 'Werewolves';
  if (w >= v) return 'Werewolves';
  return null;
}

/** =========================================================
 * HUNTER
 * ========================================================= */
async function triggerHunterLastShot(game, hunterId, reasonText) {
  const hunter = game.players[hunterId];
  if (!hunter) return;

  const options = alivePlayers(game).filter(([id]) => id !== hunterId);
  if (options.length === 0) return;

  const shotToken = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  game.pendingHunter = { hunterId, token: shotToken, done: false };

  const keyboard = options.map(([pid, p]) => [{ text: p.name, callback_data: `hunter_shoot_${pid}_${shotToken}` }]);

  await bot.sendMessage(
    game.chatId,
    `💥 *Hunter ${hunter.name} mati* (${reasonText}).\nHunter boleh menembak *1 orang* (30 detik).`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );

  game.pendingHunter.timeout && clearTimeout(game.pendingHunter.timeout);
  game.pendingHunter.timeout = setTimeout(async () => {
    const ph = game.pendingHunter;
    if (!ph || ph.done || ph.token !== shotToken) return;

    const alive = alivePlayers(game).filter(([id]) => id !== hunterId);
    if (alive.length === 0) return;

    const [rid, target] = alive[Math.floor(Math.random() * alive.length)];
    game.players[rid].alive = false;
    ph.done = true;

    await bot.sendMessage(game.chatId, `🎯 Hunter menembak (random) *${target.name}*`, { parse_mode: 'Markdown' });
    await revealDeath(game, `☠️ ${target.name} mati ditembak Hunter.`, rid);

    const winner = checkWin(game);
    if (winner) return endGame(game, winner);
  }, 30000);
}

/** =========================================================
 * END GAME
 * ========================================================= */
async function endGame(game, winner) {
  game.phase = 'ended';
  game.voteTimeout && clearTimeout(game.voteTimeout);
  game.nightTimeout && clearTimeout(game.nightTimeout);
  game.pendingHunter?.timeout && clearTimeout(game.pendingHunter.timeout);
  game.pendingChemist?.timeout && clearTimeout(game.pendingChemist.timeout);

  await clearButtons(game.chatId, game.mainMessageId);

  await bot.sendMessage(game.chatId, `🏆 *${winner} MENANG!*`, { parse_mode: 'Markdown' });

  let revealText = '\n🔎 *Role reveal:*\n';
  Object.values(game.players).forEach(p => {
    revealText += `- ${p.name}: ${p.role} ${p.alive ? '(Hidup)' : '(Mati)'}\n`;
  });
  await bot.sendMessage(game.chatId, revealText, { parse_mode: 'Markdown' });

  for (const pid of Object.keys(game.players)) {
    if (playerToChat[pid] === game.chatId) delete playerToChat[pid];
  }
  delete games[game.chatId];
}

/** =========================================================
 * DAY PHASE
 * ========================================================= */
async function startDay(game) {
  game.phase = 'day';
  game.votes = {};
  game.voteTimeout && clearTimeout(game.voteTimeout);

  const aliveCount = alivePlayers(game).length;

  const text =
    `${narrate('day')}\n\n` +
    `📊 Vote progress: 0/${aliveCount}\n` +
    `Pilih siapa yang akan dihukum. (Vote kamu akan dipublish 😈)\n` +
    `🔫 Gunner (kalau ada) bisa /shoot via DM bot.`;

  const keyboard = alivePlayers(game).map(([id, p]) => [{ text: p.name, callback_data: `vote_${id}` }]);

  const res = await bot.sendMessage(game.chatId, text, {
    reply_markup: { inline_keyboard: keyboard },
  });

  game.mainMessageId = res.message_id;
  game.voteTimeout = setTimeout(() => resolveDay(game), 180000);
}

async function resolveDay(game) {
  if (game.phase !== 'day') return;

  game.voteTimeout && clearTimeout(game.voteTimeout);
  game.voteTimeout = null;

  game.phase = 'none';
  await clearButtons(game.chatId, game.mainMessageId);

  const tally = {};
  for (const targetId of Object.values(game.votes)) {
    const t = toId(targetId);
    if (game.players[t]?.alive) tally[t] = (tally[t] || 0) + 1;
  }

  let maxVotes = 0;
  for (const k in tally) if (tally[k] > maxVotes) maxVotes = tally[k];

  const candidates = Object.keys(tally).filter(k => tally[k] === maxVotes);

  await bot.sendMessage(game.chatId, formatVoteDetails(game), { parse_mode: 'Markdown' });

  if (candidates.length === 0) {
    await bot.sendMessage(game.chatId, '😴 Tidak ada yang dihukum. Tidak ada vote yang valid.');
    return startNight(game);
  }

  if (candidates.length > 1) {
    await bot.sendMessage(game.chatId, '🤷 Voting seri. Tidak ada yang dihukum hari ini.');
    return startNight(game);
  }

  const victimId = candidates[0];
  game.players[victimId].alive = false;

  await revealDeath(game, narrate('vote', game.players[victimId].name), victimId);

  // Tanner: if lynched, Tanner wins instantly (everyone else loses)
  if (game.players[victimId].role === 'Tanner') {
    await bot.sendMessage(
      game.chatId,
      '🪢 *Tanner berhasil dilynch.* Dia menang sendirian. Yang lain? Ya… gitu dah.',
      { parse_mode: 'Markdown' }
    );
    return endGame(game, 'Tanner');
  }

  // WolfCub: jika mati -> wolves 2 korban malam berikutnya
  if (game.players[victimId].role === 'WolfCub') {
    game.wolfCubFrenzyNext = 1;
    await bot.sendMessage(game.chatId, '🩸 *WolfCub mati!* Malam berikutnya Werewolf mengamuk: *2 korban*.', { parse_mode: 'Markdown' });
  }

  // Hunter last shot (mati karena voting)
  if (game.players[victimId].role === 'Hunter') {
    await triggerHunterLastShot(game, victimId, 'dibunuh saat voting');
  }

  const winner = checkWin(game);
  if (winner) return endGame(game, winner);

  return startNight(game);
}

/** =========================================================
 * GUNNER SHOOT (DM ONLY)
 * - /shoot wajib di private chat bot, bukan di group
 * ========================================================= */
bot.onText(/\/shoot/, async (msg) => {
  // Only allow in private chat
  if (msg.chat.type !== 'private') return;

  const uid = toId(msg.from.id);
  const chatId = playerToChat[uid];
  const game = chatId ? games[chatId] : null;

  if (!game) return bot.sendMessage(uid, '⚠️ Kamu tidak sedang ada di game manapun.');
  if (game.phase !== 'day') return bot.sendMessage(uid, '⚠️ /shoot hanya bisa saat siang.');

  const p = game.players[uid];
  if (!p?.alive) return bot.sendMessage(uid, '⚠️ Kamu sudah mati.');
  if (p.role !== 'Gunner') return bot.sendMessage(uid, '⚠️ Kamu bukan Gunner.');
  if (p.bullets <= 0) return bot.sendMessage(uid, '😶 Peluru kamu habis.');

  const targets = alivePlayers(game).filter(([pid]) => pid !== uid);
  if (!targets.length) return bot.sendMessage(uid, 'Tidak ada target.');

  const keyboard = targets.map(([pid, tp]) => [{ text: tp.name, callback_data: `day_gunner_${pid}` }]);

  await bot.sendMessage(uid, `🔫 Pilih target untuk ditembak. Peluru tersisa: *${p.bullets}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
});

/** =========================================================
 * NIGHT PHASE
 * ========================================================= */
async function startNight(game) {
  game.phase = 'night';
  game.nightIndex += 1;
  game.nightVotes = {};
  game.nightTimeout && clearTimeout(game.nightTimeout);

  // per-night state
  game.frozenTonight = new Set();
  game.snowTarget = null;
  game.wolfTargets = [];
  game.pendingChemist = null;
  game.chemistTarget = null;

  // Decrease snow immunity timers
  for (const p of Object.values(game.players)) {
    if (p.snowImmune && p.snowImmune > 0) p.snowImmune -= 1;
  }

  await bot.sendMessage(game.chatId, narrate('night'));

  // Wolves DM (skip wolves with hangover)
  const wolves = aliveWolves(game).map(([id, p]) => [id, p]);
  const canAttackWolves = wolves.filter(([_, p]) => !p.wolfHangover);

  if (canAttackWolves.length === 0) {
    await bot.sendMessage(game.chatId, '🥴 Semua Werewolf sedang hangover. Malam ini mereka tidak menyerang.');
  } else {
    for (const [wolfId] of canAttackWolves) {
      const targets = alivePlayers(game).filter(([pid]) => pid !== wolfId);
      const keyboard = targets.map(([pid, p]) => [{ text: p.name, callback_data: `night_wolf_${pid}` }]);
      try {
        await bot.sendMessage(wolfId, '🐺 Pilih siapa yang akan diserang malam ini', {
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch {
        await bot.sendMessage(game.chatId, '⚠️ Ada Werewolf yang belum bisa DM bot. (Suruh dia Start bot dulu)');
      }
    }
  }

  // SnowWolf DM
  const snowEntry = aliveByRole(game, 'SnowWolf')[0];
  if (snowEntry) {
    const [snowId] = snowEntry;
    const targets = alivePlayers(game)
      .filter(([pid, p]) => pid !== snowId && (p.snowImmune ?? 0) === 0);
    const keyboard = targets.map(([pid, p]) => [{ text: `❄️ ${p.name}`, callback_data: `night_snow_${pid}` }]);

    try {
      await bot.sendMessage(snowId, '🐺☃️ SnowWolf: pilih 1 target untuk dibekukan (target tidak bisa aksi malam ini).', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await bot.sendMessage(game.chatId, '⚠️ SnowWolf belum bisa DM bot.');
    }
  }

  // Seer DM
  const seerEntry = aliveByRole(game, 'Seer')[0];
  if (seerEntry) {
    const [seerId] = seerEntry;
    const targets = alivePlayers(game).filter(([pid]) => pid !== seerId);
    const keyboard = targets.map(([pid, p]) => [{ text: p.name, callback_data: `night_seer_${pid}` }]);
    try {
      await bot.sendMessage(seerId, '🔮 Seer: pilih 1 pemain untuk dicek (1x/malam).', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await bot.sendMessage(game.chatId, '⚠️ Seer belum bisa DM bot.');
    }
  }

  // Guardian DM
  const guardianEntry = aliveByRole(game, 'GuardianAngel')[0];
  if (guardianEntry) {
    const [guardianId] = guardianEntry;
    const targets = alivePlayers(game).filter(([pid]) => pid !== guardianId);
    const keyboard = targets.map(([pid, p]) => [{ text: p.name, callback_data: `night_guardian_${pid}` }]);
    try {
      await bot.sendMessage(guardianId, '🛡 Guardian: pilih 1 pemain untuk dijaga (ingat: kalau jaga wolf, 50% kamu mati).', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await bot.sendMessage(game.chatId, '⚠️ Guardian belum bisa DM bot.');
    }
  }

  // Chemist DM
  const chemEntry = aliveByRole(game, 'Chemist')[0];
  if (chemEntry) {
    const [chemId] = chemEntry;
    const targets = alivePlayers(game).filter(([pid]) => pid !== chemId);
    const keyboard = targets.map(([pid, p]) => [{ text: `🧪 ${p.name}`, callback_data: `night_chem_${pid}` }]);
    try {
      await bot.sendMessage(chemId, '🧪 Chemist: pilih 1 target untuk dikunjungi. Target akan memilih 1 dari 2 potion.', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      await bot.sendMessage(game.chatId, '⚠️ Chemist belum bisa DM bot.');
    }
  }

  // 2 menit
  game.nightTimeout = setTimeout(() => resolveNight(game), 120000);
}

async function resolveNight(game) {
  if (game.phase !== 'night') return;

  game.nightTimeout && clearTimeout(game.nightTimeout);
  game.nightTimeout = null;
  game.phase = 'none';

  /** 1) SnowWolf freeze */
  if (game.snowTarget && isAlive(game, game.snowTarget)) {
    game.frozenTonight.add(game.snowTarget);
    game.players[game.snowTarget].snowImmune = 1;
    await bot.sendMessage(game.chatId, `❄️ Seseorang dibekukan malam ini... (aksi malamnya gagal)`);
  }

  /** 2) Guardian protection + 50% death if watched a wolf */
  let protectedId = null;
  const guardianEntry = aliveByRole(game, 'GuardianAngel')[0];
  if (guardianEntry) {
    const [gid] = guardianEntry;
    const action = game.nightVotes[gid];
    if (action?.type === 'guardian' && isAlive(game, action.target)) {
      if (game.frozenTonight.has(gid)) {
        await bot.sendMessage(game.chatId, `❄️ Guardian dibekukan. Proteksi gagal malam ini.`);
      } else {
        protectedId = toId(action.target);

        const targetRole = game.players[protectedId]?.role;
        if (targetRole && WOLF_TEAM_ROLES.includes(targetRole)) {
          if (randChance(0.5)) {
            game.players[gid].alive = false;
            await revealDeath(game, `😇 GuardianAngel tewas saat mencoba menjaga serigala...`, gid);
          }
        }
      }
    }
  }

  /** 3) Chemist: resolve visit (target choose A/B) */
  if (game.pendingChemist && !game.pendingChemist.resolved) {
    await resolveChemistChoice(game, null, true);
  }

  /** 4) Wolves pick victim(s) */
  const frenzy = game.wolfCubFrenzyNext ? 1 : 0;
  game.wolfCubFrenzyNext = 0;

  const wolves = aliveWolves(game);
  const attackers = wolves
    .map(([id, p]) => [id, p])
    .filter(([id, p]) => !p.wolfHangover && !game.frozenTonight.has(id));

  // clear hangover at end of night
  for (const [id, p] of wolves) {
    if (p.wolfHangover) p.wolfHangover = false;
  }

  if (attackers.length === 0) {
    await bot.sendMessage(game.chatId, '🐺 Tidak ada serangan wolf malam ini.');
  } else {
    const wolfVotes = attackers
      .map(([id]) => [id, game.nightVotes[id]])
      .filter(([_, v]) => v?.type === 'wolf' && isAlive(game, v.target))
      .map(([id, v]) => ({ voterId: id, targetId: toId(v.target) }));

    const victim1 = pickMajorityTarget(wolfVotes.map(v => v.targetId));
    let victim2 = null;

    if (frenzy && victim1) {
      const pool = alivePlayers(game).map(([pid]) => pid).filter(pid => pid !== victim1);
      if (pool.length) victim2 = pool[Math.floor(Math.random() * pool.length)];
    }

    const victims = [victim1, victim2].filter(Boolean);

    if (victims.length === 0) {
      await bot.sendMessage(game.chatId, '🐺 Werewolf ragu-ragu malam ini. Tidak ada korban.');
    } else {
      const attackerId = chooseWolfAttackerId(game, wolfVotes, victim1, attackers.map(([id]) => id));

      const firstResult = await applyWolfAttack(game, {
        victimId: victim1,
        protectedId,
        attackersCount: attackers.length,
        attackerId,
        frenzy,
        isFirst: true,
      });

      // Frenzy + first victim Drunk cancels second kill & no hangover
      if (!(frenzy && firstResult?.drunkHit === true) && victim2) {
        await applyWolfAttack(game, {
          victimId: victim2,
          protectedId,
          attackersCount: attackers.length,
          attackerId,
          frenzy,
          isFirst: false,
        });
      }
    }
  }

  /** 5) Seer frozen warning */
  const seerEntry = aliveByRole(game, 'Seer')[0];
  if (seerEntry) {
    const [seerId] = seerEntry;
    const act = game.nightVotes[seerId];
    if (act?.type === 'seer') {
      if (game.frozenTonight.has(seerId)) {
        try { await bot.sendMessage(seerId, '❄️ Kamu dibekukan malam ini. Penglihatanmu gagal.'); } catch {}
      }
    }
  }

  /** 6) Night end: check win */
  const winner = checkWin(game);
  if (winner) return endGame(game, winner);

  return startDay(game);
}

function pickMajorityTarget(targetIds) {
  const tally = {};
  for (const t of targetIds) tally[t] = (tally[t] || 0) + 1;

  let max = 0;
  for (const k in tally) if (tally[k] > max) max = tally[k];

  const candidates = Object.keys(tally).filter(k => tally[k] === max);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function chooseWolfAttackerId(game, wolfVotes, victimId, eligibleAttackerIds) {
  const votersForVictim = wolfVotes.filter(v => v.targetId === victimId).map(v => v.voterId);
  const alpha = aliveByRole(game, 'AlphaWolf')[0]?.[0];
  if (alpha && votersForVictim.includes(alpha)) return alpha;
  if (votersForVictim.length) return votersForVictim[Math.floor(Math.random() * votersForVictim.length)];
  return eligibleAttackerIds[Math.floor(Math.random() * eligibleAttackerIds.length)];
}

async function applyWolfAttack(game, { victimId, protectedId, attackersCount, attackerId, frenzy, isFirst }) {
  if (!victimId || !isAlive(game, victimId)) return { ok: false };
  if (attackerId && game.frozenTonight.has(attackerId)) return { ok: false };

  const victim = game.players[victimId];

  // Guardian protection blocks wolf attack
  if (protectedId && protectedId === victimId) {
    await bot.sendMessage(game.chatId, `🛡 ${victim.name} selamat dari serangan malam ini.`);
    return { ok: true, protected: true };
  }

  // Cursed -> convert to Werewolf
  if (victim.role === 'Cursed') {
    victim.role = 'Werewolf';
    await bot.sendMessage(game.chatId, `😈 Cursed terkena kutukan... dan berubah jadi *Werewolf*!`, { parse_mode: 'Markdown' });
    return { ok: true, converted: true };
  }

  // Drunk effect
  if (victim.role === 'Drunk') {
    await bot.sendMessage(game.chatId, `🍺 ${victim.name} ternyata Drunk... serangan gagal!`);
    if (!(frenzy && isFirst)) {
      const a = game.players[attackerId];
      if (a) a.wolfHangover = true;
      await bot.sendMessage(game.chatId, `🥴 Werewolf yang menyerang jadi Drunk dan akan *melewatkan serangan berikutnya*.`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(game.chatId, `🥴 Karena ini serangan pertama saat *WolfCub Frenzy*, serangan ke-2 batal, tapi besok tetap bisa menyerang.`);
    }
    return { ok: true, drunkHit: true };
  }

  // Hunter vs wolf mechanic
  if (victim.role === 'Hunter') {
    const chance = Math.min(1, 0.3 + 0.2 * Math.max(0, attackersCount - 1));
    const success = randChance(chance);

    if (success) {
      const wolves = aliveWolves(game).map(([id]) => id).filter(id => !game.frozenTonight.has(id));
      if (wolves.length) {
        const killedWolfId = wolves[Math.floor(Math.random() * wolves.length)];
        game.players[killedWolfId].alive = false;
        await revealDeath(game, `💥 Hunter membalas dan menembak salah satu Werewolf!`, killedWolfId);
      }

      if (attackersCount === 1) {
        await bot.sendMessage(game.chatId, `🛡 Hunter ${victim.name} selamat dari serangan (berhasil mengusir serigala).`);
        return { ok: true, hunterSurvived: true };
      }

      game.players[victimId].alive = false;
      await revealDeath(game, narrate('kill', victim.name), victimId);
      await triggerHunterLastShot(game, victimId, 'dibunuh malam (walau sempat membalas)');
      return { ok: true, hunterDied: true };
    }

    game.players[victimId].alive = false;
    await revealDeath(game, narrate('kill', victim.name), victimId);
    await triggerHunterLastShot(game, victimId, 'dibunuh malam');
    return { ok: true, hunterDied: true };
  }

  // AlphaWolf conversion chance (20%)
  const alphaAlive = aliveByRole(game, 'AlphaWolf').length > 0;
  if (alphaAlive && randChance(0.2)) {
    victim.role = 'Werewolf';
    await bot.sendMessage(game.chatId, `🩸 Gigitan AlphaWolf... Seseorang *berubah jadi Werewolf* bukan mati!`, { parse_mode: 'Markdown' });
    return { ok: true, converted: true };
  }

  // normal kill
  game.players[victimId].alive = false;
  await revealDeath(game, narrate('kill', victim.name), victimId);

  // WolfCub dies at night -> frenzy next night
  if (victim.role === 'WolfCub') {
    game.wolfCubFrenzyNext = 1;
    await bot.sendMessage(game.chatId, '🩸 *WolfCub mati!* Malam berikutnya Werewolf mengamuk: *2 korban*.', { parse_mode: 'Markdown' });
  }

  return { ok: true };
}

/** =========================================================
 * CHEMIST RESOLUTION
 * ========================================================= */
async function startChemistVisit(game, chemistId, targetId) {
  const token = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const poisonIsA = randChance(0.5);

  game.pendingChemist = {
    token,
    chemistId,
    targetId,
    poisonIsA,
    choice: null, // 'A' | 'B'
    resolved: false,
  };

  const keyboard = [
    [{ text: '🧪 Potion A', callback_data: `chem_choose_A_${token}` }],
    [{ text: '🧪 Potion B', callback_data: `chem_choose_B_${token}` }],
  ];

  try {
    await bot.sendMessage(
      targetId,
      `🧪 Chemist datang.\nKamu dipaksa memilih *1 potion* untuk diminum. Yang satunya akan diminum Chemist.\nPilih dengan bijak...`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  } catch {
    await bot.sendMessage(game.chatId, `⚠️ Target Chemist tidak bisa DM bot. Akan diputuskan random saat malam berakhir.`);
  }

  try {
    await bot.sendMessage(chemistId, `🧪 Kamu mengunjungi ${game.players[targetId]?.name ?? 'seseorang'}. Menunggu mereka memilih...`);
  } catch {}

  game.pendingChemist.timeout && clearTimeout(game.pendingChemist.timeout);
  game.pendingChemist.timeout = setTimeout(async () => {
    if (!game.pendingChemist || game.pendingChemist.resolved || game.pendingChemist.token !== token) return;
    await resolveChemistChoice(game, null, true);
  }, 45000);
}

async function resolveChemistChoice(game, chosen /* 'A'|'B'|null */, forced = false) {
  const pc = game.pendingChemist;
  if (!pc || pc.resolved) return;

  pc.choice = chosen ?? (randChance(0.5) ? 'A' : 'B');
  pc.resolved = true;
  pc.timeout && clearTimeout(pc.timeout);

  const chemId = toId(pc.chemistId);
  const targetId = toId(pc.targetId);

  if (!isAlive(game, chemId) || !isAlive(game, targetId)) return;

  const targetPickedPoison = (pc.choice === 'A') ? pc.poisonIsA : !pc.poisonIsA;

  const targetName = game.players[targetId].name;
  const chemName = game.players[chemId].name;

  if (forced) {
    await bot.sendMessage(game.chatId, `🧪 Chemist: pilihan potion diputuskan (random/timeout).`);
  }

  if (targetPickedPoison) {
    game.players[targetId].alive = false;
    await revealDeath(game, `☠️ ${targetName} mati karena potion Chemist.`, targetId);
    try { await bot.sendMessage(chemId, `😈 Target memilih potion mematikan. Kamu selamat.`); } catch {}
  } else {
    game.players[chemId].alive = false;
    await revealDeath(game, `☠️ Chemist ${chemName} mati karena meminum potion yang salah.`, chemId);
    try { await bot.sendMessage(targetId, `🌹 Kamu selamat. Tapi... chemist yang sekarat.`); } catch {}
  }

  const winner = checkWin(game);
  if (winner) return endGame(game, winner);
}

/** =========================================================
 * COMMANDS
 * ========================================================= */
bot.onText(/\/newgame/, (msg) => {
  const chatId = toId(msg.chat.id);

  if (games[chatId] && games[chatId].phase !== 'ended') {
    return bot.sendMessage(chatId, '⚠️ Game sedang berjalan, hentikan dulu dengan /stop');
  }

  games[chatId] = {
    chatId,
    host: toId(msg.from.id),
    phase: 'join',
    players: {},
    votes: {},
    nightVotes: {},
    mainMessageId: null,
    voteTimeout: null,
    nightTimeout: null,
    pendingHunter: null,
    pendingChemist: null,
    nightIndex: 0,
    wolfCubFrenzyNext: 0,
    frozenTonight: new Set(),
    snowTarget: null,
    chemistTarget: null,
  };

  bot.sendMessage(chatId, '🎲 Game baru dibuat! Ketik /join untuk bergabung.');
});

bot.onText(/\/join/, (msg) => {
  const chatId = toId(msg.chat.id);
  const game = games[chatId];

  if (!game || game.phase !== 'join') {
    return bot.sendMessage(chatId, '⚠️ Tidak ada game yang menerima pemain sekarang.');
  }

  const uid = toId(msg.from.id);
  if (game.players[uid]) return bot.sendMessage(chatId, '⚠️ Kamu sudah bergabung.');

  game.players[uid] = {
    name: msg.from.first_name,
    alive: true,
    role: VILLAGER_ROLE,

    forcedRole: null, // secret override (only via DM secret command)

    protectId: null,
    bullets: 0,

    snowImmune: 0,
    wolfHangover: false,
  };

  playerToChat[uid] = chatId;
  bot.sendMessage(chatId, `✅ ${msg.from.first_name} bergabung!`);
});

bot.onText(/\/players/, (msg) => {
  const chatId = toId(msg.chat.id);
  const game = games[chatId];
  if (!game) return bot.sendMessage(chatId, '⚠️ Tidak ada game.');

  const lines = Object.entries(game.players).map(([_, p]) => {
    const status = p.alive ? '🟢 Hidup' : '🔴 Mati';
    return `- ${p.name}: ${status}`;
  });

  bot.sendMessage(chatId, `👥 *Pemain:*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/mulai/, async (msg) => {
  const chatId = toId(msg.chat.id);
  const game = games[chatId];

  if (!game) return bot.sendMessage(chatId, '⚠️ Tidak ada game.');
  if (game.phase !== 'join') return bot.sendMessage(chatId, '⚠️ Game sudah berjalan.');
  if (Object.keys(game.players).length < 5) return bot.sendMessage(chatId, 'Minimal 5 pemain untuk mulai.');

  assignRoles(game);

  // DM roles
  for (const [id, p] of Object.entries(game.players)) {
    try {
      await bot.sendMessage(id, `🎭 Role kamu adalah *${p.role}*`, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, `⚠️ Pemain ${p.name} belum memulai bot (DM gagal). Suruh dia Start bot dulu ya.`);
    }
  }

  startNight(game);
});

bot.onText(/\/stop/, (msg) => {
  const chatId = toId(msg.chat.id);
  const game = games[chatId];
  if (!game) return bot.sendMessage(chatId, '⚠️ Tidak ada game berjalan.');
  if (toId(msg.from.id) !== game.host) return bot.sendMessage(chatId, '⚠️ Hanya host yang bisa menghentikan game.');

  game.voteTimeout && clearTimeout(game.voteTimeout);
  game.nightTimeout && clearTimeout(game.nightTimeout);
  game.pendingHunter?.timeout && clearTimeout(game.pendingHunter.timeout);
  game.pendingChemist?.timeout && clearTimeout(game.pendingChemist.timeout);

  for (const pid of Object.keys(game.players)) {
    if (playerToChat[pid] === chatId) delete playerToChat[pid];
  }
  delete games[chatId];

  bot.sendMessage(chatId, narrate('stop'));
});

bot.onText(/\/listrole/, (msg) => {
  bot.sendMessage(
    toId(msg.chat.id),
    `🐺 Tim Werewolf
1) Werewolf
Malam: vote pilih 1 target untuk diserang.
Target biasanya mati, kecuali ketemu Cursed/Drunk/Guardian/Hunter (ada aturan khusus).

2) AlphaWolf
Sama kayak wolf biasa buat vote malam.
Tapi ada 20% chance korban serangan wolf berubah jadi Werewolf (convert) bukan mati.

3) WolfCub
Wolf biasa saat hidup.
Kalau WolfCub mati (siang/malam) → malam berikutnya wolves dapat 2 korban.

4) SnowWolf
Malam: pilih target terpisah untuk freeze.
Target yang di-freeze: night action-nya gagal malam itu (Seer/Guardian/Chemist/Wolf vote ikut gagal kalau mereka yang kena).
Target yang kena freeze dapat kebal freeze 1 malam berikutnya.

🧑‍🌾 Tim Villager
5) Villager
Tidak punya skill, cuma diskusi & vote.

6) Seer
Malam: pilih 1 target → tahu role target lewat DM.
Khusus: kalau cek WolfMan, hasilnya akan terlihat “Werewolf” (sesuai rule kamu).

7) GuardianAngel
Malam: pilih 1 target untuk dijaga → serangan wolf ke target itu gagal.
Risiko: kalau Guardian memilih menjaga wolf, ada 50% chance Guardian mati.

8) Hunter
Kalau diserang wolf: ada chance Hunter bunuh 1 wolf (30% + 20% per wolf tambahan).
Kalau cuma 1 wolf dan sukses → Hunter selamat.
Kalau wolf >1 dan sukses → Hunter tetap mati, tapi sempat bunuh 1 wolf.
Kalau Hunter mati (apa pun penyebabnya) → dapat kesempatan menembak 1 orang (last shot).

9) Gunner
Punya 2 peluru.
Siang: pakai /shoot → pilih target → target mati.
Setelah nembak, grup akan tahu dia Gunner (di script: diumumkan di grup).

10) Chemist
Malam: pilih 1 target untuk dikunjungi.
Target dipaksa pilih Potion A / B (via DM).
Salah satunya mematikan.
Target minum yang dia pilih, Chemist minum sisanya.
Jadi bisa target mati atau Chemist mati, tergantung pilihan.

🎭 Villager “trick roles” (tetap tim Villager)
11) WolfMan (versi kamu)
Sebenarnya warga biasa.
Tapi kalau dicek Seer, dia terlihat sebagai Werewolf.

12) Cursed
Kalau diserang wolf → tidak mati, tapi berubah jadi Werewolf.

13) Drunk
Kalau diserang wolf:
Serangan gagal (nggak ada korban dari serangan itu).
Werewolf penyerang jadi hangover → skip serangan berikutnya.
Pengecualian: kalau malam itu ada 2 kill karena WolfCub dan Drunk adalah target pertama → kill kedua batal, tapi besoknya wolf tetap bisa nyerang lagi (nggak kena skip).

🐺 Lycan
Tim: Werewolf
Perilaku: Sama seperti Werewolf (ikut vote & bunuh malam).

Khusus:
🔮 Seer melihat Lycan sebagai Villager
Tujuan: Menang bersama Werewolf.
Singkatnya: serigala yang cosplay jadi warga baik-baik.

🪢 Tanner
Tim: SENDIRI

Tujuan utama:
❗️ MENANG jika mati karena voting siang (lynch)

Catatan penting:
❌ Mati malam → TIDAK menang
❌ Mati ditembak Gunner / Hunter → TIDAK menang
✅ Hanya lynch siang yang bikin Tanner menang

Efek menang:
Tanner menang sendirian
Semua tim lain langsung kalah
Orang paling pengen dibenci. Kalau dia ketawa pas dituduh, curiga 😈`,
    { parse_mode: 'Markdown' }
  );
}
           
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    toId(msg.chat.id),
    `*Commands:*
/newgame - Buat game baru
/join - Gabung game
/players - Lihat daftar pemain (status hidup/mati)
/mulai - Mulai game
/shoot - Gunner tembak (via DM bot)
/stop - Hentikan game (host)
/help - Bantuan
/listrole - Check list role`,
    { parse_mode: 'Markdown' }
  );
});

/** =========================================================
 * SECRET COMMANDS (DM only + whitelist username)
 * - tidak dimunculkan di /help
 * ========================================================= */
bot.onText(/\/givemerole_(.+)/, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  if (!isSecretAdmin(msg)) return bot.sendMessage(msg.chat.id, '❌ Kamu tidak punya izin.');

  const uid = toId(msg.from.id);
  const roleWanted = (match?.[1] || '').trim();

  const chatId = playerToChat[uid];
  const game = chatId ? games[chatId] : null;

  if (!game) return bot.sendMessage(uid, '⚠️ Kamu tidak sedang ada di lobby game manapun.');
  if (game.phase !== 'join') return bot.sendMessage(uid, '⚠️ Role hanya bisa diubah sebelum game dimulai (saat lobby).');

  const p = game.players[uid];
  if (!p) return bot.sendMessage(uid, '⚠️ Kamu belum /join di game itu.');

  if (!ALL_ROLES.includes(roleWanted)) {
    return bot.sendMessage(uid, `⚠️ Role tidak dikenal.\nRole tersedia:\n${ALL_ROLES.join(', ')}`);
  }

  p.forcedRole = roleWanted;
  return bot.sendMessage(uid, `✅ Role kamu diset ke *${roleWanted}*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/checkrole_all/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  if (!isSecretAdmin(msg)) return bot.sendMessage(msg.chat.id, '❌ Kamu tidak punya izin.');

  const uid = toId(msg.from.id);
  const chatId = playerToChat[uid];
  const game = chatId ? games[chatId] : null;

  if (!game) return bot.sendMessage(uid, '⚠️ Kamu tidak sedang ada di game manapun.');
  if (game.phase === 'join') return bot.sendMessage(uid, '⚠️ Game belum mulai. Role belum dibagi.');

  let text = '🧾 *Daftar role yang sedang bermain:*\n';
  for (const p of Object.values(game.players)) {
    text += `- ${p.name}: *${p.role}* ${p.alive ? '🟢' : '🔴'}\n`;
  }

  return bot.sendMessage(uid, text, { parse_mode: 'Markdown' });
});

/** =========================================================
 * CALLBACKS
 * ========================================================= */
bot.on('callback_query', async (q) => {
  const userId = toId(q.from.id);
  const data = q.data || '';

  const chatId = playerToChat[userId];
  const game = chatId ? games[chatId] : null;

  if (!game) {
    try { await bot.answerCallbackQuery(q.id, { text: 'Tidak ada aksi sekarang' }); } catch {}
    return;
  }

  /** -------- Hunter last shot choice -------- */
  if (data.startsWith('hunter_shoot_')) {
    const parts = data.split('_');
    const targetId = toId(parts[2]);
    const token = parts.slice(3).join('_');

    const ph = game.pendingHunter;
    if (!ph || ph.done || ph.token !== token) {
      return bot.answerCallbackQuery(q.id, { text: 'Tembakan sudah tidak valid.' });
    }
    if (userId !== ph.hunterId) {
      return bot.answerCallbackQuery(q.id, { text: 'Hanya Hunter yang bisa memilih.' });
    }
    if (!isAlive(game, targetId)) {
      return bot.answerCallbackQuery(q.id, { text: 'Target sudah mati/tidak valid.' });
    }

    ph.done = true;
    ph.timeout && clearTimeout(ph.timeout);

    game.players[targetId].alive = false;

    await bot.answerCallbackQuery(q.id, { text: `🎯 Kamu menembak ${game.players[targetId].name}` });
    await bot.sendMessage(game.chatId, `🎯 Hunter memilih menembak *${game.players[targetId].name}*`, { parse_mode: 'Markdown' });
    await revealDeath(game, `☠️ ${game.players[targetId].name} mati ditembak Hunter.`, targetId);

    const winner = checkWin(game);
    if (winner) return endGame(game, winner);

    return;
  }

  /** -------- Day vote -------- */
  if (game.phase === 'day' && data.startsWith('vote_')) {
    if (!game.players[userId]?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });

    const targetId = toId(data.split('_')[1]);
    if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });

    game.votes[userId] = targetId;
    await bot.answerCallbackQuery(q.id, { text: `Kamu memilih ${game.players[targetId].name}` });

    const aliveCount = alivePlayers(game).length;
    const votedCount = alivePlayers(game).filter(([pid]) => game.votes[toId(pid)]).length;

    const notVoted = alivePlayers(game)
      .filter(([pid]) => !game.votes[toId(pid)])
      .map(([_, p]) => p.name);

    const text =
      `${narrate('day')}\n\n` +
      `📊 Vote progress: ${votedCount}/${aliveCount}\n` +
      (notVoted.length ? `⏳ Belum vote: ${notVoted.join(', ')}` : `✅ Semua sudah vote.`);

    const keyboard = alivePlayers(game).map(([id, p]) => [{ text: p.name, callback_data: `vote_${id}` }]);
    await safeEditText(game.chatId, game.mainMessageId, text, { inline_keyboard: keyboard });

    if (votedCount >= aliveCount) await resolveDay(game);
    return;
  }

  /** -------- Day Gunner shoot (chosen via DM) -------- */
  if (data.startsWith('day_gunner_')) {
    const shooter = game.players[userId];
    if (!shooter?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
    if (shooter.role !== 'Gunner') return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan Gunner' });
    if (game.phase !== 'day') return bot.answerCallbackQuery(q.id, { text: 'Hanya bisa siang' });
    if (shooter.bullets <= 0) return bot.answerCallbackQuery(q.id, { text: 'Peluru habis' });

    const targetId = toId(data.split('_')[2]);
    if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
    if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Jangan...' });

    shooter.bullets -= 1;
    game.players[targetId].alive = false;

    await bot.answerCallbackQuery(q.id, { text: `🔫 Kamu menembak ${game.players[targetId].name}` });
    await bot.sendMessage(game.chatId, `🔫 Gunner *${shooter.name}* menembak *${game.players[targetId].name}* (peluru tersisa: ${shooter.bullets})`, { parse_mode: 'Markdown' });
    await revealDeath(game, `☠️ ${game.players[targetId].name} mati ditembak Gunner.`, targetId);

    if (game.players[targetId].role === 'WolfCub') {
      game.wolfCubFrenzyNext = 1;
      await bot.sendMessage(game.chatId, '🩸 *WolfCub mati!* Malam berikutnya Werewolf mengamuk: *2 korban*.', { parse_mode: 'Markdown' });
    }

    if (game.players[targetId].role === 'Hunter') {
      await triggerHunterLastShot(game, targetId, 'ditembak Gunner');
    }

    const winner = checkWin(game);
    if (winner) return endGame(game, winner);

    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    } catch {}

    return;
  }

  /** -------- Night actions -------- */
  if (game.phase === 'night') {
    // Wolf vote
    if (data.startsWith('night_wolf_')) {
      const me = game.players[userId];
      if (!me?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
      if (!WOLF_TEAM_ROLES.includes(me.role)) return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan wolf team' });
      if (me.wolfHangover) return bot.answerCallbackQuery(q.id, { text: '🥴 Kamu Mabuk. Malam ini tidak bisa menyerang.' });

      const targetId = toId(data.split('_')[2]);
      if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
      if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Bunuh diri bukan strategi.' });

      game.nightVotes[userId] = { type: 'wolf', target: targetId, playerId: userId };
      await bot.answerCallbackQuery(q.id, { text: `🐺 Kamu memilih ${game.players[targetId].name}` });

      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}
      return;
    }

    // SnowWolf freeze
    if (data.startsWith('night_snow_')) {
      const me = game.players[userId];
      if (!me?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
      if (me.role !== 'SnowWolf') return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan SnowWolf' });

      const targetId = toId(data.split('_')[2]);
      if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
      if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Beku sendiri? dingin amat.' });

      if ((game.players[targetId].snowImmune ?? 0) > 0) {
        return bot.answerCallbackQuery(q.id, { text: 'Target masih kebal SnowWolf malam ini.' });
      }

      game.snowTarget = targetId;
      game.nightVotes[userId] = { type: 'snow', target: targetId, playerId: userId };
      await bot.answerCallbackQuery(q.id, { text: `❄️ Kamu membekukan ${game.players[targetId].name}` });

      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}
      return;
    }

    // Seer check
    if (data.startsWith('night_seer_')) {
      const me = game.players[userId];
      if (!me?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
      if (me.role !== 'Seer') return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan Seer' });

      if (game.nightVotes[userId]?.type === 'seer') {
        return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah cek malam ini' });
      }

      const targetId = toId(data.split('_')[2]);
      if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
      if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Cermin tidak termasuk fitur.' });

      game.nightVotes[userId] = { type: 'seer', target: targetId, playerId: userId };
      await bot.answerCallbackQuery(q.id, { text: `🔮 Kamu memeriksa ${game.players[targetId].name}` });

      const realRole = game.players[targetId].role;
      const seenRole =
        (realRole === 'WolfMan') ? 'Werewolf' :
        (realRole === 'Lycan') ? 'Villager' :
        realRole;

      try {
        await bot.sendMessage(userId, `🔮 Hasil cek: *${game.players[targetId].name}* adalah *${seenRole}*`, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(game.chatId, `⚠️ Seer tidak bisa menerima DM (pemain belum /start bot).`);
      }

      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}
      return;
    }

    // Guardian protect
    if (data.startsWith('night_guardian_')) {
      const me = game.players[userId];
      if (!me?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
      if (me.role !== 'GuardianAngel') return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan Guardian' });

      const targetId = toId(data.split('_')[2]);
      if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
      if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Guardian tidak boleh jaga diri sendiri.' });

      game.nightVotes[userId] = { type: 'guardian', target: targetId, playerId: userId };
      await bot.answerCallbackQuery(q.id, { text: `🛡 Kamu menjaga ${game.players[targetId].name}` });

      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}
      return;
    }

    // Chemist choose target
    if (data.startsWith('night_chem_')) {
      const me = game.players[userId];
      if (!me?.alive) return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah mati' });
      if (me.role !== 'Chemist') return bot.answerCallbackQuery(q.id, { text: 'Kamu bukan Chemist' });

      if (game.chemistTarget) {
        return bot.answerCallbackQuery(q.id, { text: 'Kamu sudah memilih target malam ini' });
      }

      const targetId = toId(data.split('_')[2]);
      if (!isAlive(game, targetId)) return bot.answerCallbackQuery(q.id, { text: 'Target tidak valid' });
      if (targetId === userId) return bot.answerCallbackQuery(q.id, { text: 'Minum sendiri? itu namanya eksperimen.' });

      game.chemistTarget = targetId;
      game.nightVotes[userId] = { type: 'chemist', target: targetId, playerId: userId };
      await bot.answerCallbackQuery(q.id, { text: `🧪 Kamu mengunjungi ${game.players[targetId].name}` });

      await startChemistVisit(game, userId, targetId);

      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}
      return;
    }

    // Chemist target chooses potion
    if (data.startsWith('chem_choose_')) {
      const parts = data.split('_');
      const choice = parts[2]; // A or B
      const token = parts.slice(3).join('_');

      const pc = game.pendingChemist;
      if (!pc || pc.resolved || pc.token !== token) {
        return bot.answerCallbackQuery(q.id, { text: 'Pilihan potion sudah tidak berlaku.' });
      }
      if (userId !== toId(pc.targetId)) {
        return bot.answerCallbackQuery(q.id, { text: 'Ini bukan pilihanmu.' });
      }

      await bot.answerCallbackQuery(q.id, { text: `Kamu memilih Potion ${choice}` });
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      } catch {}

      await resolveChemistChoice(game, choice, false);
      return;
    }

    return bot.answerCallbackQuery(q.id, { text: 'Aksi malam tidak dikenali' });
  }

  try { await bot.answerCallbackQuery(q.id, { text: 'Tidak ada aksi sekarang' }); } catch {}
});

/** =========================================================
 * DEBUG
 * ========================================================= */
bot.onText(/\/nighttest/, (msg) => {
  const chatId = toId(msg.chat.id);
  const game = games[chatId];
  if (!game) return bot.sendMessage(chatId, 'No game.');
  startNight(game);
});



