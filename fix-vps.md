# Quick Fix for Current VPS Issues

## Run these commands on your VPS to fix the current problems:

```bash
# 1. Upgrade to Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Verify Node.js version
node --version  # Should show v20.x.x

# 3. Navigate to your project
cd /var/www/twitterbot

# 4. Clean install with ALL dependencies (including dev deps for TypeScript)
rm -rf node_modules package-lock.json
npm install

# 5. Build the project (should work now with dev dependencies)
npm run build

# 6. Install production-only dependencies for runtime
npm ci --omit=dev

# 7. Setup environment file
cp .env.example .env
nano .env  # Edit with your actual values

# 8. Start with PM2
pm2 start dist/index.js --name ens-twitter-bot

# 9. Save PM2 configuration and enable startup
pm2 save
pm2 startup  # Follow the instructions it gives you

# 10. Check status
pm2 status
pm2 logs ens-twitter-bot

# 11. Test the health endpoint
curl http://localhost:3000/health
```

## If you get permission errors:
```bash
sudo chown -R deploy:deploy /var/www/twitterbot
```

## After this fix, your GitHub Actions deployment should work perfectly!
