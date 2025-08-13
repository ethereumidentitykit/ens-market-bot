// Dashboard JavaScript using Alpine.js
function dashboard() {
    return {
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
        unpostedSales: [],
        selectedSaleId: '',
        generatedTweet: null,
        tweetBreakdown: null,
        tweetImageUrl: null,
        tweetGenerating: false,
        tweetSending: false,

        // Database management state
        databaseResetting: false,
        databaseResetMessage: '',
        databaseResetMessageType: 'info',
        processingReset: false,

        // Database viewer state
        // Historical data population state
        historicalData: {
            targetBlock: '23100000',
            contractAddress: '',
            isRunning: false,
            lastResult: null,
            error: null
        },
        contracts: [], // Will be loaded from API

        dbViewer: {
            data: null,
            loading: false,
            searchTerm: '',
            sortBy: 'blockNumber',
            sortOrder: 'desc',
            limit: 50,
            currentPage: 1,
            searchTimeout: null,

            async loadPage(page) {
                this.loading = true;
                this.currentPage = page;
                
                try {
                    const params = new URLSearchParams({
                        page: page.toString(),
                        limit: this.limit.toString(),
                        sortBy: this.sortBy,
                        sortOrder: this.sortOrder
                    });

                    if (this.searchTerm.trim()) {
                        params.append('search', this.searchTerm.trim());
                    }

                    const response = await fetch(`/api/database/sales?${params}`);
                    const result = await response.json();

                    if (result.success) {
                        this.data = result.data;
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

            getPageNumbers() {
                if (!this.data?.pagination) return [];
                
                const current = this.data.pagination.page;
                const total = this.data.pagination.totalPages;
                const range = 2; // Show 2 pages on each side of current
                
                let start = Math.max(1, current - range);
                let end = Math.min(total, current + range);
                
                // Adjust range if we're near the beginning or end
                if (current <= range) {
                    end = Math.min(total, 2 * range + 1);
                } else if (current > total - range) {
                    start = Math.max(1, total - 2 * range);
                }
                
                const pages = [];
                for (let i = start; i <= end; i++) {
                    pages.push(i);
                }
                
                return pages;
            }
        },

        // Initialize
        async init() {
            await this.refreshData();
            await this.loadUnpostedSales();
            await this.loadContracts();
            await this.dbViewer.loadPage(1);
            // Auto-refresh every 30 seconds
            setInterval(() => {
                if (!this.loading && !this.processing) {
                    this.refreshData();
                }
            }, 30000);
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
                const response = await fetch('/api/unposted-sales?limit=20');
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

        clearTweetPreview() {
            this.generatedTweet = null;
            this.tweetBreakdown = null;
            this.tweetImageUrl = null;
        },

        async generateTweetPost() {
            if (!this.selectedSaleId) {
                this.showTwitterMessage('Please select a sale first', 'error');
                return;
            }

            this.tweetGenerating = true;
            this.clearTwitterMessage();
            this.clearTweetPreview();

            try {
                const response = await fetch(`/api/tweet/generate/${this.selectedSaleId}`);
                const data = await response.json();

                if (data.success) {
                    this.generatedTweet = data.data.tweet;
                    this.tweetBreakdown = data.data.breakdown;
                    this.tweetImageUrl = data.data.imageUrl;
                    
                    if (data.data.tweet.isValid) {
                        const imageMsg = data.data.hasImage ? ' with image' : '';
                        this.showTwitterMessage(`Tweet generated successfully${imageMsg}!`, 'success');
                    } else {
                        this.showTwitterMessage('Tweet generated but has validation issues', 'warning');
                    }
                } else {
                    this.showTwitterMessage(`Failed to generate tweet: ${data.error}`, 'error');
                }
            } catch (error) {
                console.error('Failed to generate tweet:', error);
                this.showTwitterMessage('Network error while generating tweet', 'error');
            } finally {
                this.tweetGenerating = false;
            }
        },

        async sendTweetPost() {
            if (!this.selectedSaleId) {
                this.showTwitterMessage('No sale selected', 'error');
                return;
            }

            if (!this.generatedTweet?.isValid) {
                this.showTwitterMessage('Cannot send invalid tweet', 'error');
                return;
            }

            if (!confirm('Send this tweet? This will consume one API call from your daily limit.')) {
                return;
            }

            this.tweetSending = true;
            this.clearTwitterMessage();

            try {
                const response = await fetch(`/api/tweet/send/${this.selectedSaleId}`, {
                    method: 'POST'
                });
                const data = await response.json();

                if (data.success) {
                    this.showTwitterMessage(
                        `✅ Tweet posted successfully! Tweet ID: ${data.data.tweetId}`, 
                        'success'
                    );
                    
                    // Clear the preview and refresh data
                    this.clearTweetPreview();
                    this.selectedSaleId = '';
                    await Promise.all([
                        this.refreshData(),
                        this.loadUnpostedSales()
                    ]);
                } else {
                    this.showTwitterMessage(
                        `❌ Failed to post tweet: ${data.error}`, 
                        'error'
                    );
                }
            } catch (error) {
                console.error('Failed to send tweet:', error);
                this.showTwitterMessage('Network error while sending tweet', 'error');
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
            const confirmation = confirm(
                '⚠️ WARNING: This will permanently delete ALL data!\n\n' +
                '• All sales records will be lost\n' +
                '• All tweet history will be deleted\n' +
                '• Last processed block will be reset\n' +
                '• System will re-fetch historical data on next sync\n\n' +
                'This action cannot be undone. Are you absolutely sure?'
            );
            
            if (confirmation) {
                const doubleConfirmation = confirm(
                    '🚨 FINAL CONFIRMATION\n\n' +
                    'Type "DELETE" in the next prompt to confirm database reset.'
                );
                
                if (doubleConfirmation) {
                    const finalConfirm = prompt('Type "DELETE" to confirm:');
                    if (finalConfirm === 'DELETE') {
                        await this.resetDatabase();
                    } else {
                        this.showDatabaseResetMessage('Database reset cancelled.', 'info');
                    }
                } else {
                    this.showDatabaseResetMessage('Database reset cancelled.', 'info');
                }
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
        }
    };
}
