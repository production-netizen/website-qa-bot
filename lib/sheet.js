const { getDrive } = require('./google');

async function fetchTrackerCsv(sheetId) {
  const drive = getDrive();
  const res = await drive.files.export(
    { fileId: sheetId, mimeType: 'text/csv' },
    { responseType: 'text' }
  );
  return res.data;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(csv) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') { inQuotes = !inQuotes; cur += ch; }
    else if (ch === '\n' && !inQuotes) { rows.push(cur); cur = ''; }
    else if (ch === '\r' && !inQuotes) { /* skip */ }
    else cur += ch;
  }
  if (cur.length) rows.push(cur);
  return rows.map(parseCsvLine);
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase());
    if (cells.some((c) => c === 'main domain' || c === 'main domain ')) return i;
  }
  return -1;
}

function indexCol(headers, name) {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === target);
}

async function loadClients({ sheetId, statusFilter = 'Live' } = {}) {
  if (!sheetId) sheetId = process.env.TRACKER_SHEET_ID;
  if (!sheetId) throw new Error('TRACKER_SHEET_ID not set');

  const csv = await fetchTrackerCsv(sheetId);
  const rows = parseCsv(csv);
  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) throw new Error('Could not find header row in tracker sheet');

  const headers = rows[headerIdx];
  const colName = 0;
  const colStatus = indexCol(headers, 'Status');
  const colDomain = indexCol(headers, 'Main Domain');
  const colStaging = indexCol(headers, 'Staging Link');
  const colDeveloper = indexCol(headers, 'Developer');
  const colTeam = indexCol(headers, 'Assign Team');
  const colNotes = indexCol(headers, 'Team Notes/Remarks');

  const filters = (statusFilter || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const clients = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const name = (row[colName] || '').trim();
    const status = (colStatus >= 0 ? row[colStatus] : '').trim();
    if (!name || name.toLowerCase() === 'clients') continue;

    const main = (colDomain >= 0 ? row[colDomain] : '').trim();
    const staging = (colStaging >= 0 ? row[colStaging] : '').trim();
    const url = main || staging;
    if (!url || !/^https?:\/\//i.test(url)) continue;

    if (filters.length && !filters.includes(status.toLowerCase())) continue;

    clients.push({
      name,
      url,
      status,
      developer: (colDeveloper >= 0 ? row[colDeveloper] : '').trim(),
      team: (colTeam >= 0 ? row[colTeam] : '').trim(),
      notes: (colNotes >= 0 ? row[colNotes] : '').trim(),
    });
  }
  return clients;
}

module.exports = { loadClients };
