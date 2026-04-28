// Retroactively make every report in the parent Drive folder public ("anyone with link").
// Run once after switching to public-link reports, and any time we want to be sure
// existing reports are reachable by Usama / Abhay / etc without "Request access".

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDrive, makePublic } = require('../lib/google');

async function main() {
  const folderId = process.env.REPORTS_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.error('REPORTS_DRIVE_FOLDER_ID not set');
    process.exit(1);
  }
  const drive = getDrive();

  // Make the folder itself public so the URL works directly
  try {
    await makePublic(folderId);
    console.log(`✓ folder ${folderId} → public`);
  } catch (err) {
    console.warn(`folder makePublic failed: ${err.message}`);
  }

  let pageToken;
  let count = 0;
  let failed = 0;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
      pageToken,
    });
    for (const f of res.data.files || []) {
      try {
        await makePublic(f.id);
        count++;
        if (count % 10 === 0) console.log(`  …${count} done`);
      } catch (err) {
        failed++;
        console.warn(`  ✗ ${f.name}: ${err.message}`);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`\n✓ made ${count} report(s) public, ${failed} failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
