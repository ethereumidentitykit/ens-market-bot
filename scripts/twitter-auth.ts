/**
 * OAuth 1.0a 3-legged auth flow for Twitter/X.
 *
 * Run once to authorize a bot account against your app.
 * Outputs the Access Token + Access Token Secret to put in your .env.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/twitter-auth.ts
 *
 * Requires env vars (or will prompt):
 *   TWITTER_API_KEY      - your app's consumer key
 *   TWITTER_API_SECRET   - your app's consumer secret
 */

import dotenv from 'dotenv';
dotenv.config();

import OAuth from 'oauth-1.0a';
import * as crypto from 'crypto-js';
import https from 'https';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

function httpsRequest(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n=== Twitter/X OAuth 1.0a Authorization ===\n');

  const apiKey = process.env.TWITTER_API_KEY || (await ask('Consumer Key (API Key): '));
  const apiSecret = process.env.TWITTER_API_SECRET || (await ask('Consumer Secret (API Secret): '));

  if (!apiKey || !apiSecret) {
    console.error('Consumer key and secret are required.');
    process.exit(1);
  }

  const oauth = new OAuth({
    consumer: { key: apiKey, secret: apiSecret },
    signature_method: 'HMAC-SHA1',
    hash_function(base_string: string, key: string): string {
      return crypto.HmacSHA1(base_string, key).toString(crypto.enc.Base64);
    },
  });

  // Step 1: Get request token (PIN-based flow — callback = "oob")
  const requestTokenUrl = 'https://api.twitter.com/oauth/request_token?oauth_callback=oob';
  const reqTokenData = { url: requestTokenUrl, method: 'POST' as const };
  const reqTokenAuth = oauth.toHeader(oauth.authorize(reqTokenData));

  console.log('Requesting token...');
  const reqTokenRes = await httpsRequest(requestTokenUrl, 'POST', {
    Authorization: reqTokenAuth.Authorization,
  });

  if (reqTokenRes.status !== 200) {
    console.error(`Failed to get request token (HTTP ${reqTokenRes.status}):`);
    console.error(reqTokenRes.data);
    process.exit(1);
  }

  const reqTokenParams = new URLSearchParams(reqTokenRes.data);
  const oauthToken = reqTokenParams.get('oauth_token');
  const oauthTokenSecret = reqTokenParams.get('oauth_token_secret');

  if (!oauthToken || !oauthTokenSecret) {
    console.error('Invalid request token response:', reqTokenRes.data);
    process.exit(1);
  }

  // Step 2: Direct user to authorize
  const authorizeUrl = `https://api.twitter.com/oauth/authorize?oauth_token=${oauthToken}`;
  console.log('\n1. Open this URL in a browser where you are logged into the BOT account:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log('2. Authorize the app, then copy the PIN code shown.\n');

  const pin = await ask('Enter the PIN: ');

  if (!pin) {
    console.error('PIN is required.');
    process.exit(1);
  }

  // Step 3: Exchange for access token
  const accessTokenUrl = `https://api.twitter.com/oauth/access_token?oauth_verifier=${pin}`;
  const accTokenData = { url: accessTokenUrl, method: 'POST' as const };
  const accToken = { key: oauthToken, secret: oauthTokenSecret };
  const accTokenAuth = oauth.toHeader(oauth.authorize(accTokenData, accToken));

  const accTokenRes = await httpsRequest(accessTokenUrl, 'POST', {
    Authorization: accTokenAuth.Authorization,
  });

  if (accTokenRes.status !== 200) {
    console.error(`Failed to get access token (HTTP ${accTokenRes.status}):`);
    console.error(accTokenRes.data);
    process.exit(1);
  }

  const accTokenParams = new URLSearchParams(accTokenRes.data);
  const accessToken = accTokenParams.get('oauth_token');
  const accessTokenSecret = accTokenParams.get('oauth_token_secret');
  const screenName = accTokenParams.get('screen_name');
  const userId = accTokenParams.get('user_id');

  if (!accessToken || !accessTokenSecret) {
    console.error('Invalid access token response:', accTokenRes.data);
    process.exit(1);
  }

  console.log(`\n=== Success! Authorized as @${screenName} (ID: ${userId}) ===\n`);
  console.log('Add these to your .env:\n');
  console.log(`TWITTER_API_KEY=${apiKey}`);
  console.log(`TWITTER_API_SECRET=${apiSecret}`);
  console.log(`TWITTER_ACCESS_TOKEN=${accessToken}`);
  console.log(`TWITTER_ACCESS_TOKEN_SECRET=${accessTokenSecret}`);
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
