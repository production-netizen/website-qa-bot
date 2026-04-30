// Discord on-demand audit listener.
// Watches the #website-audits channel for messages containing a URL
// (or a `!audit <url>` command) and runs a fast single-site audit,
// posting back: a styled embed summary + the PDF as an attachment.

const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Events, EmbedBuilder, AttachmentBuilder } = require('discord.js');

const { auditClient, persistAudit } = require('./audit');
const { closeBrowser: closeLhBrowser } = require('./lighthouse');
const { closeBrowser: closeVisionBrowser } = require('./vision');
const { closeBrowser: closePdfBrowser } = require('./pdf');

const URL_RE = /https?:\/\/[^\s<>")\]]+/i;

// Very small per-channel queue — only one on-demand audit at a time so we
// don't fight Lighthouse + the cron run for the same Chromium.
let queue = Promise.resolve();
let queueLength = 0;

function enqueue(fn) {
  queueLength++;
  const p = queue.then(() => fn());
  // Always release the queue slot, success or fail
  queue = p.catch(() => {}).finally(() => { queueLength--; });
  return p;
}

function statusColor(score) {
  if (score == null) return 0x64748B;
  if (score >= 80) return 0x10B981;
  if (score >= 65) return 0xF59E0B;
  return 0xEF4444;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch { return url; }
}

function startListener({ reportsDir, log = console.log }) {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.WEBSITE_AUDITS_CHANNEL_ID;
  if (!token || !channelId) {
    log('[listener] DISCORD_TOKEN or WEBSITE_AUDITS_CHANNEL_ID missing — skipping on-demand listener');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    log(`[listener] online as ${c.user.tag} — watching #website-audits (${channelId})`);
  });

  client.on(Events.MessageCreate, async (msg) => {
    try {
      // Only the audit channel; ignore bots (incl. webhook posts from us)
      if (msg.channelId !== channelId) return;
      if (msg.author.bot) return;

      const content = (msg.content || '').trim();

      // Help command
      if (/^!help\b/i.test(content) || /^!audit\s*$/i.test(content)) {
        await msg.reply({
          content: '👋 **Website QA Bot — on-demand**\n' +
            'Drop a website URL into this channel (or `!audit <url>`) and I\'ll run a full audit:\n' +
            '• 3-page crawl + Lighthouse mobile/desktop\n' +
            '• SEO, CRO, compliance, image, layout-vision checks\n' +
            '• Designed PDF report uploaded to Drive + posted here\n' +
            '_Daily auto-audit of every Live AHM site still runs at 6 AM UK time._',
        });
        return;
      }

      // Find first URL in message
      const m = content.match(URL_RE);
      if (!m) return;
      // Strip markdown angle brackets / trailing punctuation
      let url = m[0].replace(/[<>]/g, '').replace(/[.,;:!?)\]]+$/, '');
      try { new URL(url); } catch { return; }

      // Don't audit our own site or random Discord links
      if (/discord\.com|cdn\.discordapp\.com/i.test(url)) return;

      // Position-in-queue notice if there's already work running
      if (queueLength >= 1) {
        await msg.react('⏳').catch(() => {});
      } else {
        await msg.react('🔍').catch(() => {});
      }

      const ackMsg = await msg.reply({ content: `🔍 Auditing ${url} — this takes ~60-90 seconds. I'll edit this message when I'm done.` });

      enqueue(async () => {
        try {
          const requesterName = msg.member?.displayName || msg.author?.username || 'someone';
          const friendlyName = `${nameFromUrl(url)} (requested by ${requesterName})`;
          const clientObj = { name: friendlyName, url, status: 'On-demand', developer: '', team: '', notes: '' };

          await ackMsg.edit({ content: `🔍 Auditing **${url}** — crawling pages…` }).catch(() => {});

          const audit = await auditClient(clientObj, {
            // Fast on-demand defaults — keep the crawl tight
            maxPages: parseInt(process.env.QA_ONDEMAND_MAX_PAGES || '3', 10),
            maxVisionPages: parseInt(process.env.QA_ONDEMAND_VISION_PAGES || '1', 10),
            log,
          });

          await ackMsg.edit({ content: `🔍 Auditing **${url}** — generating designed PDF…` }).catch(() => {});

          const { summary, pdfLink, localPdfPath, pdfBuffer, driveLink } = await persistAudit(audit, { reportsDir, log });

          // Build response embed
          const embed = new EmbedBuilder()
            .setColor(statusColor(summary.healthScore))
            .setTitle(`Website QA — ${nameFromUrl(url)}`)
            .setURL(url)
            .setDescription(`**Overall: ${summary.healthScore}/100 (${summary.healthGrade}) — ${summary.healthStatus}**\n` +
              `🔴 ${summary.high} high · 🟡 ${summary.medium} medium · 🟢 ${summary.low} observations · across ${summary.pages} pages`)
            .addFields(
              { name: 'Mobile Performance', value: `${summary.perfMobile ?? '—'}`, inline: true },
              { name: 'Desktop Performance', value: `${summary.perfDesktop ?? '—'}`, inline: true },
              { name: 'Lighthouse SEO (mobile)', value: `${summary.seoMobile ?? '—'}`, inline: true },
            );

          if (summary.topFixes && summary.topFixes.length) {
            const fixes = summary.topFixes.map((f, i) => {
              const sevEmoji = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
              const trimmed = f.flag.length > 110 ? f.flag.slice(0, 107) + '…' : f.flag;
              return `${i + 1}. ${sevEmoji} ${trimmed}\n   _${f.where}_`;
            }).join('\n');
            embed.addFields({ name: '🎯 Top 3 Fixes (Pareto)', value: fixes });
          }

          const links = [];
          if (pdfLink) links.push(`📄 [Designed PDF](${pdfLink})`);
          if (driveLink) links.push(`📝 [Editable Doc](${driveLink})`);
          if (links.length) embed.addFields({ name: 'Full report', value: links.join(' · ') });

          embed.setFooter({ text: `AHM Website QA · audited ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}` });

          // Attach the PDF directly so it's viewable in Discord without leaving
          const files = [];
          if (localPdfPath && fs.existsSync(localPdfPath)) {
            const stat = fs.statSync(localPdfPath);
            // Discord limit (no Nitro): ~25MB. Most reports are <5MB.
            if (stat.size < 24 * 1024 * 1024) {
              files.push(new AttachmentBuilder(localPdfPath, { name: `${nameFromUrl(url)} — Website QA.pdf` }));
            }
          } else if (pdfBuffer) {
            files.push(new AttachmentBuilder(pdfBuffer, { name: `${nameFromUrl(url)} — Website QA.pdf` }));
          }

          await ackMsg.edit({ content: `✅ Audit complete — **${nameFromUrl(url)}**`, embeds: [embed], files }).catch(async (err) => {
            // discord.js may not allow editing files into an existing message — fallback to a new reply
            log(`[listener] edit-with-files failed (${err.message}) — sending new reply`);
            await msg.reply({ content: `✅ Audit complete — **${nameFromUrl(url)}**`, embeds: [embed], files });
          });

          await msg.react('✅').catch(() => {});
        } catch (err) {
          log(`[listener] audit failed for ${url}: ${err.message}`);
          await ackMsg.edit({ content: `❌ Audit failed for ${url}\n\`${String(err.message).slice(0, 300)}\`` }).catch(() => {});
          await msg.react('❌').catch(() => {});
        }
      });
    } catch (err) {
      log(`[listener] handler error: ${err.stack || err.message}`);
    }
  });

  client.on('error', (err) => log(`[listener] error: ${err.message}`));
  client.on('shardError', (err) => log(`[listener] shard error: ${err.message}`));

  client.login(token).catch((err) => log(`[listener] login failed: ${err.message}`));

  return {
    client,
    stop: async () => {
      try { await client.destroy(); } catch {}
      await Promise.all([
        closeLhBrowser().catch(() => {}),
        closeVisionBrowser().catch(() => {}),
        closePdfBrowser().catch(() => {}),
      ]);
    },
  };
}

module.exports = { startListener };
