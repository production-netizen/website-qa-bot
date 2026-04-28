// Creates the parent Drive folder where all daily QA reports are saved.
// Run once: `node scripts/setup-drive-folder.js`
// Saves the folder ID to .env as REPORTS_DRIVE_FOLDER_ID.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { getDrive } = require('../lib/google');

const FOLDER_NAME = 'AHM Website QA Reports';

async function main() {
  const drive = getDrive();
  const list = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
  });
  let folder = list.data.files?.[0];

  if (!folder) {
    const res = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id, name, webViewLink',
    });
    folder = res.data;
    console.log(`Created folder "${folder.name}" (${folder.id})`);
  } else {
    console.log(`Folder already exists: "${folder.name}" (${folder.id})`);
  }

  console.log(`URL: ${folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`}`);

  const envPath = path.join(__dirname, '..', '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const re = /^REPORTS_DRIVE_FOLDER_ID=.*$/m;
  if (re.test(env)) env = env.replace(re, `REPORTS_DRIVE_FOLDER_ID=${folder.id}`);
  else env += `\nREPORTS_DRIVE_FOLDER_ID=${folder.id}`;
  fs.writeFileSync(envPath, env.trim() + '\n');
  console.log(`Wrote REPORTS_DRIVE_FOLDER_ID to ${envPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
