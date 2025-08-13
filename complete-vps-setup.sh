#!/bin/bash

# Complete VPS Setup Script for ENS Twitter Bot
# Run as root initially, then switches to deploy user

set -e

echo "🚀 Starting complete VPS setup..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo -e "${GREEN}Running as root - setting up system...${NC}"
   
   # Update system
   echo "📦 Updating system packages..."
   apt update && apt upgrade -y
   
   # Install Node.js 22
   echo "📦 Installing Node.js 22..."
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs git
   
   # Install PostgreSQL
   echo "🗄️ Installing PostgreSQL..."
   apt-get install -y postgresql postgresql-contrib
   
   # Install Nginx
   echo "🌐 Installing Nginx..."
   apt-get install -y nginx
   
   # Install Certbot for SSL
   echo "🔒 Installing Certbot..."
   apt-get install -y certbot python3-certbot-nginx
   
   # Install PM2 globally
   echo "⚙️ Installing PM2..."
   npm install -g pm2
   
   # Create deploy user
   echo "👤 Creating deploy user..."
   adduser --disabled-password --gecos "" deploy
   usermod -aG sudo deploy
   
   # Setup SSH for deploy user
   mkdir -p /home/deploy/.ssh
   chown deploy:deploy /home/deploy/.ssh
   chmod 700 /home/deploy/.ssh
   
   echo -e "${YELLOW}Add your SSH public key to /home/deploy/.ssh/authorized_keys${NC}"
   echo -e "${YELLOW}Then run this script again as the deploy user${NC}"
   echo -e "${YELLOW}Command: sudo -u deploy $0${NC}"
   
   exit 0
fi

# Running as deploy user
echo -e "${GREEN}Running as deploy user - setting up application...${NC}"

# Setup PostgreSQL database
echo "🗄️ Setting up PostgreSQL database..."
sudo -u postgres psql << EOF
CREATE DATABASE ens_twitter_bot;
CREATE USER bot_user WITH ENCRYPTED PASSWORD 'change_this_password_123!';
GRANT ALL PRIVILEGES ON DATABASE ens_twitter_bot TO bot_user;
\q
EOF

# Create project directory
echo "📁 Setting up project directory..."
sudo mkdir -p /var/www
sudo chown deploy:deploy /var/www

# Clone repository
echo "📥 Cloning repository..."
cd /var/www
if [ ! -d "twitterbot" ]; then
    echo "Enter your GitHub repository URL (e.g., https://github.com/username/twitterbot.git):"
    read REPO_URL
    git clone $REPO_URL twitterbot
fi

cd twitterbot

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build project
echo "🔨 Building project..."
npm run build

# Install production dependencies
echo "📦 Installing production dependencies..."
npm ci --omit=dev

# Setup environment file
echo "⚙️ Setting up environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${YELLOW}Please edit .env file with your actual values:${NC}"
    echo "nano .env"
    echo ""
    echo "Update these values:"
    echo "- DATABASE_URL=postgresql://bot_user:change_this_password_123!@localhost:5432/ens_twitter_bot"
    echo "- Your Twitter API keys"
    echo "- Your Moralis API key"
    echo "- Other configuration values"
fi

# Setup Nginx
echo "🌐 Setting up Nginx..."
sudo tee /etc/nginx/sites-available/ens-bot > /dev/null << 'EOF'
server {
    listen 80;
    server_name _;  # Replace with your domain

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 10M;
    }
}
EOF

# Enable Nginx site
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/ens-bot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

# Setup firewall
echo "🔥 Setting up firewall..."
sudo ufw allow ssh
sudo ufw allow http
sudo ufw allow https
sudo ufw --force enable

# Start services
echo "🚀 Starting services..."
sudo systemctl start postgresql
sudo systemctl enable postgresql

echo -e "${GREEN}✅ VPS setup complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Edit .env file: nano .env"
echo "2. Start the application: pm2 start dist/index.js --name ens-twitter-bot"
echo "3. Save PM2 config: pm2 save && pm2 startup"
echo "4. Test: curl http://localhost:3000/health"
echo "5. Setup SSL: sudo certbot --nginx -d your-domain.com"
echo ""
echo -e "${GREEN}Your bot will be available at http://your-server-ip${NC}"
