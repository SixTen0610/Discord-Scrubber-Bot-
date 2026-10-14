'use strict';
/**
 * Codenames Live Notifier
 * Polls Twitch Helix for live streams in the Codenames category with the
 * stream language set to English, and posts each new broadcast to one or
 * more Discord channels (across any servers the bot has been invited to).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// ─── Config ────────────────────────────────────────────────────────────────
const list = (v) =>
  (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * DISCORD_CHANNEL_ID accepts a comma-separated list. Each entry is either
 *   channelId            -> post, no role ping
 *   channelId:roleId     -> post and ping that role (role must be in that server)
 * Example: DISCORD_CHANNEL_ID=111111111111111111:999999999999999999,222222222222222222
 *
 * Per-channel ignore list (optional): IGNORE_LOGINS_<channelId>=login1,login2
 * Those streamers are skipped for that one channel only. IGNORE_LOGINS still
 * skips streamers for every channel.
 */
function parseTargets(raw, legacyRoleId) {
  const targets = (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [channelId, roleId] = entry.split(':').map((s) => (s || '').trim());
      return {
        channelId,
        roleId: roleId || '',
        ignore: list(process.env[`IGNORE_LOGINS_${channelId}`]),
      };
    })
    .filter((t) => /^\d+$/.test(t.channelId));
  // Back-compat: old MENTION_ROLE_ID applies to the first (original) channel only
  if (legacyRoleId && targets[0] && !targets[0].roleId) targets[0].roleId = legacyRoleId;
  return targets;
}

const CFG = {
  discordToken: process.env.DISCORD_TOKEN,
  targets: parseTargets(process.env.DISCORD_CHANNEL_ID, (process.env.MENTION_ROLE_ID || '').trim()),
  twitchClientId: process.env.TWITCH_CLIENT_ID,
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET,
  gameName: process.env.GAME_NAME || 'Codenames',
  gameIdOverride: process.env.GAME_ID || '',
  language: (process.env.STREAM_LANGUAGE || 'en').toLowerCase(),
  pollSeconds: Math.max(60, Number(process.env.POLL_SECONDS) || 120),
  watchLogins: list(process.env.WATCH_LOGINS),   // empty = any streamer
  ignoreLogins: list(process.env.IGNORE_LOGINS),
  announceAlreadyLive: (process.env.ANNOUNCE_ALREADY_LIVE ?? 'true').toLowerCase() === 'true',
  stateFile: path.join(__dirname, 'state.json'),
  pruneAfterMs: 12 * 60 * 60 * 1000, // forget streams not seen for 12h
};

for (const key of ['discordToken', 'twitchClientId', 'twitchClientSecret']) {
  if (!CFG[key]) {
    console.error(`[config] Missing required setting: ${key}. Check your .env file.`);
    process.exit(1);
  }
}
if (!CFG.targets.length) {
  console.error('[config] DISCORD_CHANNEL_ID has no valid channel IDs. Check your .env file.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ─── State (so restarts don't re-announce) ─────────────────────────────────
// streamId -> { login, lastSeen, posted: [channelId, ...] }
let stateExisted = fs.existsSync(CFG.stateFile);
let state = { announced: {} };
if (stateExisted) {
  try { state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch (e) { log('[state] Could not parse state.json, starting fresh:', e.message); stateExisted = false; }
}
if (!state.announced) state.announced = {};
// Migrate single-channel entries: they were posted to the original (first) channel
for (const v of Object.values(state.announced)) {
  if (!Array.isArray(v.posted)) v.posted = [CFG.targets[0].channelId];
}
function saveState() {
  try { fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2)); }
  catch (e) { log('[state] Save failed:', e.message); }
}

// ─── Twitch Helix ──────────────────────────────────────────────────────────
let appToken = null;
let appTokenExpires = 0;

async function getAppToken(force = false) {
  if (!force && appToken && Date.now() < appTokenExpires - 60_000) return appToken;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CFG.twitchClientId,
      client_secret: CFG.twitchClientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  appToken = j.access_token;
  appTokenExpires = Date.now() + j.expires_in * 1000;
  log('[twitch] App access token refreshed');
  return appToken;
}

async function helix(endpoint, retry = true) {
  const res = await fetch(`https://api.twitch.tv/helix/${endpoint}`, {
    headers: {
      'Client-Id': CFG.twitchClientId,
      Authorization: `Bearer ${await getAppToken()}`,
    },
  });
  if (res.status === 401 && retry) {
    await getAppToken(true);
    return helix(endpoint, false);
  }
  if (!res.ok) throw new Error(`Helix ${endpoint.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

let gameId = null;
async function resolveGameId() {
  if (CFG.gameIdOverride) return CFG.gameIdOverride;
  const j = await helix(`games?name=${encodeURIComponent(CFG.gameName)}`);
  if (!j.data?.length) throw new Error(`Twitch has no category named "${CFG.gameName}"`);
  log(`[twitch] Category "${j.data[0].name}" -> id ${j.data[0].id}`);
  return j.data[0].id;
}

async function fetchMatchingStreams() {
  const streams = [];
  if (CFG.watchLogins.length) {
    // Watch-list mode: check only these channels (100 per request)
    for (let i = 0; i < CFG.watchLogins.length; i += 100) {
      const qs = CFG.watchLogins.slice(i, i + 100)
        .map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
      const j = await helix(`streams?first=100&${qs}`);
      streams.push(...j.data);
    }
  } else {
    // Discovery mode: every live English stream in the category
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const j = await helix(
        `streams?first=100&game_id=${gameId}&language=${CFG.language}${cursor ? `&after=${cursor}` : ''}`
      );
      streams.push(...j.data);
      cursor = j.pagination?.cursor;
      if (!cursor || j.data.length < 100) break;
    }
  }
  return streams.filter(
    (s) =>
      s.type === 'live' &&
      s.game_id === gameId &&
      (s.language || '').toLowerCase() === CFG.language &&
      !CFG.ignoreLogins.includes(s.user_login.toLowerCase())
  );
}

async function fetchProfileImages(userIds) {
  const map = {};
  for (let i = 0; i < userIds.length; i += 100) {
    const qs = userIds.slice(i, i + 100).map((id) => `id=${id}`).join('&');
    try {
      const j = await helix(`users?${qs}`);
      for (const u of j.data) map[u.id] = u.profile_image_url;
    } catch (e) { log('[twitch] Profile lookup failed:', e.message); }
  }
  return map;
}

// ─── Discord ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let channels = []; // [{ channelId, roleId, ignore, channel, label }]

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// Does this channel still owe a post for this stream?
const owes = (t, s) =>
  !state.announced[s.id].posted.includes(t.channelId) &&
  !t.ignore.includes(s.user_login.toLowerCase());

function buildEmbed(s, avatar) {
  const url = `https://twitch.tv/${s.user_login}`;
  const thumb = s.thumbnail_url
    .replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`;

  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setAuthor({ name: s.user_name, url, ...(avatar ? { iconURL: avatar } : {}) })
    .setTitle(trunc(s.title || `${s.user_name} is playing ${s.game_name}`, 256))
    .setURL(url)
    .addFields(
      { name: 'Game', value: s.game_name || CFG.gameName, inline: true },
      { name: 'Viewers', value: String(s.viewer_count), inline: true },
      { name: 'Language', value: s.language.toUpperCase(), inline: true }
    )
    .setImage(thumb)
    .setTimestamp(new Date(s.started_at));
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

async function announceTo(target, s, embed) {
  const url = `https://twitch.tv/${s.user_login}`;
  const ping = target.roleId ? `<@&${target.roleId}> ` : '';
  await target.channel.send({
    content: `${ping}🕵️ **${s.user_name}** is live with **${s.game_name}** in English! ${url}`,
    embeds: [embed],
    allowedMentions: { roles: target.roleId ? [target.roleId] : [] },
  });
  log(`[discord] Announced ${s.user_login} (stream ${s.id}) -> ${target.label}`);
}

// ─── Poll loop ─────────────────────────────────────────────────────────────
let firstPoll = true;

async function poll() {
  try {
    const streams = await fetchMatchingStreams();
    const now = Date.now();
    const silentStart = firstPoll && !stateExisted && !CFG.announceAlreadyLive;
    let postsMade = 0;

    // Update/initialise state for everything currently live
    for (const s of streams) {
      const entry = state.announced[s.id] || { posted: [] };
      entry.login = s.user_login;
      entry.lastSeen = now;
      if (silentStart) entry.posted = channels.map((t) => t.channelId);
      state.announced[s.id] = entry;
    }

    if (silentStart) {
      log(`[poll] First run: ${streams.length} stream(s) already live, recorded without posting`);
    } else {
      // Streams that still owe a post to at least one channel
      const pending = streams.filter((s) => channels.some((t) => owes(t, s)));
      if (pending.length) {
        const avatars = await fetchProfileImages(pending.map((s) => s.user_id));
        for (const s of pending) {
          const entry = state.announced[s.id];
          const embed = buildEmbed(s, avatars[s.user_id]);
          for (const t of channels) {
            if (!owes(t, s)) continue;
            try {
              await announceTo(t, s, embed);
              entry.posted.push(t.channelId); // only this channel is marked done
              postsMade++;
            } catch (e) {
              log(`[discord] Failed to announce ${s.user_login} -> ${t.label}:`, e.message, '(will retry next poll)');
            }
          }
        }
      }
    }

    // Prune old entries
    for (const [id, v] of Object.entries(state.announced)) {
      if (now - v.lastSeen > CFG.pruneAfterMs) delete state.announced[id];
    }

    saveState();
    firstPoll = false;
    log(`[poll] ${streams.length} matching live, ${postsMade} post(s) sent across ${channels.length} channel(s)`);
  } catch (e) {
    log('[poll] Error:', e.message);
  } finally {
    setTimeout(poll, CFG.pollSeconds * 1000);
  }
}

client.once('clientReady', async () => {
  log(`[discord] Logged in as ${client.user.tag}`);

  // Resolve every configured channel; skip (don't crash) on any that fail
  for (const t of CFG.targets) {
    try {
      const channel = await client.channels.fetch(t.channelId);
      if (!channel?.isTextBased()) throw new Error('not a text channel');
      const label = `#${channel.name} (${channel.guild?.name ?? 'DM'})`;
      const perms = channel.guild ? channel.permissionsFor(client.user) : null;
      if (perms) {
        const missing = [
          ['View Channel', PermissionFlagsBits.ViewChannel],
          ['Send Messages', PermissionFlagsBits.SendMessages],
          ['Embed Links', PermissionFlagsBits.EmbedLinks],
        ].filter(([, f]) => !perms.has(f)).map(([n]) => n);
        if (missing.length) throw new Error(`bot is missing permission(s): ${missing.join(', ')}`);
        if (t.roleId && !perms.has(PermissionFlagsBits.MentionEveryone)) {
          const role = channel.guild.roles.cache.get(t.roleId);
          if (role && !role.mentionable) {
            log(`[startup] Warning: role ${role.name} in ${label} isn't mentionable and the bot lacks "Mention Everyone" — pings won't notify`);
          }
        }
      }
      channels.push({ ...t, channel, label });
      log(`[startup] Channel OK: ${label}` +
          `${t.roleId ? ` (pings role ${t.roleId})` : ''}` +
          `${t.ignore.length ? ` (skips: ${t.ignore.join(', ')})` : ''}`);
    } catch (e) {
      log(`[startup] Skipping channel ${t.channelId}: ${e.message}`);
    }
  }
  if (!channels.length) {
    log('[startup] Fatal: none of the configured channels are usable');
    process.exit(1);
  }

  try {
    gameId = await resolveGameId();
  } catch (e) {
    log('[startup] Fatal:', e.message);
    process.exit(1);
  }
  log(`[startup] Watching ${CFG.watchLogins.length ? CFG.watchLogins.join(', ') : 'ALL streamers'} ` +
      `for ${CFG.gameName} / ${CFG.language}, every ${CFG.pollSeconds}s -> ${channels.length} channel(s)` +
      `${CFG.ignoreLogins.length ? ` (skips everywhere: ${CFG.ignoreLogins.join(', ')})` : ''}`);
  poll();
});

function shutdown() {
  log('[shutdown] Saving state and exiting');
  saveState();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(CFG.discordToken);
