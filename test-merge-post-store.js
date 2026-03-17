const fs = require('fs');
const path = require('path');
const { mergeScrapeSummary, DB_FILE } = require('./post-store');

const latestCandidates = [
  path.join(__dirname, 'scrape-results', 'latest.json'),
  path.join(__dirname, 'scrape-results', 'latest-v2.json'),
].filter(p => fs.existsSync(p));

if (!latestCandidates.length) {
  console.error('No latest scrape summary found');
  process.exit(1);
}

const latest = latestCandidates[0];
const summary = JSON.parse(fs.readFileSync(latest, 'utf8'));
const result = mergeScrapeSummary(summary);
console.log(JSON.stringify({ source: latest, dbFile: DB_FILE, result }, null, 2));
