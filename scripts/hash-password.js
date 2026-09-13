// Hulpscriptje om lokaal een wachtwoord-hash te berekenen op EXACT dezelfde
// manier als de Worker dat doet (sha256(wachtwoord + pepper)), zodat je een
// user rechtstreeks in de Workers KV kan zetten met `wrangler kv key put`
// zonder dat het wachtwoord ooit in leesbare vorm in de KV terechtkomt.
//
// Gebruik:
//   node scripts/hash-password.js <wachtwoord> <pepper>
//
// <pepper> moet exact dezelfde waarde zijn als wat je hebt ingegeven bij:
//   npx wrangler secret put PASSWORD_PEPPER

const crypto = require('crypto');

const [, , password, pepper] = process.argv;

if (!password || !pepper) {
  console.error('Gebruik: node scripts/hash-password.js <wachtwoord> <pepper>');
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(password + pepper).digest('hex');
console.log(hash);
