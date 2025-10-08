// Dashboard JavaScript using Alpine.js
function dashboard() {
    // Helper function to ensure credentials are always included
    async function fetchWithCredentials(url, options = {}) {
        return fetch(url, {
            ...options,
            credentials: 'include', // Always include cookies for authentication
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
    }
    
    return {
        // Use the wrapped fetch for all API calls
        fetch: fetchWithCredentials,
        
        // Authentication State
        isAuthenticated: false,
        walletConnected: false,
        connectedAddress: null,
        connecting: false,
        signing: false,
        checking: false,
        authError: '',
        
        // View State
        currentView: 'classic', // 'classic' or 'database'
        databaseSubView: 'sales', // 'sales', 'registrations', or 'bids'
        
        // Master API Toggles
        apiToggles: {
            twitterEnabled: true,
            moralisEnabled: true,
            magicEdenEnabled: true
        },
        
        // Price Tier Configuration
        priceTiers: {
            sales: {
                tier1: 5000,
                tier2: 10000,
                tier3: 40000
            },
            registrations: {
                tier1: 5000,
                tier2: 10000,
                tier3: 40000
            },
            bids: {
                tier1: 5000,
                tier2: 10000,
                tier3: 40000
            }
        },
        
        // Auto-posting settings (transaction-specific)
        autoPostSettings: {
            enabled: false, // Global toggle
            sales: {
                enabled: true,
                minEthDefault: 0.1,
                minEth10kClub: 0.5,
                minEth999Club: 0.3,
                maxAgeHours: 1
            },
            registrations: {
                enabled: true,
                minEthDefault: 0.05,
                minEth10kClub: 0.2,
                minEth999Club: 0.1,
                maxAgeHours: 2
            },
            bids: {
                enabled: true,
                minEthDefault: 0.2,
                minEth10kClub: 1.0,
                minEth999Club: 0.5,
                maxAgeHours: 24
            }
        },
        
        // Tweet history
        tweetHistory: [],
        
        // State
        stats: {},
        recentSales: [],
        schedulerStatus: null,
        systemStatus: 'unknown',
        loading: false,
        processing: false,
        testing: false,
        schedulerLoading: false,
        lastProcessResult: null,
        
        // Twitter state
        twitterConfig: null,
        twitterRateLimit: null,
        twitterMessage: '',
        twitterMessageType: 'info',

        // Image generation state
        generatedImage: null,
        imageData: null,
        imageGenerationTime: null,
        imageGeneratedAt: null,
        testImageToken: '',

        // New tweet generation state
        tweetType: 'sale', // 'sale', 'registration', or 'bid'
        unpostedSales: [],
        selectedSaleId: '',
        unpostedRegistrations: [],
        selectedRegistrationId: '',
        unpostedBids: [],
        selectedBidId: '',
        generatedTweet: null,
        tweetBreakdown: null,
        tweetImageUrl: null,
        tweetGenerating: false,
        tweetSending: false,

        // AI Replies state
        aiRepliesEnabled: false,
        openaiConfigured: false,
        aiRepliesGenerated: 0,
        aiReplyType: 'sale', // 'sale' or 'registration'
        aiReplyTransactionId: '',
        postedSales: [],
        postedRegistrations: [],
        generatedAIReply: null,
        aiReplyGenerating: false,
        aiReplySending: false,
        aiReplyMessage: '',
        aiReplyMessageType: 'info',

        // Database management state
        databaseResetting: false,
        salesClearing: false,
        databaseResetMessage: '',
        databaseResetMessageType: 'info',
        processingReset: false,

        // Sale modal state
        selectedSale: null,
        
        // Bid modal state
        selectedBid: null,

        // Database viewer state
        databaseView: {
            data: null,
            loading: false,
            searchTerm: '',
            sortBy: 'blockNumber',
            sortOrder: 'desc',
            limit: 50,
            currentPage: 1,
            searchTimeout: null,
            ethFilter: 'all', // 'all', '0.1+', '0.5+', '1+', '5+', '10+'

            async loadPage(page) {
                this.loading = true;
                this.currentPage = page;
                
                try {
                    // Get a larger dataset to apply client-side filtering
                    const params = new URLSearchParams({
                        page: 1,
                        limit: '1000', // Get more data for client-side filtering
                        sortBy: this.sortBy,
                        sortOrder: this.sortOrder
                    });

                    if (this.searchTerm.trim()) {
                        params.append('search', this.searchTerm.trim());
                    }

                    const response = await fetch(`/api/database/sales?${params}`);
                    const result = await response.json();

                    if (result.success) {
                        let sales = result.data.sales;
                        
                        // Apply ETH filter
                        sales = this.applyEthFilter(sales);
                        
                        // Apply pagination to filtered results
                        const totalFiltered = sales.length;
                        const offset = (page - 1) * this.limit;
                        const paginatedSales = sales.slice(offset, offset + this.limit);
                        
                        // Update data structure
                        this.data = {
                            sales: paginatedSales,
                            stats: {
                                ...result.data.stats,
                                filteredResults: totalFiltered
                            },
                            pagination: {
                                page: page,
                                limit: this.limit,
                                total: totalFiltered,
                                totalPages: Math.ceil(totalFiltered / this.limit),
                                hasPrev: page > 1,
                                hasNext: page < Math.ceil(totalFiltered / this.limit)
                            }
                        };
                    } else {
                        console.error('Failed to load database data:', result.error);
                    }
                } catch (error) {
                    console.error('Error loading database data:', error);
                } finally {
                    this.loading = false;
                }
            },

            sort(field) {
                if (this.sortBy === field) {
                    this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortBy = field;
                    this.sortOrder = field === 'blockNumber' || field === 'priceEth' || field === 'id' ? 'desc' : 'asc';
                }
                this.loadPage(1);
            },

            searchDebounced() {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
                    this.loadPage(1);
                }, 500);
            },

            setEthFilter(filter) {
                this.ethFilter = filter;
                this.loadPage(1);
            },

            applyEthFilter(sales) {
                if (this.ethFilter === 'all') {
                    return sales;
                }

                const threshold = parseFloat(this.ethFilter.replace('+', ''));
                return sales.filter(sale => parseFloat(sale.priceEth) >= threshold);
            }
        },

        // ENS Registrations viewer state
        registrationsView: {
            data: null,
            loading: false,
            searchTerm: '',
            sortBy: 'blockNumber',
            sortOrder: 'desc',
            limit: 25,
            currentPage: 1,
            searchTimeout: null,
            error: null,

            async loadPage(page) {
                this.loading = true;
                this.currentPage = page;
                this.error = null;
                
                try {
                    const params = new URLSearchParams({
                        page: page,
                        limit: this.limit,
                        sortBy: this.sortBy,
                        sortOrder: this.sortOrder
                    });

                    if (this.searchTerm.trim()) {
                        params.append('search', this.searchTerm.trim());
                    }

                    const response = await fetch(`/api/database/registrations?${params}`);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    const result = await response.json();

                    if (result.success) {
                        this.data = result.data;
                    } else {
                        this.error = result.error || 'Failed to load registrations';
                        this.data = null;
                    }
                } catch (error) {
                    this.error = error.message;
                    this.data = null;
                } finally {
                    this.loading = false;
                }
            },

            sort(field) {
                if (this.sortBy === field) {
                    this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortBy = field;
                    this.sortOrder = field === 'blockNumber' || field === 'costEth' || field === 'id' ? 'desc' : 'asc';
                }
                this.loadPage(1);
            },

            searchDebounced() {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
                    this.loadPage(1);
                }, 500);
            }
        },

        // ENS Bids viewer state
        bidsView: {
            data: null,
            loading: false,
            searchTerm: '',
            sortBy: 'createdAtApi',
            sortOrder: 'desc',
            currentPage: 1,
            searchTimeout: null,
            error: null,
            bids: [],
            totalBids: 0,
            totalPages: 1,
            marketplaceFilter: 'all', // 'all', 'opensea', 'x2y2', 'blur', etc.
            statusFilter: 'all', // 'all', 'active', 'expired'

            async loadPage(page) {
                this.loading = true;
                this.currentPage = page;
                this.error = null;
                
                try {
                    const params = new URLSearchParams({
                        page: page,
                        limit: '10',
                        sortBy: this.sortBy,
                        sortOrder: this.sortOrder
                    });

                    if (this.searchTerm.trim()) {
                        params.append('search', this.searchTerm.trim());
                    }

                    if (this.marketplaceFilter !== 'all') {
                        params.append('marketplace', this.marketplaceFilter);
                    }

                    if (this.statusFilter !== 'all') {
                        params.append('status', this.statusFilter);
                    }

                    const response = await fetch(`/api/admin/bids?${params}`);
                    if (response.ok) {
                        const data = await response.json();
                        this.bids = data.bids || [];
                        this.totalBids = data.total || 0;
                        this.totalPages = Math.ceil(this.totalBids / 10);
                        
                        // ENS names and images should already be resolved and stored during bid processing
                        // No live resolution needed in frontend
                        
                        this.data = data;
                    } else {
                        const errorData = await response.json().catch(() => ({}));
                        this.error = errorData.error || `HTTP ${response.status}: Failed to load bids`;
                    }
                } catch (error) {
                    this.error = `Network error: ${error.message}`;
                }
                
                this.loading = false;
            },

            sort(field) {
                if (this.sortBy === field) {
                    this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortBy = field;
                    this.sortOrder = field === 'priceDecimal' || field === 'createdAtApi' || field === 'id' ? 'desc' : 'asc';
                }
                this.loadPage(1);
            },

            searchDebounced() {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
                    this.loadPage(1);
                }, 500);
            },

            setMarketplaceFilter(marketplace) {
                this.marketplaceFilter = marketplace;
                this.loadPage(1);
            },

            setStatusFilter(status) {
                this.statusFilter = status;
                this.loadPage(1);
            }
        },

        // Historical data population state
        historicalData: {
            targetBlock: '23100000',
            contractAddress: '',
            isRunning: false,
            lastResult: null,
            error: null
        },
        contracts: [], // Will be loaded from API

        // Helper function for relative time
        getRelativeTime(timestamp) {
            const now = new Date();
            const time = new Date(timestamp);
            const diffInSeconds = Math.floor((now - time) / 1000);

            if (diffInSeconds < 60) {
                return `${diffInSeconds} seconds ago`;
            } else if (diffInSeconds < 3600) {
                const minutes = Math.floor(diffInSeconds / 60);
                return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
            } else if (diffInSeconds < 86400) {
                const hours = Math.floor(diffInSeconds / 3600);
                return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
            } else if (diffInSeconds < 604800) {
                const days = Math.floor(diffInSeconds / 86400);
                return `${days} day${days !== 1 ? 's' : ''} ago`;
            } else {
                return time.toLocaleDateString();
            }
        },

        // Helper function for expiration time (future timestamps)
        getExpirationTime(timestamp) {
            const now = new Date();
            const time = new Date(timestamp);
            const diffInSeconds = Math.floor((time - now) / 1000);

            // If already expired (negative time)
            if (diffInSeconds < 0) {
                const expiredSeconds = Math.abs(diffInSeconds);
                if (expiredSeconds < 60) {
                    return `Expired ${expiredSeconds}s ago`;
                } else if (expiredSeconds < 3600) {
                    const minutes = Math.floor(expiredSeconds / 60);
                    return `Expired ${minutes}m ago`;
                } else if (expiredSeconds < 86400) {
                    const hours = Math.floor(expiredSeconds / 3600);
                    return `Expired ${hours}h ago`;
                } else {
                    const days = Math.floor(expiredSeconds / 86400);
                    return `Expired ${days}d ago`;
                }
            }

            // Still valid (positive time)
            if (diffInSeconds < 60) {
                return `Expires in ${diffInSeconds}s`;
            } else if (diffInSeconds < 3600) {
                const minutes = Math.floor(diffInSeconds / 60);
                return `Expires in ${minutes}m`;
            } else if (diffInSeconds < 86400) {
                const hours = Math.floor(diffInSeconds / 3600);
                return `Expires in ${hours}h`;
            } else if (diffInSeconds < 604800) {
                const days = Math.floor(diffInSeconds / 86400);
                return `Expires in ${days}d`;
            } else {
                const weeks = Math.floor(diffInSeconds / 604800);
                return `Expires in ${weeks}w`;
            }
        },

        // Initialize
        async init() {
            // Check authentication status first
            await this.checkAuthStatus();
            
            // Only load dashboard data if authenticated
            if (this.isAuthenticated) {
                await this.loadDashboardData();
            }
        },

        async checkAuthStatus() {
            this.checking = true;
            try {
                const response = await this.fetch('/api/siwe/me');
                const result = await response.json();
                
                if (result.authenticated) {
                    this.isAuthenticated = true;
                    // Ensure the stored address is checksummed
                    this.connectedAddress = this.checksumAddress(result.address);
                    this.walletConnected = true;
                }
            } catch (error) {
                console.error('Auth status check failed:', error);
                // Not authenticated, show login screen
            } finally {
                this.checking = false;
            }
        },

        async loadDashboardData() {
            await this.loadToggleStates();
            await this.loadAutoPostSettings();
            await this.loadPriceTiers();
            await this.refreshData();
            await this.loadUnpostedSales();
            await this.loadUnpostedRegistrations();
            await this.loadUnpostedBids();
            await this.loadContracts();
            await this.loadTweetHistory();
            await this.loadAIRepliesStatus();
            await this.databaseView.loadPage(1);
            await this.registrationsView.loadPage(1);
            await this.bidsView.loadPage(1);
            
            // Initialize NoUISliders after data is loaded
            this.initializeSliders();
            
            // Auto-refresh every 30 seconds
            setInterval(() => {
                if (!this.loading && !this.processing) {
                    this.refreshData();
                    this.loadTweetHistory();
                }
            }, 30000);
        },

        // Load initial toggle states from backend
        async loadToggleStates() {
            try {
                const response = await fetch('/api/admin/toggle-status');
                if (response.ok) {
                    const data = await response.json();
                    this.apiToggles.twitterEnabled = data.twitterEnabled;
                    this.apiToggles.moralisEnabled = data.moralisEnabled;
                    this.apiToggles.magicEdenEnabled = data.magicEdenEnabled;
                    this.autoPostSettings.enabled = data.autoPostingEnabled;
                }
            } catch (error) {
                console.error('Failed to load toggle states:', error);
            }
        },

        // Load contracts from API
        async loadContracts() {
            try {
                const response = await fetch('/api/contracts');
                const result = await response.json();
                if (result.success) {
                    this.contracts = result.contracts;
                } else {
                    console.error('Failed to load contracts');
                }
            } catch (error) {
                console.error('Error loading contracts:', error);
                // Fallback to known contracts if API fails (should match contracts.ts)
                this.contracts = [
                    { address: '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', name: 'ENS OG Registry' },
                    { address: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401', name: 'ENS NameWrapper' }
                ];
            }
        },

        // Refresh all data
        async refreshData() {
            this.loading = true;
            try {
                await Promise.all([
                    this.loadStats(),
                    this.loadSchedulerStatus(),
                    this.checkSystemHealth(),
                    this.loadTwitterConfig(),
                    this.loadTwitterRateLimit()
                ]);
            } catch (error) {
                console.error('Failed to refresh data:', error);
                this.systemStatus = 'error';
            } finally {
                this.loading = false;
            }
        },

        // Load statistics and recent sales
        async loadStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                
                if (data.success) {
                    this.stats = data.data;
                    this.recentSales = data.data.recentSales || [];
                } else {
                    throw new Error(data.error || 'Failed to load stats');
                }
            } catch (error) {
                console.error('Failed to load stats:', error);
                this.stats = {};
                this.recentSales = [];
            }
        },

        // Check system health
        async checkSystemHealth() {
            try {
                const response = await fetch('/health');
                const data = await response.json();
                
                if (data.status === 'healthy') {
                    this.systemStatus = 'healthy';
                } else {
                    this.systemStatus = 'warning';
                }
            } catch (error) {
                console.error('Health check failed:', error);
                this.systemStatus = 'error';
            }
        },

        // Process new sales manually
        async populateHistoricalData() {
            this.historicalData.isRunning = true;
            this.historicalData.error = null;
            this.historicalData.lastResult = null;

            try {
                const payload = {
                    targetBlock: parseInt(this.historicalData.targetBlock),
                    contractAddress: this.historicalData.contractAddress || undefined
                };

                const response = await fetch('/api/populate-historical', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (result.success) {
                    this.historicalData.lastResult = result.data;
                    // Refresh database viewer after population
                    if (this.dbViewer) {
                        await this.dbViewer.loadPage(1);
                    }
                } else {
                    this.historicalData.error = result.error || 'Failed to populate historical data';
                }
            } catch (error) {
                this.historicalData.error = error.message;
                console.error('Historical population error:', error);
            } finally {
                this.historicalData.isRunning = false;
            }
        },

        async processSales() {
            this.processing = true;
            this.lastProcessResult = null;
            
            try {
                const response = await fetch('/api/process-sales');
                const data = await response.json();
                
                this.lastProcessResult = data;
                
                if (data.success) {
                    // Refresh stats after successful processing
                    await this.loadStats();
                    
                    // Show success notification
                    this.showNotification('Sales processed successfully!', 'success');
                } else {
                    this.showNotification('Failed to process sales: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Failed to process sales:', error);
                this.lastProcessResult = {
                    success: false,
                    error: error.message
                };
                this.showNotification('Network error while processing sales', 'error');
            } finally {
                this.processing = false;
            }
        },

        // Test Moralis API connection
        async testMoralis() {
            this.testing = true;
            
            try {
                const response = await fetch('/api/test-moralis');
                const data = await response.json();
                
                if (data.success) {
                    this.showNotification('Moralis API connection successful!', 'success');
                } else {
                    this.showNotification('Moralis API connection failed: ' + data.message, 'error');
                }
            } catch (error) {
                console.error('Failed to test Moralis API:', error);
                this.showNotification('Network error while testing API', 'error');
            } finally {
                this.testing = false;
            }
        },

        // Show notification (simple implementation)
        showNotification(message, type = 'info') {
            // Create notification element
            const notification = document.createElement('div');
            notification.className = `fixed top-4 right-4 z-50 p-4 rounded-md shadow-lg max-w-sm fade-in ${
                type === 'success' ? 'bg-green-100 border border-green-400 text-green-700' :
                type === 'error' ? 'bg-red-100 border border-red-400 text-red-700' :
                'bg-blue-100 border border-blue-400 text-blue-700'
            }`;
            
            notification.innerHTML = `
                <div class="flex items-center">
                    <i class="fas ${
                        type === 'success' ? 'fa-check-circle' :
                        type === 'error' ? 'fa-exclamation-circle' :
                        'fa-info-circle'
                    } mr-2"></i>
                    <span class="text-sm font-medium">${message}</span>
                    <button onclick="this.parentElement.parentElement.remove()" class="ml-4 text-gray-400 hover:text-gray-600">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
            
            document.body.appendChild(notification);
            
            // Auto-remove after 5 seconds
            setTimeout(() => {
                if (notification.parentElement) {
                    notification.remove();
                }
            }, 5000);
        },

        // Format timestamp for display
        formatTimestamp(timestamp) {
            if (!timestamp) return 'N/A';
            return new Date(timestamp).toLocaleString();
        },

        // Format ETH amount
        formatEth(amount) {
            if (!amount) return '0.0000';
            return parseFloat(amount).toFixed(4);
        },

        // Format address for display
        formatAddress(address) {
            if (!address) return 'N/A';
            return `${address.slice(0, 6)}...${address.slice(-4)}`;
        },

        // Load scheduler status
        async loadSchedulerStatus() {
            try {
                const response = await fetch('/api/scheduler/status');
                const data = await response.json();
                
                if (data.success) {
                    this.schedulerStatus = data.data;
                } else {
                    throw new Error(data.error || 'Failed to load scheduler status');
                }
            } catch (error) {
                console.error('Failed to load scheduler status:', error);
                this.schedulerStatus = null;
            }
        },

        // Toggle scheduler on/off
        async toggleScheduler() {
            this.schedulerLoading = true;
            
            try {
                const endpoint = this.schedulerStatus?.isRunning ? '/api/scheduler/stop' : '/api/scheduler/start';
                const response = await fetch(endpoint, { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    await this.loadSchedulerStatus();
                    this.showNotification(data.message, 'success');
                } else {
                    this.showNotification('Failed to toggle scheduler: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Failed to toggle scheduler:', error);
                this.showNotification('Network error while toggling scheduler', 'error');
            } finally {
                this.schedulerLoading = false;
            }
        },

        // Reset scheduler error counter
        async resetSchedulerErrors() {
            this.schedulerLoading = true;
            
            try {
                const response = await fetch('/api/scheduler/reset-errors', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    await this.loadSchedulerStatus();
                    this.showNotification('Scheduler error counter reset', 'success');
                } else {
                    this.showNotification('Failed to reset errors: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Failed to reset scheduler errors:', error);
                this.showNotification('Network error while resetting errors', 'error');
            } finally {
                this.schedulerLoading = false;
            }
        },

        // Force stop scheduler (emergency stop)
        async forceStopScheduler() {
            if (!confirm('Are you sure you want to FORCE STOP the scheduler? This will immediately halt all automated processing.')) {
                return;
            }

            this.schedulerLoading = true;
            
            try {
                const response = await fetch('/api/scheduler/force-stop', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    await this.loadSchedulerStatus();
                    this.showNotification(data.message, 'warning');
                } else {
                    this.showNotification('Failed to force stop scheduler: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Failed to force stop scheduler:', error);
                this.showNotification('Network error while force stopping scheduler', 'error');
            } finally {
                this.schedulerLoading = false;
            }
        },

        // Twitter Methods
        async loadTwitterConfig() {
            try {
                const response = await fetch('/api/twitter/config-status');
                const data = await response.json();
                if (data.success) {
                    this.twitterConfig = data.data;
                }
            } catch (error) {
                console.error('Failed to load Twitter config:', error);
            }
        },

        async loadTwitterRateLimit() {
            try {
                const response = await fetch('/api/twitter/rate-limit-status');
                const data = await response.json();
                if (data.success) {
                    this.twitterRateLimit = data.data;
                }
            } catch (error) {
                console.error('Failed to load Twitter rate limit:', error);
            }
        },

        async sendTestTweet() {
            if (!confirm('Send a test tweet with the latest unposted sale?')) {
                return;
            }

            this.processing = true;
            this.clearTwitterMessage();

            try {
                const response = await fetch('/api/twitter/send-test-tweet', {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.success) {
                    this.showTwitterMessage(
                        `✅ Tweet posted successfully! Tweet ID: ${data.data.tweetId}`, 
                        'success'
                    );
                    // Refresh data to update counts
                    await this.refreshData();
                } else {
                    this.showTwitterMessage(
                        `❌ Failed to post tweet: ${data.error}`, 
                        'error'
                    );
                }
            } catch (error) {
                console.error('Failed to send test tweet:', error);
                this.showTwitterMessage('Network error while sending tweet', 'error');
            } finally {
                this.processing = false;
            }
        },

        async testTwitterConnection() {
            this.testing = true;
            this.clearTwitterMessage();

            try {
                const response = await fetch('/api/twitter/test');
                const data = await response.json();

                if (data.success) {
                    this.showTwitterMessage(
                        `✅ Twitter API connected! Authenticated as @${data.data.username}`, 
                        'success'
                    );
                } else {
                    this.showTwitterMessage(
                        `❌ Twitter API connection failed: ${data.error}`, 
                        'error'
                    );
                }
            } catch (error) {
                console.error('Failed to test Twitter connection:', error);
                this.showTwitterMessage('Network error while testing connection', 'error');
            } finally {
                this.testing = false;
            }
        },

        async refreshTwitterData() {
            this.loading = true;
            try {
                await Promise.all([
                    this.loadTwitterConfig(),
                    this.loadTwitterRateLimit()
                ]);
                this.showTwitterMessage('Twitter data refreshed', 'success');
            } catch (error) {
                console.error('Failed to refresh Twitter data:', error);
                this.showTwitterMessage('Failed to refresh Twitter data', 'error');
            } finally {
                this.loading = false;
            }
        },

        // Image Generation Functions
        async generateTestImage() {
            this.loading = true;
            this.clearTwitterMessage();

            try {
                const startTime = Date.now();
                const body = this.testImageToken.trim() ? { tokenPrefix: this.testImageToken.trim() } : {};
                const response = await fetch('/api/image/generate-test', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body)
                });

                const result = await response.json();
                const endTime = Date.now();

                if (response.ok) {
                    this.generatedImage = result.imageUrl;
                    this.imageData = result.mockData;
                    this.imageGenerationTime = endTime - startTime;
                    this.imageGeneratedAt = new Date().toLocaleString();
                    
                    this.showTwitterMessage(
                        `Test image generated successfully in ${this.imageGenerationTime}ms`, 
                        'success'
                    );
                } else {
                    throw new Error(result.error || 'Failed to generate image');
                }
            } catch (error) {
                console.error('Failed to generate test image:', error);
                this.showTwitterMessage(`Failed to generate test image: ${error.message}`, 'error');
            } finally {
                this.loading = false;
            }
        },

        downloadGeneratedImage() {
            if (this.generatedImage) {
                const link = document.createElement('a');
                link.href = this.generatedImage;
                link.download = `ens-sale-test-${Date.now()}.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
        },

        showTwitterMessage(message, type = 'info') {
            this.twitterMessage = message;
            this.twitterMessageType = type;
            
            // Auto-clear after 5 seconds
            setTimeout(() => {
                this.clearTwitterMessage();
            }, 5000);
        },

        clearTwitterMessage() {
            this.twitterMessage = '';
            this.twitterMessageType = 'info';
        },

        // New Tweet Generation Methods
        async loadUnpostedSales() {
            try {
                const response = await fetch('/api/unposted-sales?limit=500'); // Increased for testing
                const data = await response.json();
                
                if (data.success) {
                    this.unpostedSales = data.data;
                } else {
                    console.error('Failed to load unposted sales:', data.error);
                    this.unpostedSales = [];
                }
            } catch (error) {
                console.error('Failed to load unposted sales:', error);
                this.unpostedSales = [];
            }
        },

        async loadUnpostedRegistrations() {
            try {
                const response = await fetch('/api/unposted-registrations?limit=500'); // Increased for testing
                const data = await response.json();
                
                if (data.success) {
                    this.unpostedRegistrations = data.data;
                } else {
                    console.error('Failed to load unposted registrations:', data.error);
                    this.unpostedRegistrations = [];
                }
            } catch (error) {
                console.error('Failed to load unposted registrations:', error);
                this.unpostedRegistrations = [];
            }
        },

        async refreshUnpostedSales() {
            this.loading = true;
            try {
                await this.loadUnpostedSales();
                this.showTwitterMessage('Unposted sales refreshed', 'success');
            } catch (error) {
                console.error('Failed to refresh unposted sales:', error);
                this.showTwitterMessage('Failed to refresh sales list', 'error');
            } finally {
                this.loading = false;
            }
        },

        async refreshUnpostedRegistrations() {
            this.loading = true;
            try {
                await this.loadUnpostedRegistrations();
                this.showTwitterMessage('Unposted registrations refreshed', 'success');
            } catch (error) {
                console.error('Failed to refresh unposted registrations:', error);
                this.showTwitterMessage('Failed to refresh registrations list', 'error');
            } finally {
                this.loading = false;
            }
        },

        async loadUnpostedBids() {
            try {
                const response = await fetch('/api/unposted-bids?limit=500'); // Increased for testing
                const data = await response.json();
                
                if (data.success) {
                    this.unpostedBids = data.data;
                } else {
                    console.error('Failed to load unposted bids:', data.error);
                    this.unpostedBids = [];
                }
            } catch (error) {
                console.error('Failed to load unposted bids:', error);
                this.unpostedBids = [];
            }
        },

        async refreshUnpostedBids() {
            this.loading = true;
            try {
                await this.loadUnpostedBids();
                this.showTwitterMessage('Unposted bids refreshed', 'success');
            } catch (error) {
                console.error('Error refreshing unposted bids:', error);
                this.showTwitterMessage('Failed to refresh unposted bids', 'error');
            } finally {
                this.loading = false;
            }
        },

        clearSelection() {
            this.selectedSaleId = '';
            this.selectedRegistrationId = '';
            this.selectedBidId = '';
        },
        
        // Price Tier Management
        async loadPriceTiers() {
            try {
                const response = await fetch('/api/price-tiers');
                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.success && data.tiers) {
                        // Load tiers for each transaction type
                        ['sales', 'registrations', 'bids'].forEach(type => {
                            const typeTiers = data.tiers[type];
                            if (typeTiers && typeTiers.length >= 3) {
                                const tier1 = typeTiers.find(t => t.tierLevel === 1);
                                const tier2 = typeTiers.find(t => t.tierLevel === 2);
                                const tier3 = typeTiers.find(t => t.tierLevel === 3);
                                
                                if (tier1 && tier2 && tier3) {
                                    // Use maxUsd as the tier threshold
                                    this.priceTiers[type] = {
                                        tier1: tier1.maxUsd || 10000,
                                        tier2: tier2.maxUsd || 40000,
                                        tier3: tier3.maxUsd || 100000
                                    };
                                }
                            }
                        });
                    }
                }
            } catch (error) {
                console.error('Failed to load price tiers:', error);
            }
        },
        
        initializeSliders() {
            const self = this;
            
            // Initialize Sales Slider
            const salesSlider = document.getElementById('sales-slider');
            if (salesSlider && typeof noUiSlider !== 'undefined') {
                noUiSlider.create(salesSlider, {
                    start: [
                        this.priceTiers.sales.tier1,
                        this.priceTiers.sales.tier2,
                        this.priceTiers.sales.tier3
                    ],
                    connect: [true, true, true, true],
                    step: 500,
                    margin: 500, // Minimum $500 between handles
                    range: {
                        'min': 500,
                        'max': 200000
                    },
                    tooltips: [
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' }
                    ]
                });
                
                salesSlider.noUiSlider.on('update', function(values) {
                    self.priceTiers.sales.tier1 = Math.round(values[0]);
                    self.priceTiers.sales.tier2 = Math.round(values[1]);
                    self.priceTiers.sales.tier3 = Math.round(values[2]);
                    self.$nextTick();
                });
            }
            
            // Initialize Registrations Slider
            const registrationsSlider = document.getElementById('registrations-slider');
            if (registrationsSlider && typeof noUiSlider !== 'undefined') {
                noUiSlider.create(registrationsSlider, {
                    start: [
                        this.priceTiers.registrations.tier1,
                        this.priceTiers.registrations.tier2,
                        this.priceTiers.registrations.tier3
                    ],
                    connect: [true, true, true, true],
                    step: 500,
                    margin: 500,
                    range: {
                        'min': 500,
                        'max': 200000
                    },
                    tooltips: [
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' }
                    ]
                });
                
                registrationsSlider.noUiSlider.on('update', function(values) {
                    self.priceTiers.registrations.tier1 = Math.round(values[0]);
                    self.priceTiers.registrations.tier2 = Math.round(values[1]);
                    self.priceTiers.registrations.tier3 = Math.round(values[2]);
                    self.$nextTick();
                });
            }
            
            // Initialize Bids Slider
            const bidsSlider = document.getElementById('bids-slider');
            if (bidsSlider && typeof noUiSlider !== 'undefined') {
                noUiSlider.create(bidsSlider, {
                    start: [
                        this.priceTiers.bids.tier1,
                        this.priceTiers.bids.tier2,
                        this.priceTiers.bids.tier3
                    ],
                    connect: [true, true, true, true],
                    step: 500,
                    margin: 500,
                    range: {
                        'min': 500,
                        'max': 200000
                    },
                    tooltips: [
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' },
                        { to: (value) => '$' + (value/1000).toFixed(0) + 'k' }
                    ]
                });
                
                bidsSlider.noUiSlider.on('update', function(values) {
                    self.priceTiers.bids.tier1 = Math.round(values[0]);
                    self.priceTiers.bids.tier2 = Math.round(values[1]);
                    self.priceTiers.bids.tier3 = Math.round(values[2]);
                    self.$nextTick();
                });
            }
        },
        
        async savePriceTiers(type) {
            this.loading = true;
            try {
                const tiers = this.priceTiers[type];
                
                // Update all 4 tiers for this specific transaction type
                const updates = [
                    { level: 1, min: 0, max: tiers.tier1 },
                    { level: 2, min: tiers.tier1, max: tiers.tier2 },
                    { level: 3, min: tiers.tier2, max: tiers.tier3 },
                    { level: 4, min: tiers.tier3, max: null }
                ];
                
                // Send updates to server with transaction type
                const response = await fetch('/api/price-tiers/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        type: type,  // Include the transaction type
                        tiers: updates 
                    })
                });
                
                if (response.ok) {
                    this.showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} image tiers saved successfully!`, 'success');
                } else {
                    throw new Error('Failed to save price tiers');
                }
            } catch (error) {
                console.error('Error saving price tiers:', error);
                this.showNotification('Failed to save price tiers', 'error');
            } finally {
                this.loading = false;
            }
        },

        clearTweetPreview() {
            this.generatedTweet = null;
            this.tweetBreakdown = null;
            this.tweetImageUrl = null;
        },

        async generateTweetPost() {
            let selectedId, itemType, endpoint;
            
            if (this.tweetType === 'sale') {
                selectedId = this.selectedSaleId;
                itemType = 'sale';
                endpoint = `/api/tweet/generate/${selectedId}`;
            } else if (this.tweetType === 'registration') {
                selectedId = this.selectedRegistrationId;
                itemType = 'registration';
                endpoint = `/api/registration/tweet/generate/${selectedId}`;
            } else if (this.tweetType === 'bid') {
                selectedId = this.selectedBidId;
                itemType = 'bid';
                endpoint = `/api/bid/tweet/generate/${selectedId}`;
            }
            
            if (!selectedId) {
                this.showTwitterMessage(`Please select a ${itemType} first`, 'error');
                return;
            }

            this.tweetGenerating = true;
            this.clearTwitterMessage();
            this.clearTweetPreview();

            try {
                    
                const response = await fetch(endpoint);
                const data = await response.json();

                if (data.success) {
                    this.generatedTweet = data.data.tweet;
                    this.tweetBreakdown = data.data.breakdown;
                    this.tweetImageUrl = data.data.imageUrl;
                    
                    if (data.data.tweet.isValid) {
                        const imageMsg = data.data.hasImage ? ' with image' : '';
                        this.showTwitterMessage(`${itemType} tweet generated successfully${imageMsg}!`, 'success');
                    } else {
                        this.showTwitterMessage(`${itemType} tweet generated but has validation issues`, 'warning');
                    }
                } else {
                    this.showTwitterMessage(`Failed to generate ${itemType} tweet: ${data.error}`, 'error');
                }
            } catch (error) {
                console.error(`Failed to generate ${itemType} tweet:`, error);
                this.showTwitterMessage(`Network error while generating ${itemType} tweet`, 'error');
            } finally {
                this.tweetGenerating = false;
            }
        },

        async sendTweetPost() {
            let selectedId, itemType, endpoint;
            
            if (this.tweetType === 'sale') {
                selectedId = this.selectedSaleId;
                itemType = 'sale';
                endpoint = `/api/tweet/send/${selectedId}`;
            } else if (this.tweetType === 'registration') {
                selectedId = this.selectedRegistrationId;
                itemType = 'registration';
                endpoint = `/api/registration/tweet/send/${selectedId}`;
            } else if (this.tweetType === 'bid') {
                selectedId = this.selectedBidId;
                itemType = 'bid';
                endpoint = `/api/bid/tweet/send/${selectedId}`;
            }
            
            if (!selectedId) {
                this.showTwitterMessage(`No ${itemType} selected`, 'error');
                return;
            }

            if (!this.generatedTweet?.isValid) {
                this.showTwitterMessage('Cannot send invalid tweet', 'error');
                return;
            }

            if (!confirm(`Send this ${itemType} tweet? This will consume one API call from your daily limit.`)) {
                return;
            }

            this.tweetSending = true;
            this.clearTwitterMessage();

            try {
                    
                const response = await fetch(endpoint, {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.success) {
                    this.showTwitterMessage(
                        `✅ ${itemType} tweet posted successfully! Tweet ID: ${data.data.tweetId}`, 
                        'success'
                    );
                    
                    // Clear the preview and refresh data
                    this.clearTweetPreview();
                    this.clearSelection();
                    await Promise.all([
                        this.refreshData(),
                        this.tweetType === 'sale' ? this.loadUnpostedSales() : 
                        this.tweetType === 'registration' ? this.loadUnpostedRegistrations() :
                        this.loadUnpostedBids()
                    ]);
                } else {
                    this.showTwitterMessage(
                        `❌ Failed to post ${itemType} tweet: ${data.error}`, 
                        'error'
                    );
                }
            } catch (error) {
                console.error(`Failed to send ${itemType} tweet:`, error);
                this.showTwitterMessage(`Network error while sending ${itemType} tweet`, 'error');
            } finally {
                this.tweetSending = false;
            }
        },

        // Database Management Methods
        async resetToRecentBlocks() {
            if (!confirm('Reset processing to start from recent blocks?\n\nThis will:\n• Clear the last processed block position\n• Keep existing sales data\n• Start fetching recent sales on next sync\n\nRecommended if stuck on old blocks.')) {
                return;
            }
            
            this.processingReset = true;
            this.clearDatabaseResetMessage();
            
            try {
                const response = await fetch('/api/processing/reset-to-recent', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    this.showDatabaseResetMessage(`✅ Processing reset successful! Found ${result.stats?.fetched || 0} sales, ${result.stats?.newSales || 0} new.`, 'success');
                    await this.refreshData();
                } else {
                    this.showDatabaseResetMessage(`❌ Reset failed: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showDatabaseResetMessage(`❌ Reset failed: ${error.message}`, 'error');
            } finally {
                this.processingReset = false;
            }
        },

        async confirmDatabaseReset() {
            const finalConfirm = prompt(
                '⚠️ WARNING: This will permanently delete ALL data!\n\n' +
                '• All sales records will be lost\n' +
                '• All tweet history will be deleted\n' +
                '• Last processed block will be reset\n' +
                '• System will re-fetch historical data on next sync\n\n' +
                'This action cannot be undone.\n\n' +
                'Type "DELETE" to confirm:'
            );
            
            if (finalConfirm === 'DELETE') {
                await this.resetDatabase();
            } else {
                this.showDatabaseResetMessage('Database reset cancelled.', 'info');
            }
        },

        async resetDatabase() {
            this.databaseResetting = true;
            this.clearDatabaseResetMessage();
            
            try {
                const response = await fetch('/api/database/reset', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    this.showDatabaseResetMessage(
                        '✅ Database reset successful! All data has been cleared and the system is ready for fresh data ingestion.',
                        'success'
                    );
                    
                    // Refresh the dashboard to show empty state
                    await this.refreshData();
                } else {
                    this.showDatabaseResetMessage(
                        `❌ Database reset failed: ${result.error}`,
                        'error'
                    );
                }
            } catch (error) {
                console.error('Database reset error:', error);
                this.showDatabaseResetMessage(
                    `❌ Database reset failed: ${error.message}`,
                    'error'
                );
            } finally {
                this.databaseResetting = false;
            }
        },

        async confirmClearSales() {
            const confirmation = confirm(
                '⚠️ Clear Sales Table\n\n' +
                'This will permanently delete:\n' +
                '• All sales records\n' +
                '• Sales will restart from ID 1\n\n' +
                'This will NOT delete:\n' +
                '• Tweet history\n' +
                '• Settings and configurations\n' +
                '• API toggle states\n\n' +
                'Are you sure you want to clear all sales data?'
            );
            
            if (confirmation) {
                await this.clearSalesTable();
            }
        },

        async clearSalesTable() {
            this.salesClearing = true;
            this.clearDatabaseResetMessage();
            
            try {
                const response = await fetch('/api/database/clear-sales', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const result = await response.json();
                
                if (result.success) {
                    this.showDatabaseResetMessage('Sales table cleared successfully! Ready for fresh sales data.', 'success');
                    // Refresh stats to show empty sales
                    await this.refreshData();
                } else {
                    this.showDatabaseResetMessage(`Failed to clear sales table: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showDatabaseResetMessage(`Error clearing sales table: ${error.message}`, 'error');
            } finally {
                this.salesClearing = false;
            }
        },

        showDatabaseResetMessage(message, type) {
            this.databaseResetMessage = message;
            this.databaseResetMessageType = type;
            
            // Auto-clear success messages after 10 seconds
            if (type === 'success') {
                setTimeout(() => {
                    this.clearDatabaseResetMessage();
                }, 10000);
            }
        },

        clearDatabaseResetMessage() {
            this.databaseResetMessage = '';
            this.databaseResetMessageType = 'info';
        },

        // Time calculation function
        getTimeAgo(timestamp) {
            if (!timestamp) return 'Unknown';
            
            const now = new Date();
            const created = new Date(timestamp);
            const diffMs = now - created;
            
            const diffMinutes = Math.floor(diffMs / (1000 * 60));
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            
            if (diffMinutes < 60) {
                return diffMinutes === 0 ? 'Just now' : `${diffMinutes}m ago`;
            } else if (diffHours < 24) {
                return `${diffHours}h ago`;
            } else if (diffDays < 30) {
                return `${diffDays}d ago`;
            } else {
                const diffMonths = Math.floor(diffDays / 30);
                return `${diffMonths}mo ago`;
            }
        },

        // Modal functions
        openSaleModal(sale) {
            this.selectedSale = sale;
        },

        closeSaleModal() {
            this.selectedSale = null;
        },

        // Master API Toggle Functions
        async toggleTwitterAPI() {
            try {
                this.loading = true;
                const response = await fetch('/api/admin/toggle-twitter', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !this.apiToggles.twitterEnabled })
                });
                
                if (response.ok) {
                    this.apiToggles.twitterEnabled = !this.apiToggles.twitterEnabled;
                    
                    // Disable auto-posting if Twitter API is disabled
                    if (!this.apiToggles.twitterEnabled && this.autoPostSettings.enabled) {
                        this.autoPostSettings.enabled = false;
                    }
                    
                    this.showMessage(
                        `Twitter API ${this.apiToggles.twitterEnabled ? 'enabled' : 'disabled'}`,
                        'success'
                    );
                } else {
                    throw new Error('Failed to toggle Twitter API');
                }
            } catch (error) {
                console.error('Toggle Twitter API error:', error);
                this.showMessage('Failed to toggle Twitter API', 'error');
            } finally {
                this.loading = false;
            }
        },

        async toggleMoralisAPI() {
            try {
                this.loading = true;
                const response = await fetch('/api/admin/toggle-moralis', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !this.apiToggles.moralisEnabled })
                });
                
                if (response.ok) {
                    this.apiToggles.moralisEnabled = !this.apiToggles.moralisEnabled;
                    this.showMessage(
                        `Moralis API ${this.apiToggles.moralisEnabled ? 'enabled' : 'disabled'}`,
                        'success'
                    );
                } else {
                    throw new Error('Failed to toggle Moralis API');
                }
            } catch (error) {
                console.error('Toggle Moralis API error:', error);
                this.showMessage('Failed to toggle Moralis API', 'error');
            } finally {
                this.loading = false;
            }
        },

        async toggleMagicEdenAPI() {
            try {
                this.loading = true;
                const response = await fetch('/api/admin/toggle-magic-eden', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !this.apiToggles.magicEdenEnabled })
                });
                
                if (response.ok) {
                    this.apiToggles.magicEdenEnabled = !this.apiToggles.magicEdenEnabled;
                    this.showMessage(
                        `Magic Eden API ${this.apiToggles.magicEdenEnabled ? 'enabled' : 'disabled'}`,
                        'success'
                    );
                } else {
                    throw new Error('Failed to toggle Magic Eden API');
                }
            } catch (error) {
                console.error('Toggle Magic Eden API error:', error);
                this.showMessage('Failed to toggle Magic Eden API', 'error');
            } finally {
                this.loading = false;
            }
        },

        async toggleAutoPosting() {
            try {
                this.loading = true;
                const newState = !this.autoPostSettings.enabled;
                
                const response = await fetch('/api/admin/toggle-auto-posting', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: newState })
                });
                
                if (response.ok) {
                    this.autoPostSettings.enabled = newState;
                    this.showMessage(
                        `Auto-posting ${newState ? 'enabled' : 'disabled'}`,
                        'success'
                    );
                } else {
                    throw new Error('Failed to toggle auto-posting');
                }
            } catch (error) {
                console.error('Toggle auto-posting error:', error);
                this.showMessage('Failed to toggle auto-posting', 'error');
            } finally {
                this.loading = false;
            }
        },

        // Load tweet history
        async loadTweetHistory() {
            try {
                const response = await fetch('/api/twitter/history');
                if (response.ok) {
                    const data = await response.json();
                    this.tweetHistory = data.success ? data.data.tweets : [];
                }
            } catch (error) {
                console.error('Failed to load tweet history:', error);
                this.tweetHistory = [];
            }
        },

        // Load auto-post settings from backend
        async loadAutoPostSettings() {
            try {
                console.log('Loading auto-post settings...');
                const response = await fetch('/api/admin/autopost-settings');
                if (response.ok) {
                    const data = await response.json();
                    console.log('Loaded settings response:', data);
                    if (data.success) {
                        // Update transaction-specific settings
                        this.autoPostSettings = {
                            ...this.autoPostSettings,
                            sales: data.settings.sales,
                            registrations: data.settings.registrations,
                            bids: data.settings.bids
                        };
                        console.log('Updated autoPostSettings:', this.autoPostSettings);
                    }
                } else {
                    console.error('Failed to load settings, status:', response.status);
                }
            } catch (error) {
                console.error('Failed to load auto-post settings:', error);
            }
        },

        // Save transaction-specific auto-post settings to backend
        async saveTransactionAutoPostSettings(transactionType) {
            try {
                console.log(`Saving ${transactionType} auto-post settings:`, this.autoPostSettings[transactionType]);
                
                const response = await fetch('/api/admin/autopost-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transactionType: transactionType,
                        settings: this.autoPostSettings[transactionType]
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    console.log(`${transactionType} auto-post settings saved successfully:`, result);
                    this.showMessage(`${transactionType.charAt(0).toUpperCase() + transactionType.slice(1)} settings saved!`, 'success');
                } else {
                    const error = await response.text();
                    console.error(`Failed to save ${transactionType} auto-post settings:`, error);
                    this.showMessage(`Failed to save ${transactionType} settings`, 'error');
                }
            } catch (error) {
                console.error(`Error saving ${transactionType} auto-post settings:`, error);
                this.showMessage(`Error saving ${transactionType} settings`, 'error');
            }
        },

        // Toggle individual transaction type auto-posting
        async toggleTransactionAutoPost(transactionType) {
            try {
                this.loading = true;
                const currentState = this.autoPostSettings[transactionType].enabled;
                const newState = !currentState;
                
                // Update local state
                this.autoPostSettings[transactionType].enabled = newState;
                
                // Save to backend
                await this.saveTransactionAutoPostSettings(transactionType);
                
                this.showMessage(
                    `${transactionType.charAt(0).toUpperCase() + transactionType.slice(1)} auto-posting ${newState ? 'enabled' : 'disabled'}`,
                    'success'
                );
            } catch (error) {
                // Revert on error
                this.autoPostSettings[transactionType].enabled = !this.autoPostSettings[transactionType].enabled;
                console.error(`Toggle ${transactionType} auto-posting error:`, error);
                this.showMessage(`Failed to toggle ${transactionType} auto-posting`, 'error');
            } finally {
                this.loading = false;
            }
        },





        // Select bid for modal display
        selectBid(bid) {
            this.selectedBid = bid;
        },

        // Helper function to show messages
        showMessage(text, type = 'info') {
            // You can implement this to show notifications
            console.log(`${type.toUpperCase()}: ${text}`);
        },

        // SIWE Authentication Methods

        // Helper function for checksumming addresses (fallback if ethers not available)
        checksumAddress(address) {
            if (typeof ethers !== 'undefined') {
                return ethers.utils.getAddress(address);
            }
            // Simple fallback - just ensure it starts with 0x and is 42 chars
            if (address && address.length === 42 && address.startsWith('0x')) {
                return address;
            }
            throw new Error('Invalid address format');
        },

        async connectWallet() {
            if (!window.ethereum) {
                this.authError = 'Please install MetaMask or another Web3 wallet to continue';
                return;
            }

            this.connecting = true;
            this.authError = '';

            try {
                // Request account access
                const accounts = await window.ethereum.request({
                    method: 'eth_requestAccounts'
                });

                if (accounts.length > 0) {
                    // Store checksummed address immediately
                    this.connectedAddress = this.checksumAddress(accounts[0]);
                    this.walletConnected = true;
                } else {
                    this.authError = 'No wallet accounts found';
                }
            } catch (error) {
                this.authError = 'Failed to connect wallet: ' + (error.message || 'Unknown error');
                console.error('Wallet connection failed:', error);
            } finally {
                this.connecting = false;
            }
        },

        async signIn() {
            this.signing = true;
            this.authError = '';

            try {
                // Step 1: Get nonce from backend
                const nonceResponse = await fetch('/api/siwe/nonce', {
                    credentials: 'include' // CRITICAL for cookies to work with CORS
                });
                if (!nonceResponse.ok) {
                    throw new Error('Failed to get nonce from server');
                }
                const { nonce } = await nonceResponse.json();

                // Step 2: Ensure address is properly checksummed (EIP-55)
                const checksumAddress = this.checksumAddress(this.connectedAddress);

                // Step 3: Create SIWE message with strict EIP-4361 format
                const domain = window.location.hostname;
                const issuedAt = new Date().toISOString();
                
                const message = `${domain} wants you to sign in with your Ethereum account:
${checksumAddress}

Sign in

URI: ${window.location.origin}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${issuedAt}`;

                // Convert message from utf8 to hex
                const encoder = new TextEncoder();
                const bytes = encoder.encode(message);
                const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                const msg = `0x${hex}`;

                // Step 4: Sign the message
                const signature = await window.ethereum.request({
                    method: 'personal_sign',
                    params: [msg, checksumAddress]
                });

                // Step 5: Verify signature with backend
                const loginResponse = await fetch('/api/siwe/verify', {
                    method: 'POST',
                    credentials: 'include', // CRITICAL for cookies to work with CORS
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ message, signature })
                });

                const result = await loginResponse.json();

                if (result.success) {
                    this.isAuthenticated = true;
                    this.connectedAddress = checksumAddress; // Use checksummed address for display
                    this.authError = '';
                    
                    // Load dashboard data now that we're authenticated
                    await this.loadDashboardData();
                } else {
                    this.authError = result.error || 'Authentication failed';
                }

            } catch (error) {
                if (error.code === 4001) {
                    this.authError = 'You rejected the signature request';
                } else if (error.message.includes('User denied')) {
                    this.authError = 'Signature was cancelled';
                } else {
                    this.authError = 'Failed to sign in: ' + (error.message || 'Unknown error');
                }
                console.error('Sign in failed:', error);
            } finally {
                this.signing = false;
            }
        },

        async logout() {
            try {
                await fetch('/api/siwe/logout', { 
                    method: 'POST',
                    credentials: 'include' // Required for cookies with CORS
                });
                
                // Reset authentication state
                this.isAuthenticated = false;
                this.walletConnected = false;
                this.connectedAddress = null;
                this.authError = '';
                
                // Reload page to reset dashboard state
                window.location.reload();
            } catch (error) {
                console.error('Logout failed:', error);
            }
        },

        // ===== AI Replies Functions =====

        async loadAIRepliesStatus() {
            try {
                const statusResponse = await this.fetch('/api/admin/ai-replies-status');
                if (statusResponse.ok) {
                    const data = await statusResponse.json();
                    this.aiRepliesEnabled = data.enabled || false;
                    this.openaiConfigured = data.openaiConfigured || false;
                    this.aiRepliesGenerated = data.generatedCount || 0;
                }
            } catch (error) {
                console.error('Failed to load AI replies status:', error);
            }
        },

        async toggleAIReplies() {
            try {
                this.loading = true;
                const newState = !this.aiRepliesEnabled;

                const response = await this.fetch('/api/admin/toggle-ai-replies', {
                    method: 'POST',
                    body: JSON.stringify({ enabled: newState })
                });

                if (response.ok) {
                    this.aiRepliesEnabled = newState;
                    this.showAIReplyMessage(
                        `AI Replies ${newState ? 'enabled' : 'disabled'} successfully`,
                        'success'
                    );
                } else {
                    const data = await response.json();
                    this.showAIReplyMessage(data.error || 'Failed to toggle AI replies', 'error');
                }
            } catch (error) {
                console.error('Toggle AI replies failed:', error);
                this.showAIReplyMessage(error.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        async refreshPostedTransactions() {
            try {
                this.loading = true;

                // Load posted sales (those with tweet_id)
                const salesResponse = await this.fetch('/api/unposted-sales?limit=100');
                if (salesResponse.ok) {
                    const salesData = await salesResponse.json();
                    this.postedSales = salesData.data.filter(sale => sale.tweetId);
                }

                // Load posted registrations (those with tweet_id)
                const regsResponse = await this.fetch('/api/unposted-registrations?limit=100');
                if (regsResponse.ok) {
                    const regsData = await regsResponse.json();
                    this.postedRegistrations = regsData.data.filter(reg => reg.tweetId);
                }
            } catch (error) {
                console.error('Failed to refresh posted transactions:', error);
            } finally {
                this.loading = false;
            }
        },

        clearAIReply() {
            this.generatedAIReply = null;
            this.aiReplyMessage = '';
        },

        async generateAIReply() {
            if (!this.aiReplyTransactionId) {
                this.showAIReplyMessage('Please select a transaction', 'error');
                return;
            }

            if (!this.aiRepliesEnabled) {
                this.showAIReplyMessage('AI Replies are disabled. Please enable them first.', 'error');
                return;
            }

            try {
                this.aiReplyGenerating = true;
                this.clearAIReply();

                const response = await this.fetch('/api/ai-reply-generate', {
                    method: 'POST',
                    body: JSON.stringify({
                        type: this.aiReplyType,
                        id: parseInt(this.aiReplyTransactionId)
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    this.generatedAIReply = data.reply;
                    this.showAIReplyMessage(
                        data.message || 'AI reply generated successfully',
                        'success'
                    );
                } else {
                    const data = await response.json();
                    this.showAIReplyMessage(
                        data.error || 'Failed to generate AI reply',
                        'error'
                    );
                }
            } catch (error) {
                console.error('Generate AI reply failed:', error);
                this.showAIReplyMessage(error.message, 'error');
            } finally {
                this.aiReplyGenerating = false;
            }
        },

        async sendAIReplyPost() {
            if (!this.generatedAIReply) {
                this.showAIReplyMessage('No AI reply to send', 'error');
                return;
            }

            try {
                this.aiReplySending = true;

                // Post reply to Twitter
                // This endpoint doesn't exist yet - placeholder
                const response = await this.fetch('/api/ai-reply-post', {
                    method: 'POST',
                    body: JSON.stringify({
                        replyId: this.generatedAIReply.id
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    this.showAIReplyMessage(
                        'AI reply posted successfully!',
                        'success'
                    );
                    
                    // Clear the generated reply after posting
                    setTimeout(() => {
                        this.clearAIReply();
                        this.aiReplyTransactionId = '';
                    }, 2000);
                } else {
                    const data = await response.json();
                    this.showAIReplyMessage(
                        data.error || 'Failed to post AI reply',
                        'error'
                    );
                }
            } catch (error) {
                console.error('Send AI reply failed:', error);
                this.showAIReplyMessage(error.message, 'error');
            } finally {
                this.aiReplySending = false;
            }
        },

        showAIReplyMessage(message, type = 'info') {
            this.aiReplyMessage = message;
            this.aiReplyMessageType = type;
            
            // Auto-hide message after 5 seconds
            setTimeout(() => {
                this.aiReplyMessage = '';
            }, 5000);
        }
    };
}
