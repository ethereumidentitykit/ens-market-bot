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

        // Initialize
        async init() {
            await this.refreshData();
            // Auto-refresh every 30 seconds
            setInterval(() => {
                if (!this.loading && !this.processing) {
                    this.refreshData();
                }
            }, 30000);
        },

        // Refresh all data
        async refreshData() {
            this.loading = true;
            try {
                await Promise.all([
                    this.loadStats(),
                    this.loadSchedulerStatus(),
                    this.checkSystemHealth()
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

        // Test Alchemy API connection
        async testAlchemy() {
            this.testing = true;
            
            try {
                const response = await fetch('/api/test-alchemy');
                const data = await response.json();
                
                if (data.success) {
                    this.showNotification('Alchemy API connection successful!', 'success');
                } else {
                    this.showNotification('Alchemy API connection failed: ' + data.message, 'error');
                }
            } catch (error) {
                console.error('Failed to test Alchemy API:', error);
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
        }
    };
}
