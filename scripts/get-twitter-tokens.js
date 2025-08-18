const OAuth = require('oauth-1.0a');
const crypto = require('crypto-js');
const https = require('https');
const querystring = require('querystring');
require('dotenv').config();

// Your Twitter App Credentials (loaded from environment variables)
const API_KEY = process.env.TWITTER_API_KEY;
const API_SECRET = process.env.TWITTER_API_SECRET;
const CALLBACK_URL = process.env.TWITTER_CALLBACK_URL;

if (!API_KEY || !API_SECRET || !CALLBACK_URL) {
  console.error('❌ Missing required environment variables.');
  console.error('   Please set TWITTER_API_KEY, TWITTER_API_SECRET, and TWITTER_CALLBACK_URL');
  process.exit(1);
}

// Initialize OAuth 1.0a
const oauth = OAuth({
  consumer: { key: API_KEY, secret: API_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.HmacSHA1(base_string, key).toString(crypto.enc.Base64);
  },
});

// Step 1: Get Request Token
async function getRequestToken() {
  console.log('🔄 Step 1: Getting request token...\n');
  
  const requestData = {
    url: 'https://api.twitter.com/oauth/request_token',
    method: 'POST',
    data: { oauth_callback: CALLBACK_URL },
  };

  const authHeader = oauth.toHeader(oauth.authorize(requestData));

  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({ oauth_callback: CALLBACK_URL });
    
    const options = {
      hostname: 'api.twitter.com',
      path: '/oauth/request_token',
      method: 'POST',
      headers: {
        'Authorization': authHeader.Authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          const params = querystring.parse(data);
          console.log('✅ Request token obtained!');
          console.log('   oauth_token:', params.oauth_token);
          console.log('   oauth_token_secret:', params.oauth_token_secret);
          console.log('   oauth_callback_confirmed:', params.oauth_callback_confirmed);
          console.log('');
          resolve(params);
        } else {
          console.error('❌ Error getting request token:', res.statusCode, data);
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Request error:', err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// Step 2: Generate Authorization URL
function getAuthorizationURL(oauthToken) {
  const authURL = `https://api.twitter.com/oauth/authorize?oauth_token=${oauthToken}`;
  console.log('🔄 Step 2: User Authorization');
  console.log('');
  console.log('📋 INSTRUCTIONS:');
  console.log('1. Open this URL in your browser:');
  console.log(`   ${authURL}`);
  console.log('');
  console.log('2. Log in with your bot account');
  console.log('3. Click "Authorize app"');
  console.log(`4. You will be redirected to your callback URL (${CALLBACK_URL}) with oauth_verifier`);
  console.log('5. Copy the oauth_verifier from the URL and run Step 3');
  console.log('');
  console.log('🔗 Authorization URL:');
  console.log(authURL);
  console.log('');
}

// Step 3: Exchange for Access Token
async function getAccessToken(oauthToken, oauthTokenSecret, oauthVerifier) {
  console.log('🔄 Step 3: Getting access token...\n');
  
  const requestData = {
    url: 'https://api.twitter.com/oauth/access_token',
    method: 'POST',
    data: { 
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier 
    },
  };

  const token = { key: oauthToken, secret: oauthTokenSecret };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));

  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({ 
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier 
    });
    
    const options = {
      hostname: 'api.twitter.com',
      path: '/oauth/access_token',
      method: 'POST',
      headers: {
        'Authorization': authHeader.Authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          const params = querystring.parse(data);
          console.log('🎉 SUCCESS! Access tokens obtained!');
          console.log('');
          console.log('📋 ADD THESE TO YOUR ENVIRONMENT VARIABLES:');
          console.log('');
          console.log('TWITTER_API_KEY=(already set)');
          console.log('TWITTER_API_SECRET=(already set)');
          console.log(`TWITTER_ACCESS_TOKEN=${params.oauth_token}`);
          console.log(`TWITTER_ACCESS_TOKEN_SECRET=${params.oauth_token_secret}`);
          console.log('');
          console.log('👤 These tokens are for user:', params.screen_name);
          console.log('🆔 User ID:', params.user_id);
          console.log('');
          resolve(params);
        } else {
          console.error('❌ Error getting access token:', res.statusCode, data);
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Request error:', err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Step 1 & 2: Get request token and show authorization URL
    try {
      const requestToken = await getRequestToken();
      getAuthorizationURL(requestToken.oauth_token);
      
      console.log('💡 NEXT STEP:');
      console.log(`   node scripts/get-twitter-tokens.js ${requestToken.oauth_token} ${requestToken.oauth_token_secret} YOUR_OAUTH_VERIFIER`);
      console.log('');
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  } else if (args.length === 3) {
    // Step 3: Exchange for access token
    const [oauthToken, oauthTokenSecret, oauthVerifier] = args;
    try {
      await getAccessToken(oauthToken, oauthTokenSecret, oauthVerifier);
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  } else {
    console.log('Usage:');
    console.log('  Step 1 & 2: node scripts/get-twitter-tokens.js');
    console.log('  Step 3:     node scripts/get-twitter-tokens.js <oauth_token> <oauth_token_secret> <oauth_verifier>');
  }
}

main();
