// Creates the #website-audits Discord channel restricted to specific members,
// then creates a webhook the website-qa-bot can post to.
//
// Reuses production-bot's DISCORD_TOKEN (it has Administrator on the AHM guild).
// Run once: `node scripts/setup-channel.js`
// Prints the new channel ID + webhook URL for you to paste into .env.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || (() => {
  const prodEnv = path.join(process.env.HOME, 'Desktop', 'production-bot', '.env');
  if (fs.existsSync(prodEnv)) {
    const m = fs.readFileSync(prodEnv, 'utf8').match(/^DISCORD_TOKEN=(.*)$/m);
    return m ? m[1].trim() : null;
  }
  return null;
})();

const GUILD_ID = process.env.DISCORD_GUILD_ID || '1452597658291273829';
const CHANNEL_NAME = 'website-audits';

const ALLOWED_MEMBERS = [
  { name: 'Usama',  id: '1452596134219616276' },
  { name: 'Abhay',  id: '1183353034881908740' },
  { name: 'Nihal',  id: '1452581771072765995' },
  { name: 'Sahara', id: '1454890046527111374' },
  { name: 'Claudy', id: '1491793654933885068' },
];

async function main() {
  if (!DISCORD_TOKEN) {
    console.error('No DISCORD_TOKEN found (checked website-qa-bot/.env and production-bot/.env)');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(DISCORD_TOKEN).catch(reject);
  });
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.fetch();
  console.log(`Guild: ${guild.name}`);

  // Pre-fetch members so permission overwrites resolve cleanly
  for (const m of ALLOWED_MEMBERS) {
    try { await guild.members.fetch(m.id); }
    catch (err) { console.warn(`Could not fetch member ${m.name} (${m.id}): ${err.message}`); }
  }
  await guild.members.fetch(client.user.id).catch(() => {});

  // 1. Find or create channel
  let channel = guild.channels.cache.find((c) => c.name === CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (!channel) {
    const channels = await guild.channels.fetch();
    channel = channels.find((c) => c?.name === CHANNEL_NAME && c?.type === ChannelType.GuildText);
  }

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages] },
    ...ALLOWED_MEMBERS.map((m) => ({
      id: m.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
    })),
  ];

  if (!channel) {
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Daily AHM client website audits — performance, SEO, layout, image checks.',
      permissionOverwrites: overwrites,
    });
    console.log(`Created channel #${channel.name} (${channel.id})`);
  } else {
    for (const ow of overwrites) {
      try {
        await channel.permissionOverwrites.edit(ow.id, ow.allow ? Object.fromEntries(ow.allow.map((p) => [p, true])) : Object.fromEntries(ow.deny.map((p) => [p, false])));
      } catch (err) {
        console.warn(`Permission set failed for ${ow.id}: ${err.message}`);
      }
    }
    console.log(`Channel already exists, updated permissions: #${channel.name} (${channel.id})`);
  }

  // 2. Create or reuse webhook
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((w) => w.name === 'Website QA Bot');
  if (!webhook) {
    webhook = await channel.createWebhook({ name: 'Website QA Bot' });
    console.log(`Created webhook: ${webhook.name}`);
  } else {
    console.log(`Webhook exists: ${webhook.name}`);
  }

  console.log('\n--- ADD TO .env ---');
  console.log(`WEBSITE_AUDITS_CHANNEL_ID=${channel.id}`);
  console.log(`WEBSITE_AUDITS_WEBHOOK_URL=${webhook.url}`);
  console.log(`DISCORD_GUILD_ID=${GUILD_ID}`);
  console.log('--------------------\n');

  // 3. Persist to .env if it exists
  const envPath = path.join(__dirname, '..', '.env');
  let env = '';
  if (fs.existsSync(envPath)) env = fs.readFileSync(envPath, 'utf8');
  const setOrAppend = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(env)) env = env.replace(re, `${key}=${val}`);
    else env += `\n${key}=${val}`;
  };
  setOrAppend('WEBSITE_AUDITS_CHANNEL_ID', channel.id);
  setOrAppend('WEBSITE_AUDITS_WEBHOOK_URL', webhook.url);
  setOrAppend('DISCORD_GUILD_ID', GUILD_ID);
  fs.writeFileSync(envPath, env.trim() + '\n');
  console.log(`Wrote channel + webhook to ${envPath}`);

  await client.destroy();
}

main().catch((err) => { console.error(err); process.exit(1); });
