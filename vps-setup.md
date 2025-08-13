# VPS Setup Instructions

## 1. Connect to your VPS
```bash
ssh root@YOUR_VPS_IP
```

## 2. Create deployment user
```bash
# Create deploy user
adduser deploy
usermod -aG sudo deploy

# Switch to deploy user
su - deploy
```

## 3. Setup SSH key for GitHub Actions
```bash
# Create .ssh directory
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Add the public key (replace with your actual public key)
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICbX13LbJnk4YJirGZW23jmY0OP+VrDSxhUGX5QpknIp github-actions-deploy" >> ~/.ssh/authorized_keys

# Set proper permissions
chmod 600 ~/.ssh/authorized_keys
```

## 4. Install Node.js and dependencies
```bash
# Install Node.js 20 (required for some packages)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Install PM2 globally
sudo npm install -g pm2

# Install PostgreSQL (if needed)
sudo apt-get install -y postgresql postgresql-contrib
```

## 5. Clone and setup your project
```bash
# Create web directory
sudo mkdir -p /var/www
sudo chown deploy:deploy /var/www

# Clone your repository (adjust URL to your actual repo)
cd /var/www
git clone https://github.com/caveman-eth/twitterbot.git
cd twitterbot

# Install ALL dependencies (including dev dependencies for TypeScript build)
npm ci

# Build the project
npm run build

# Now install production-only dependencies for runtime
npm ci --omit=dev
```

## 6. Setup environment variables
```bash
# Create .env file
cp .env.example .env
nano .env  # Edit with your actual values
```

## 7. Start the application
```bash
# Start with PM2
pm2 start dist/index.js --name ens-twitter-bot

# Save PM2 configuration
pm2 save
pm2 startup
```

## 8. Setup firewall (optional but recommended)
```bash
sudo ufw allow ssh
sudo ufw allow http
sudo ufw allow https
sudo ufw enable
```

## 9. Test the deployment
```bash
# Check if app is running
pm2 status
pm2 logs ens-twitter-bot

# Test the health endpoint
curl http://localhost:3000/health
```

## Your VPS is ready! 
Now add the secrets to GitHub and push to trigger deployment.
