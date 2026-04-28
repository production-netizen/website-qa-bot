require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runOnce } = require('../bot');

runOnce().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
