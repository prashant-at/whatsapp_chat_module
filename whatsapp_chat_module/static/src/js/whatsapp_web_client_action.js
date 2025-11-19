/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import socketService from "./socket_service";

/**
 * WhatsApp Web Client Action
 * This component renders the WhatsApp Web interface template
 */
export class WhatsAppWebClientAction extends Component {
    static template = "whatsapp_chat_module.whatsapp_web_template";
    
    setup() {
        super.setup();
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.rpc = useService("rpc");
        this.userService = useService("user");
        
        // Backend API configuration
        this.backendApiUrl = 'http://localhost:3000';
        this.apiKey = null;
        this.phoneNumber = null;
        
        // Use useState for reactive state
        this.state = useState({
            showConnectionSelector: false,
            showQRModal: false, // Control QR modal visibility separately
            // Staging: 'boot' | 'qr' | 'ready'
            stage: 'boot',
            qrImage: null,
            banner: '',
            error: '',
            needsAuth: false,
            canSendMessages: false,
            connections: [],
            selectedConnection: null,
            conversations: [], // All loaded conversations
            filteredConversations: [], // Filtered by search term (initialized to empty array)
            selectedConversation: null,
            messages: [],
            searchTerm: "",
            messageInput: "",
            isLoading: false,
            switchingConnection: false,
            showEmojiPanel: false,
            // Contacts popup state
            showContactsPopup: false,
            contacts: [],
            contactsSearchTerm: "",
            isLoadingContacts: false,
            // Pagination state
            pagination: {
                pageIndex: 1,
                pageSize: 50,
                hasMore: true,
                isLoadingMore: false,
            },
            // Messages pagination per selected conversation
            messagePagination: {
                pageIndex: 1,
                pageSize: 50,
                hasMore: true,
                isLoadingMore: false,
            },
            isLoadingMessages: false,
            // Media sending state
            selectedMedia: null, // {file: File, type: string, preview: string}
            mediaUploading: false,
        });
        // Timestamp for debouncing message refetch
        this._lastMessagesFetchTs = 0;
        
        // Lookup maps for efficient de-duplication (Option B)
        this._conversationMap = new Map(); // Key: chatId (conversation_id), Value: index in conversations array
        this._messageIdSet = new Set(); // Set of message IDs for currently open conversation
        
        // Scroll handler debounce
        this._scrollDebounceTimer = null;
        this._creatingLeadMessageId = null;
        

        // Subscribe to socket events to update UI state
        this._unsubscribe = [];
        this._unsubscribe.push(
            socketService.on('status', (data) => {
                const type = data?.type || data?.status;
                this.state.connectionStatus = type || 'unknown';
                if (type === 'authenticated') {
                    this.state.banner = 'Authenticated, preparing…';
                } else if (type === 'ready') {
                    this.state.banner = '';
                    this.state.stage = 'ready';
                    this.state.qrImage = null;
                    this.state.showQRModal = false; // Hide QR modal when ready
                    this.state.canSendMessages = true;
                    // Update connection statuses when ready
                    this.updateConnectionStatuses();
                    // Fetch chats on first ready if not loaded yet
                    if (!this._initialChatsLoaded) {
                        this._initialChatsLoaded = true;
                        this.loadConversations(true);
                    }
                } else if (type === 'disconnected') {
                    this.state.canSendMessages = false;
                    this.state.banner = 'Disconnected. Please re-scan.';
                    this.state.stage = this.state.stage === 'ready' ? 'qr' : this.state.stage;
                    this.state.showQRModal = true; // Show QR modal when disconnected
                    // Update connection statuses when disconnected
                    this.updateConnectionStatuses();
                } else if (type === 'qr_code_mismatch') {
                    this.state.error = data?.message || 'QR code mismatch. Please try again.';
                    this.state.stage = 'qr';
                    this.state.showQRModal = true; // Show QR modal popup
                } else if (type === 'auth_failure') {
                    this.state.error = data?.message || 'Authentication failed';
                    this.state.needsAuth = true;
                }
            })
        );
        // Subscribe to socket connect/disconnect events to update connection statuses
        this._unsubscribe.push(
            socketService.on('connect', () => {
                this.updateConnectionStatuses();
            })
        );
        this._unsubscribe.push(
            socketService.on('disconnect', () => {
                this.updateConnectionStatuses();
            })
        );
        this._unsubscribe.push(
            socketService.on('chat', (chatData) => {
                // Handle real-time chat updates from backend
                this.handleChatUpdate(chatData);
            })
        );
        this._unsubscribe.push(
            socketService.on('qr_code', (data) => {
                // data may be base64 or object with qrCode
                const img = typeof data === 'string' ? data : (data?.qrCode || '');
                if (img) {
                    this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
                }
                this.state.stage = 'qr';
                this.state.showQRModal = true; // Show QR modal popup
            })
        );
        this._unsubscribe.push(
            socketService.on('phone_mismatch', (data) => {
                const img = data?.qrCode || '';
                if (img) {
                    this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
                }
                this.state.error = data?.message || 'Phone mismatch. Please scan with the correct number.';
                this.state.stage = 'qr';
                this.state.showQRModal = true; // Show QR modal popup
            })
        );
        this._unsubscribe.push(
            socketService.on('message', (msg) => {
                // Append message to state if it doesn't already exist (Option B)
                this.handleMessageEvent(msg);
            })
        );
        this.loadData();
    }

    mounted() {
        // Attach scroll listener after a short delay to ensure container is rendered
        setTimeout(() => {
            this._attachScrollListener();
        }, 100);
    }
    
    _attachScrollListener() {
        // Remove existing listener if any
        if (this._onMessagesScroll && this._messagesContainer) {
            this._messagesContainer.removeEventListener('scroll', this._onMessagesScroll);
        }
        
        // Get container (try refs first, then fallback to querySelector)
        const container = this.refs?.messagesContainer || 
                         document.querySelector('.messages-container');
        
        if (!container) {
            return;
        }
        
        this._messagesContainer = container;
        
        this._onMessagesScroll = () => {
            // Debounce scroll events to prevent rapid firing
            if (this._scrollDebounceTimer) {
                clearTimeout(this._scrollDebounceTimer);
            }
            
            this._scrollDebounceTimer = setTimeout(() => {
                // Use threshold instead of exact 0 for better detection
                const scrollThreshold = 50; // Trigger when within 50px of top
                const isNearTop = container.scrollTop <= scrollThreshold;
                const hasScrollableContent = container.scrollHeight > container.clientHeight;
                const canLoadMore = !this.state.messagePagination.isLoadingMore && 
                                   this.state.messagePagination.hasMore;
                
                if (isNearTop && hasScrollableContent && canLoadMore) {
                    // Scroll threshold reached; load more messages
                    this.loadMoreMessages();
                }
            }, 100); // Debounce for 100ms
        };
        
        container.addEventListener('scroll', this._onMessagesScroll, { passive: true });
    }

    willUnmount() {
        // Cleanup scroll listener and socket subscriptions
        if (this._scrollDebounceTimer) {
            clearTimeout(this._scrollDebounceTimer);
            this._scrollDebounceTimer = null;
        }
        if (this._messagesContainer && this._onMessagesScroll) {
            this._messagesContainer.removeEventListener('scroll', this._onMessagesScroll);
            this._onMessagesScroll = null;
            this._messagesContainer = null;
        }
        if (Array.isArray(this._unsubscribe)) {
            for (const off of this._unsubscribe) {
                try { typeof off === 'function' && off(); } catch (e) {}
            }
            this._unsubscribe = [];
        }
    }

    // Wait for 'ready' status with a timeout; resolves boolean
    waitForReadyStatus(timeoutMs = 30000) {
        return new Promise((resolve) => {
            let resolved = false;
            const to = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
            }, timeoutMs);

            // If already ready
            if (this.state.connectionStatus === 'ready' || this.state.stage === 'ready') {
                clearTimeout(to);
                resolved = true;
                resolve(true);
                return;
            }

            const off = socketService.on('status', ({ type, status }) => {
                const t = type || status;
                if (!resolved && t === 'ready') {
                    clearTimeout(to);
                    resolved = true;
                    off && off();
                    resolve(true);
                }
            });
        });
    }

    // Trigger QR code flow via REST: POST /api/whatsapp/qr
    async triggerQRCodeFlow() {
        if (!this.apiKey || !this.phoneNumber) return;
        const headers = {
            'x-api-key': this.apiKey.trim(),
            // 'x-phone-number': "+91 9157000128",
            'x-phone-number': this.phoneNumber.trim(),
            // 'x-system-ip': '127.0.0.1',
            'Content-Type': 'application/json'
        };

        const url = `${this.backendApiUrl}/api/whatsapp/qr`;

        const response = await fetch(url, { method: 'POST', headers });
        let result;
        try {
            result = await response.json();
        } catch (e) {
            result = { success: false, message: 'Non-JSON response from QR endpoint' };
        }

        if (response.status === 200) {
            // Already connected and ready
            this.state.banner = '';
            this.state.stage = 'ready';
            this.state.connectionStatus = 'ready';
            this.state.qrImage = null;
            return true;
        }
        if (response.status === 201) {
            // Flow started; wait for qr_code socket event
            this.state.banner = '';
            this.state.stage = 'qr';
            this.state.showQRModal = true; // Show QR modal popup
            return false;
        }
        // Other validation/auth/network errors
        if (response.status === 400) {
            this.state.error = result?.message || 'Validation error starting QR flow';
        } else if (response.status === 401 || response.status === 403) {
            this.state.needsAuth = true;
            this.state.error = result?.message || 'Authentication required to start QR flow';
        }
        return false;
    }
    
    async loadData() {
        this.state.isLoading = true;
        
        // Safety timeout: Force loading to complete after 10 seconds
        const loadingTimeout = setTimeout(() => {
            console.warn("[WA] Loading timeout - forcing completion");
            this.state.isLoading = false;
        }, 10000);
        
        try {
            // Load connections with api_key and from_field for authentication
            let connections = [];
            try {
                connections = await Promise.race([
                    this.orm.searchRead(
                "whatsapp.connection",
                [],
                ["name", "from_field", "api_key", "is_default", "socket_connection_ready"]
                    ),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Connection fetch timeout")), 10000))
                ]);
            } catch (error) {
                // If connection fetch times out or fails, continue without connections
                connections = [];
            }
            
            // Map connections to include connection_status
            this.state.connections = (connections || []).map(conn => ({
                ...conn,
                connection_status: this.getConnectionStatus(conn)
            }));
            
            // Priority: User's default connection > Global default connection > None
            // First, try to get current user's default connection
            let userDefaultConnectionId = null;
            try {
                const currentUserId = this.userService.userId;
                if (currentUserId) {
                    const currentUser = await this.orm.searchRead(
                        "res.users",
                        [["id", "=", currentUserId]],
                        ["whatsapp_default_connection_id"]
                    );
                    if (currentUser && currentUser.length > 0 && currentUser[0].whatsapp_default_connection_id) {
                        userDefaultConnectionId = currentUser[0].whatsapp_default_connection_id[0]; // [id, name]
                    }
                }
            } catch (error) {
            }
            
            // Find connection: user's default > global default
            let defaultConnection = null;
            if (userDefaultConnectionId) {
                defaultConnection = connections.find(c => c.id === userDefaultConnectionId);
                if (defaultConnection) {
                } else {
                }
            }
            
            // Fallback to global default if user's default not found
            if (!defaultConnection) {
                defaultConnection = connections.find(c => c.is_default);
                if (defaultConnection) {
                }
            }
            
            if (defaultConnection) {
                this.state.selectedConnection = defaultConnection;
                // Update connection statuses after setting default connection
                this.updateConnectionStatuses();
                
                // Set socket authentication with API credentials
                if (defaultConnection.api_key && defaultConnection.from_field) {
                    // Normalize phone number to backend format: +CC NNN... (with space after country code)
                    let phoneNumber = defaultConnection.from_field;
                    
                    
                    if (!phoneNumber) {
                    }
                    
                    // Store credentials for API calls
                    this.apiKey = defaultConnection.api_key.trim();
                    this.phoneNumber = phoneNumber;
                    
                    socketService.setAuthCredentials(
                        this.apiKey,
                        this.phoneNumber,
                        window.location.origin // Can be made dynamic by using window.location.hostname
                    );
                    // Connect socket with credentials (don't wait - do it in background)
                    socketService.connect().then(() => {
                        // Update connection statuses after initial connection
                        this.updateConnectionStatuses();
                    }).catch((e) => {
                        console.error("[WA] Socket connection failed:", e.message || e);
                        // Don't block UI if socket fails
                        // Update statuses even on failure
                        this.updateConnectionStatuses();
                    });

                    // New flow: try to load chats immediately; if unauthenticated, socket will emit QR
                    try {
                        await this.loadConversations(true);
                        // Mark UI ready when chats are available
                        this.state.stage = 'ready';
                        return;
                    } catch (convErr) {
                        // Do not force QR via REST; rely on socket 'qr_code' event
                    }
                } else {
                    console.warn("[WA] Default connection missing credentials");
                }
            } else {
                if (connections.length > 0) {
                    // Auto-select first available connection instead of showing popup
                    const firstConnection = connections[0];
                    await this.selectConnection(firstConnection.id);
                } else {
                    console.warn("[WA] No WhatsApp connections configured");
                    // Show error message in UI
                    this.state.error = "No WhatsApp connections configured. Please create a connection first.";
                }
            }
            
            // New flow: if not yet ready, we already attempted chats; rely on sockets for QR
        } catch (error) {
            // Only log unexpected errors (not timeouts which we handle gracefully)
            if (!error.message || !error.message.includes("timeout")) {
                console.error("[WA] Error loading data:", error.message || error);
            }
            // Ensure state is set on error
            this.state.connections = this.state.connections || [];
            this.state.conversations = this.state.conversations || [];
        } finally {
            clearTimeout(loadingTimeout);
            this.state.isLoading = false;
            // Force reactivity update
            if (this.state.update) {
                this.state.update();
            }
        }
    }
    
    async loadConversations(resetPagination = false) {
        // Fetch chats from Node.js/Express backend API (not Odoo database)
        try {
            if (resetPagination) {
                this.state.pagination.pageIndex = 1;
                this.state.conversations = [];
            }
            
            const { pageIndex, pageSize } = this.state.pagination;
            
            // Need API credentials from selected connection
            if (!this.apiKey || !this.phoneNumber) {
                console.warn("[WA] Missing API credentials - skipping chat load");
                this.state.conversations = [];
                this.state.filteredConversations = [];
                return;
            }
            
            // Validate phone number format: must be "+CC NNN..." with space
            // Backend expects: /^\+[1-9]\d{0,2}\s\d{4,14}$/
            let normalizedPhone = this.phoneNumber.trim();
            if (!normalizedPhone.match(/^\+[1-9]\d{0,2}\s\d{4,14}$/)) {
                throw new Error(`Invalid phone number format: ${normalizedPhone}. Expected: +CC NNN... (with space)`);
            }
            
            // Ensure query params are numbers, not strings
            const pageIndexNum = parseInt(pageIndex, 10);
            const pageSizeNum = parseInt(pageSize, 10);
            
            if (isNaN(pageIndexNum) || pageIndexNum < 1) {
                throw new Error(`Invalid pageIndex: ${pageIndex}. Must be a positive integer >= 1`);
            }
            if (isNaN(pageSizeNum) || pageSizeNum < 1) {
                throw new Error(`Invalid pageSize: ${pageSize}. Must be a positive integer >= 1`);
            }
            
            // Build URL with numeric query params
            const url = new URL(`${this.backendApiUrl}/api/whatsapp/chats`);
            url.searchParams.append('pageIndex', pageIndexNum.toString());
            url.searchParams.append('pageSize', pageSizeNum.toString());
            
            // Prepare headers (include x-system-ip per backend validator)
            const headers = {
                'x-api-key': this.apiKey.trim(),
                // 'x-phone-number': normalizedPhone,
                // 'x-phone-number': "+91 9157000128",
                'x-phone-number': this.phoneNumber.trim(),
                // 'x-system-ip': '127.0.0.1',
                'Content-Type': 'application/json'
            };
            
            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: headers
            });
            
            // Parse response (even if error status)
            let result;
            try {
                result = await response.json();
            } catch (parseError) {
                // If response is not JSON, get text
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }
            
            if (!response.ok) {
                // Do not change stage here; backend may keep request pending until QR scanned
                const errorMessage = result.message || result.error || response.statusText;
                throw new Error(`HTTP ${response.status}: ${errorMessage}`);
            }
            
            if (!result.success) {
                throw new Error(result.message || 'Failed to load chats');
            }
            
            const { chats, meta } = result.data || {};
            const conversations = chats || [];
            const hasMore = meta?.hasNextPage || false;
            
            
            // Map backend chat format to frontend conversation format
            const mappedConversations = conversations.map(chat => ({
                id: chat.id || chat.chatId, // Use id from /api/whatsapp/chats as primary identifier
                conversation_id: chat.id || chat.chatId, // Use id from API response, matches messages' chatId
                contact_name: chat.name || 'Unknown',
                contact_phone: chat.to || '',
                last_message_content: chat.latestMessage?.body || 'No messages yet',
                last_message_type: chat.latestMessage?.type || 'text',
                last_activity: chat.timestamp || new Date().toISOString(),
                unread_count: chat.unreadCount || 0,
                is_pinned: chat.pinned || false,
                is_muted: chat.isMuted || false,
                is_archived: chat.archived || false,
                profile_picture: chat.profilePicture || '/web/static/src/img/avatar.png',
                // contact_status: 'online', // Could be enhanced with real status
                is_group: chat.isGroup || false
            }));
            
            // Append or replace conversations
            if (resetPagination || pageIndex === 1) {
                this.state.conversations = mappedConversations;
            } else {
                // Append new conversations (avoid duplicates by chatId)
                const existingIds = new Set(this.state.conversations.map(c => c.conversation_id));
                const newConversations = mappedConversations.filter(c => !existingIds.has(c.conversation_id));
                this.state.conversations = [...this.state.conversations, ...newConversations];
            }
            
            // Ensure latest activity appears first
            this.state.conversations.sort((a, b) => new Date(b.last_activity || 0) - new Date(a.last_activity || 0));
            
            
            // Populate conversation lookup map (Option B)
            this._rebuildConversationMap();
            
            // Update pagination state from backend response
            this.state.pagination.hasMore = hasMore;
            this.state.pagination.pageIndex = meta?.pageIndex || pageIndex;
            this.state.pagination.isLoadingMore = false;
            
            // Apply search filter if exists
            this.filterConversations();
        } catch (error) {
            console.error("[WA] Error loading conversations:", error.message || error);
            // Set empty array on error so UI doesn't break
            this.state.conversations = [];
            this.state.filteredConversations = [];
            this.state.pagination.isLoadingMore = false;
        }
    }
    
    filterConversations() {
        const searchTerm = (this.state.searchTerm || "").toLowerCase().trim();
        
        if (!searchTerm) {
            // No search term - show all conversations
            this.state.filteredConversations = [...this.state.conversations];
        } else {
            // Filter conversations by search term
            this.state.filteredConversations = this.state.conversations.filter(conv => {
                const name = (conv.contact_name || "").toLowerCase();
                const phone = (conv.contact_phone || "").toLowerCase();
                const lastMessage = (conv.last_message_content || "").toLowerCase();
                
                return name.includes(searchTerm) || 
                       phone.includes(searchTerm) || 
                       lastMessage.includes(searchTerm);
            });
        }
    }
    
    onSearchInput(event) {
        this.state.searchTerm = event.target.value;
        this.filterConversations();
    }
    
    async loadMoreConversations() {
        if (this.state.pagination.isLoadingMore || !this.state.pagination.hasMore) {
            return;
        }
        
        this.state.pagination.isLoadingMore = true;
        this.state.pagination.pageIndex += 1;
        
        await this.loadConversations(false);
    }
    
    async selectConnection(connectionId) {
        const connection = this.state.connections.find(c => c.id === connectionId);
        if (connection) {
            // Set loading state immediately
            this.state.error='';
            this.state.qrImage=null;
            this.state.showQRModal = false;


            this.state.isLoading = false;
            this.state.switchingConnection = true;
            
            this.state.selectedConnection = connection;
            this.state.showConnectionSelector = false;
            
            // Update connection statuses after selection
            this.updateConnectionStatuses();
            
            this.state.selectedConversation = null;
            this.state.messages = [];
            this._messageIdSet.clear();
            
            try {
                // Update socket authentication credentials for selected connection
                if (connection.api_key && connection.from_field) {
                    // Normalize phone number to backend format
                    // let phoneNumber = this.normalizePhoneNumber(connection.from_field);
                    let phoneNumber = connection.from_field;
                    
                    if (!phoneNumber) {
                        console.error("[WA] Invalid phone number for connection:", connection.name);
                        this.state.isLoading = false;
                        this.state.switchingConnection = false;
                        return;
                    }
                    
                    // Store credentials for API calls
                    this.apiKey = connection.api_key.trim();
                    this.phoneNumber = phoneNumber;
                    
                    socketService.setAuthCredentials(
                        this.apiKey,
                        this.phoneNumber,
                        this.clientOrigin || window.location.origin // Can be made dynamic by using window.location.hostname
                    );
                    // Reconnect socket with new credentials
                    if (socketService.socket) {
                        socketService.socket.disconnect();
                    }
                    try {
                        await socketService.connect();
                        // Update connection statuses after reconnection
                        this.updateConnectionStatuses();
                    } catch (e) {
                        console.error("[WA] Socket reconnection failed:", e.message || e);
                        // Update statuses even on failure
                        this.updateConnectionStatuses();
                    }
                } else {
                    console.warn("[WA] Connection missing credentials:", connection.name);
                }
                
                await this.loadConversations(true); // Reset pagination when switching connections

                // Set stage to 'ready' to show the main interface
                this.state.stage = 'ready';
                this.state.canSendMessages = true;
            } catch (error) {
                console.error("[WA] Error switching connection:", error.message || error);
                // Fallback to ready state even on error
                this.state.stage = 'ready';
            } finally {
                this.state.isLoading = false;
                this.state.switchingConnection = false;
            }
        }
    }
    
    showConnectionSelector() {
        this.state.showConnectionSelector = true;
    }
    
    closeQRModal() {
        // Close the QR modal, but keep stage as 'qr' so it can be reopened if needed
        this.state.showQRModal = false;
    }
    
    async selectConversation(conversationId) {
        // Search in both filtered and all conversations
        const conversation = this.state.filteredConversations.find(c => c.id === conversationId) ||
                             this.state.conversations.find(c => c.id === conversationId);
        if (conversation) {
            // Clear unread count immediately when selecting conversation
            conversation.unread_count = 0;
            
            // Update the conversation in the array to reflect cleared count
            const chatIndex = this._conversationMap.get(conversation.conversation_id);
            if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                this.state.conversations[chatIndex].unread_count = 0;
            }
            
            // Mark conversation as read on backend (if we have a backend conversation ID)
            // Note: This assumes the conversation exists in Odoo database
            // For now, we'll just clear the frontend count
            // If you have a backend conversation ID that maps to Odoo's whatsapp.conversation model,
            // you can call the mark_read endpoint here
            
            this.state.selectedConversation = conversation;
            // reset message pagination and load first page (latest 50)
            this.state.messagePagination.pageIndex = 1;
            this.state.messagePagination.pageSize = 50;
            this.state.messagePagination.hasMore = true;
            this.state.messagePagination.isLoadingMore = false;
            this.state.messages = [];
            // Clear message ID set when switching conversations (Option B)
            this._messageIdSet.clear();
            this.loadMessages(conversationId, true);
            
            // Apply search filter to update UI
            this.filterConversations();
        }
    }
    
    toggleContactsPopup() {
        this.state.showContactsPopup = !this.state.showContactsPopup;
        if (this.state.showContactsPopup && this.state.contacts.length === 0) {
            this.loadContacts(1, 50, { append: false });
        }
    }
    
    async loadContacts(pageIndex = 1, pageSize = 50, { append = false } = {}) {
        if (this.state.isLoadingContacts) return;
        this.state.isLoadingContacts = true;
        try {
            if (!this.apiKey || !this.phoneNumber) {
                // Missing API credentials; cannot load contacts
                if (!append) this.state.contacts = [];
                return;
            }
            const baseUrl = this.backendApiUrl || "http://localhost:3000";
            const url = new URL(`${baseUrl}/api/whatsapp/contact`);
            url.searchParams.append('pageIndex', String(pageIndex));
            url.searchParams.append('pageSize', String(pageSize));
            
            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
                // 'origin': window.location.origin,
            };
            
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: headers,
            });
            
            let result;
            try {
                result = await response.json();
            } catch (parseError) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }
            
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to load contacts');
            }
            
            const contactsPayload = result.data?.contacts || [];
            const contacts = contactsPayload.map(c => ({
                id: c.id,
                name: c.name || c.number,
                display_name: c.name || c.number,
                phone_number: c.number,
                profile_picture: c.profilePicture || '/web/static/src/img/avatar.png',
                is_group: !!c.isGroup,
            }));
            
            const meta = result.data?.meta || {};
            this.state.contacts = append ? (this.state.contacts || []).concat(contacts) : contacts;
            this.state.contactsMeta = {
                pageIndex: meta.pageIndex || pageIndex,
                pageSize: meta.pageSize || pageSize,
                totalCount: meta.totalCount || 0,
                totalPages: meta.totalPages || 0,
                hasPreviousPage: !!meta.hasPreviousPage,
                hasNextPage: !!meta.hasNextPage,
            };
        } catch (error) {
            // Contacts fetch failed; reset collection if needed
            if (!append) {
                this.state.contacts = [];
                this.state.contactsMeta = { pageIndex: 1, pageSize, totalCount: 0, totalPages: 0, hasPreviousPage: false, hasNextPage: false };
            }
        } finally {
            this.state.isLoadingContacts = false;
        }
    }
    
    async loadMoreContacts() {
        const m = this.state.contactsMeta || {};
        if (this.state.isLoadingContacts || !m.hasNextPage) return;
        const nextPage = (m.pageIndex || 1) + 1;
        await this.loadContacts(nextPage, m.pageSize || 50, { append: true });
    }
    
    onContactsScroll(ev) {
        const el = ev.currentTarget;
        if (this.state.isLoadingContacts) return;
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
        if (!nearBottom || !(this.state.contactsMeta?.hasNextPage)) return;
        if (this._contactsScrollPending) return;
        this._contactsScrollPending = true;
        this.loadMoreContacts().finally(() => { this._contactsScrollPending = false; });
    }
    
    onContactsSearchInput(ev) {
        const searchTerm = (ev.target.value || '').toLowerCase().trim();
        this.state.contactsSearchTerm = searchTerm;
    }
    
    getFilteredContacts() {
        // Computed property for filtered contacts
        const searchTerm = (this.state.contactsSearchTerm || '').toLowerCase().trim();
        if (!searchTerm) {
            return this.state.contacts;
        }
        
        return this.state.contacts.filter(contact => {
            const name = (contact.name || contact.display_name || '').toLowerCase();
            const phone = (contact.phone_number || '').toLowerCase();
            return name.includes(searchTerm) || phone.includes(searchTerm);
        });
    }
    
    async openChatWithContact(contact) {
        // Close the popup
        this.state.showContactsPopup = false;
        this.state.contactsSearchTerm = "";
        
        try {
            // Create conversation object directly from contact data (no Odoo save needed)
            // Use contact.id (UUID) as conversation_id to match with chats API
            const conversation = {
                id: contact.id,  // UUID from chats API
                conversation_id: contact.id,  // UUID - used to load messages from backend API
                contact_name: contact.name || contact.display_name || 'Unknown',
                contact_phone: contact.phone_number || '',
                profile_picture: contact.profile_picture || '/web/static/src/img/avatar.png',
                last_message_content: 'No messages yet',
                last_activity: new Date().toISOString(),
                unread_count: 0,
                is_pinned: false,
                is_muted: false,
                is_archived: false,
            };
            
            // Check if conversation already exists in the list
            let existingConv = this.state.conversations.find(c => 
                c.conversation_id === conversation.conversation_id ||
                (c.contact_phone && c.contact_phone === conversation.contact_phone)
            );
            
            if (!existingConv) {
                // Add to conversations list
                this.state.conversations.unshift(conversation);
                // Rebuild conversation map
                this._rebuildConversationMap();
            } else {
                // Update existing conversation with latest contact info
                Object.assign(existingConv, {
                    contact_name: conversation.contact_name,
                    contact_phone: conversation.contact_phone,
                    profile_picture: conversation.profile_picture,
                });
            }
            
            // Select the conversation (this will load messages from backend API)
            await this.selectConversation(conversation.id || conversation.conversation_id);
            
        } catch (error) {
            // Opening chat failed
        }
    }
    
    async loadMessages(conversationId, reset = false) {
        // Store previous pageIndex for error recovery (outside try block for catch access)
        let previousPageIndex = this.state.messagePagination.pageIndex;
        
        try {
            if (this.state.isLoadingMessages) return;
            this.state.isLoadingMessages = true;
            if (!this.apiKey || !this.phoneNumber) {
                // Missing API credentials; cannot load messages
                this.state.isLoadingMessages = false;
                return;
            }

            const selected = this.state.selectedConversation;
            if (!selected) return;

            // Prepare pagination
            if (reset) {
                this.state.messagePagination.pageIndex = 1;
                this.state.messagePagination.hasMore = true;
            } else {
                // Increment pageIndex when loading more (not resetting)
                this.state.messagePagination.pageIndex += 1;
            }
            
            const { pageIndex, pageSize } = this.state.messagePagination;
            const chatId = selected.conversation_id || selected.id || conversationId;
            const url = new URL(`${this.backendApiUrl}/api/whatsapp/messages`);
            url.searchParams.append('chatId', chatId);
            url.searchParams.append('pageIndex', parseInt(pageIndex, 10).toString());
            url.searchParams.append('pageSize', parseInt(pageSize, 10).toString());

            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
                'Content-Type': 'application/json'
            };

            // Backend requires body with `to` field
            // const body = JSON.stringify({
            //     to: selected.contact_phone || ''
            // });


            this.state.messagePagination.isLoadingMore = !reset;

            const response = await fetch(url.toString(), { method: 'GET', headers });
            let result;
            try {
                result = await response.json();
            } catch (e) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }

            if (!response.ok || !result?.success) {
                const message = result?.message || response.statusText;
                throw new Error(`HTTP ${response.status}: ${message}`);
            }

            const { messages = [], meta = {} } = result.data || {};

            // Map backend message to UI shape
            const mapped = messages.map((m) => {
                const direction = m.fromMe ? 'outbound' : 'inbound';
                let status = 'sent';
                const ack = parseInt(m.ack, 10) || 0;
                
                if (ack >= 3) status = 'read';
                else if (ack >= 2) status = 'delivered';
                else if (ack >= 1) status = 'sent';
                
                return {
                    id: m.id || m.messageId,
                    content: m.body || m.text || '',
                    direction,
                    msg_timestamp: m.timestamp || m.createdAt || m.time,
                    message_type: m.messageType || m.type || 'text',
                    status,
                    ack: ack,
                    timestamp: (m.timestamp || m.createdAt || m.time),
                    type: (m.messageType || m.type || 'text'),
                    fileName: m.fileName || m.filename || null,
                    mimeType: m.mimeType || null,
                };
            });

            // Sort ascending so latest appears at the bottom
            const sortAsc = (arr) => arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

            const scrollState = reset ? null : this.captureScrollState();
            
            if (reset || pageIndex === 1) {
                // First load: replace and scroll to bottom
                this.state.messages = sortAsc(mapped);
                this.decorateMessagesWithDaySeparators();
                // Populate message ID set (Option B)
                this._messageIdSet.clear();
                this.state.messages.forEach(msg => {
                    if (msg.id) this._messageIdSet.add(msg.id);
                });
            } else {
                // Load older: prepend in ascending order before current list
                const olderAsc = sortAsc(mapped);
                this.state.messages = [...olderAsc, ...this.state.messages];
                this.decorateMessagesWithDaySeparators();
                // Add older message IDs to set
                olderAsc.forEach(msg => {
                    if (msg.id) this._messageIdSet.add(msg.id);
                });
            }

            // Update pagination flags
            this.state.messagePagination.hasMore = meta?.hasNextPage ?? (mapped.length === pageSize);
            // Use meta.pageIndex if provided, otherwise keep the current pageIndex (already incremented before request)
            if (meta?.pageIndex !== undefined) {
                this.state.messagePagination.pageIndex = meta.pageIndex;
            }
            // If no messages returned, decrement pageIndex (we went too far)
            if (mapped.length === 0 && !reset) {
                this.state.messagePagination.pageIndex = Math.max(1, this.state.messagePagination.pageIndex - 1);
                this.state.messagePagination.hasMore = false;
            }
            this.state.messagePagination.isLoadingMore = false;
            this._lastMessagesFetchTs = Date.now();

            // Preserve scroll position when prepending older messages
            if (!reset) {
                this.restoreScrollPosition(scrollState);
            }
            // After first page load, ensure view is scrolled to the most recent message at bottom
            if (reset) {
                // Use multiple attempts to ensure scroll happens after DOM update
                const scrollToBottom = (attempts = 0) => {
                    const container = this.refs?.messagesContainer || 
                                     this._messagesContainer || 
                                     document.querySelector('.messages-container');
                    
                    if (container) {
                        try {
                            const currentScroll = container.scrollTop;
                            const maxScroll = container.scrollHeight - container.clientHeight;
                            
                            // Only scroll if not already at bottom (within 10px threshold)
                            if (currentScroll < maxScroll - 10) {
                                container.scrollTop = container.scrollHeight;
                                
                                // Try again after a short delay if scroll didn't work (DOM might still be updating)
                                if (attempts < 3 && container.scrollTop < container.scrollHeight - container.clientHeight - 10) {
                                    setTimeout(() => scrollToBottom(attempts + 1), 100);
                                }
                            }
                        } catch (e) {
                            // Silently handle scroll errors
                        }
                        
                        // Re-attach scroll listener after messages are rendered
                        this._attachScrollListener();
                    } else if (attempts < 5) {
                        // Retry finding container (DOM might not be ready yet)
                        setTimeout(() => scrollToBottom(attempts + 1), 100);
                    } else {
                        setTimeout(() => this._attachScrollListener(), 200);
                    }
                };
                
                // Start scroll attempt after initial render - use requestAnimationFrame for better timing
                requestAnimationFrame(() => {
                    setTimeout(() => scrollToBottom(0), 100);
                });
            } else {
                // After loading older messages, re-attach listener if needed
                setTimeout(() => this._attachScrollListener(), 50);
            }
        } catch (error) {
            console.error("[WA] Error loading messages:", error.message || error);
            // Revert pageIndex on error if we were loading more
            if (!reset && previousPageIndex !== undefined) {
                this.state.messagePagination.pageIndex = previousPageIndex;
            }
            this.state.messagePagination.isLoadingMore = false;
        } finally {
            this.state.isLoadingMessages = false;
        }
    }

    async loadMoreMessages() {
        if (!this.state.selectedConversation) return;
        if (!this.state.messagePagination.hasMore || this.state.messagePagination.isLoadingMore) return;
        await this.loadMessages(this.state.selectedConversation.id, false);
    }
    
    async sendMessage() {
        const messageText = this.state.messageInput.trim();
        const hasMedia = this.state.selectedMedia !== null;
        
        if ((!messageText && !hasMedia) || !this.state.selectedConversation) return;
        
        const selected = this.state.selectedConversation;
        const recipientPhone = selected.contact_phone?.trim();
        
        if (!recipientPhone) {
            console.error("[WA] Missing recipient phone number");
            return;
        }
        
        if (!this.apiKey || !this.phoneNumber) {
            console.error("[WA] Missing API credentials");
            return;
        }
        
        // Store original message and media
        const originalMessage = messageText;
        const selectedMedia = this.state.selectedMedia;
        
        // Clear inputs
        this.state.messageInput = "";
        this.removeSelectedMedia();
        
        const messageType = selectedMedia ? selectedMedia.type : 'chat';
        // OPTIMISTIC MESSAGE CODE (COMMENTED OUT - using socket events instead)
        // // Create optimistic message
        // const tempMessageId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // const optimisticMessage = {
        //     id: tempMessageId,
        //     content: originalMessage || (selectedMedia ? selectedMedia.file.name : ''),
        //     direction: 'outbound',
        //     msg_timestamp: new Date().toISOString(),
        //     message_type: messageType,
        //     status: 'pending',
        //     ack: 0,
        //     timestamp: new Date().toISOString(),
        //     type: messageType,
        //     media_url: selectedMedia?.preview || null,
        //     media_type: selectedMedia?.type || null,
        //     fileName: selectedMedia?.file.name || null
        // };
        // this.state.messages.push(optimisticMessage);
        // this._messageIdSet.add(tempMessageId);
        // // Scroll to bottom
        // setTimeout(() => {
        //     const container = this.refs?.messagesContainer;
        //     if (container) {
        //         try { container.scrollTop = container.scrollHeight; } catch (e) {}
        //     }
        // }, 0);
        
        try {
            this.state.mediaUploading = true;
            
            const url = `${this.backendApiUrl}/api/whatsapp/send`;
            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
            };
            
            let response;
            
            // If media is present, send as FormData
            if (selectedMedia) {
                const formData = new FormData();
                formData.append('to', recipientPhone);
                formData.append('messageType', messageType);
                formData.append('body', originalMessage || '');
                // Use 'files' (plural) to match backend API expectation
                formData.append('files', selectedMedia.file, selectedMedia.file.name);
                
                response = await fetch(url, {
                    method: 'POST',
                    headers: headers,
                    body: formData
                });
            } else {
                // Text message only - send as JSON
                headers['Content-Type'] = 'application/json';
                const body = {
                    to: recipientPhone,
                    messageType: messageType,
                    body: originalMessage || ''
                };
                
                response = await fetch(url, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body)
                });
            }
            
            this.state.mediaUploading = false;
            
            let result;
            try {
                result = await response.json();
            } catch (e) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }
            
            if (!response.ok || !result?.success) {
                // OPTIMISTIC MESSAGE REMOVAL (COMMENTED OUT - no optimistic messages)
                // // Remove optimistic message on error
                // const messageIndex = this.state.messages.findIndex(m => m.id === tempMessageId);
                // if (messageIndex >= 0) {
                //     this.state.messages.splice(messageIndex, 1);
                //     this._messageIdSet.delete(tempMessageId);
                // }
                
                // Restore input and media on error
                this.state.messageInput = originalMessage;
                if (selectedMedia) {
                    this.state.selectedMedia = selectedMedia;
                }
                
                throw new Error(result?.message || result?.error || 'Failed to send message');
            }
            
            
            // Note: The actual message will arrive via socket event and be added to the UI
            
            // Update chat metadata (last message)
            const chatIndex = this._conversationMap.get(selected.conversation_id);
            if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                const chat = this.state.conversations[chatIndex];
                chat.last_message_content = originalMessage || (selectedMedia ? selectedMedia.file.name : '');
                chat.last_message_type = messageType;
                chat.last_activity = new Date().toISOString();
                
                // Move chat to top if not already
                if (chatIndex !== 0) {
                    const [movedChat] = this.state.conversations.splice(chatIndex, 1);
                    this.state.conversations.unshift(movedChat);
                    this._rebuildConversationMap();
                    
                    // Update selectedConversation reference
                    this.state.selectedConversation = movedChat;
                }
                
                // Apply search filter
                this.filterConversations();
            }
            
        } catch (error) {
            this.state.mediaUploading = false;
            console.error("[WA] Media send error:", error.message || error);
            
            // Show error to user (you can add a toast/notification here)
            // For now, we just log it - input was already cleared
        }
    }
    
    handleKeyPress(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
    }
    
    refreshData() {
        this.loadData();
    }
    
    getConnectionStatusColor() {
        // Use is_default as indicator, or just return default color
        return this.state.selectedConnection?.is_default ? "#25d366" : "#6b7280";
    }
    
    /**
     * Get connection status for a specific connection
     * @param {Object} connection - Connection object
     * @returns {string} 'connected' or 'disconnected'
     */
    getConnectionStatus(connection) {
        if (!connection) return 'disconnected';
        
        // Check if this is the currently selected connection
        const isSelected = this.state.selectedConnection?.id === connection.id;
        
        // Check if socket is connected
        const socketConnected = socketService.isConnected;
        
        // Check backend status (socket_connection_ready field)
        const backendReady = connection.socket_connection_ready || false;
        
        // Connection is "connected" if:
        // 1. It's the selected connection AND socket is connected, OR
        // 2. Backend says it's ready (for other connections that were previously connected)
        if ((isSelected && socketConnected) || backendReady) {
            return 'connected';
        }
        return 'disconnected';
    }
    
    /**
     * Update connection statuses for all connections in the list
     */
    updateConnectionStatuses() {
        this.state.connections = this.state.connections.map(conn => ({
            ...conn,
            connection_status: this.getConnectionStatus(conn)
        }));
    }
    
    
    formatLastActivity(dateString) {
        if (!dateString) return "";
        const date = new Date(dateString);
        return date.toLocaleDateString();
    }
    
    formatMessageTime(dateString) {
        if (!dateString) return "";
        const date = new Date(dateString);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    formatDayLabel(date) {
        if (!date || isNaN(date)) return "";
        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((todayStart - dateStart) / 86400000);
        
        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Yesterday";
        if (diffDays < 7) {
            return date.toLocaleDateString(undefined, { weekday: 'long' });
        }
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    }
    
    decorateMessagesWithDaySeparators() {
        if (!Array.isArray(this.state.messages) || !this.state.messages.length) {
            return;
        }
        let lastDayKey = null;
        this.state.messages.forEach((msg) => {
            const timestamp = msg.timestamp || msg.msg_timestamp;
            if (!timestamp) {
                msg.showDayDivider = false;
                msg.dayLabel = "";
                return;
            }
            const date = new Date(timestamp);
            if (isNaN(date)) {
                msg.showDayDivider = false;
                msg.dayLabel = "";
                return;
            }
            const dayKey = date.toISOString().slice(0, 10);
            if (dayKey !== lastDayKey) {
                msg.showDayDivider = true;
                msg.dayLabel = this.formatDayLabel(date);
                lastDayKey = dayKey;
            } else {
                msg.showDayDivider = false;
            }
        });
    }
    
    captureScrollState() {
        const container = this.refs?.messagesContainer || document.querySelector('.messages-container');
        if (!container) {
            return null;
        }
        const state = {
            scrollHeight: container.scrollHeight,
            scrollTop: container.scrollTop,
        };
    
        return state;
    }
    
    restoreScrollPosition(scrollState) {
        if (!scrollState) {
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = this.refs?.messagesContainer || document.querySelector('.messages-container');
                if (!container) {
                    return;
                }
                const newScrollHeight = container.scrollHeight;
                const diff = newScrollHeight - scrollState.scrollHeight;
                if (diff <= 0) {
                 
                    return;
                }
                container.scrollTop = scrollState.scrollTop + diff;
            });
        });
    }
    
    getAckColor(message) {
        if (message.direction !== 'outbound') {
            return null;
        }
        
        const ack = message.ack || 0;
        return ack >= 3 ? '#53bdeb' : '#667781';
    }
    
    getEmojis() {
        return ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣"];
    }
    
    // Media handling methods
    getFileAcceptTypes() {
        return "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";
    }
    
    openMediaSelector() {
        // Try multiple methods to find the file input
        let fileInput = null;
        
        // Method 1: Try refs (if available)
        if (this.refs && this.refs.fileInput) {
            fileInput = this.refs.fileInput;
        }
        // Method 2: Try __owl__ refs (OWL internal)
        else if (this.__owl__ && this.__owl__.refs && this.__owl__.refs.fileInput) {
            fileInput = this.__owl__.refs.fileInput;
        }
        // Method 3: Use class selector
        else if (this.el) {
            fileInput = this.el.querySelector('.whatsapp-file-input') || 
                       this.el.querySelector('input[type="file"]');
        }
        // Method 4: Search in document (fallback)
        else {
            fileInput = document.querySelector('.whatsapp-file-input');
        }
        
        if (fileInput) {
            fileInput.click();
        } else {

        }
    }
    
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const fileType = this.detectMediaType(file);
        let preview = null;
        
        if (fileType === 'image') {
            preview = URL.createObjectURL(file);
        } else if (fileType === 'video') {
            preview = URL.createObjectURL(file);
        }
        
        this.state.selectedMedia = {
            file: file,
            type: fileType,
            preview: preview
        };
        
        // Reset file input
        event.target.value = '';
    }
    
    detectMediaType(file) {
        const mimeType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();
        
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        
        // Check document extensions
        const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
        if (docExtensions.some(ext => fileName.endsWith(ext))) {
            return 'document';
        }
        
        return 'document'; // Default
    }
    
    removeSelectedMedia() {
        if (this.state.selectedMedia?.preview) {
            URL.revokeObjectURL(this.state.selectedMedia.preview);
        }
        this.state.selectedMedia = null;
    }
    
    formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
    
    async createLeadFromMessage(message) {
        if (!message || message.direction !== 'inbound') {
            return;
        }
        if (!this.state.selectedConversation) {
            console.warn("[WA] Cannot create lead - no conversation selected");
            return;
        }
        if (this._creatingLeadMessageId === message.id) {
            return;
        }
        
        const conversation = this.state.selectedConversation;
        const payload = {
            message_id: message.id,
            message_content: message.content || '',
            message_type: message.message_type || message.type || 'text',
            timestamp: message.timestamp || message.msg_timestamp || null,
            message_direction: message.direction,
            contact_name: conversation.contact_name || conversation.name || '',
            contact_phone: conversation.contact_phone || '',
            conversation_id: conversation.conversation_id || conversation.id || null,
        };
        
        this._creatingLeadMessageId = message.id;
        try {
            const action = await this.rpc('/whatsapp/create_lead_action', payload);
            if (action) {
                await this.actionService.doAction(action);
            } else {
                console.warn("[WA] Lead creation action not returned");
            }
        } catch (error) {
            console.error("[WA] Failed to create lead:", error.message || error);
        } finally {
            if (this._creatingLeadMessageId === message.id) {
                this._creatingLeadMessageId = null;
            }
        }
    }
    
    async uploadMedia(file, mediaType) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', mediaType);
        
        try {
            const url = `${this.backendApiUrl}/api/whatsapp/upload-media`;
            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
            };
            
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: formData
            });
            
            const result = await response.json();
            if (result.success) {
                return result.media_id || result.url || result.id;
            }
            throw new Error(result.error || 'Upload failed');
        } catch (error) {
            console.error('[WA] Media upload failed:', error.message || error);
            throw error;
        }
    }
    
    hasNoConversations() {
        return (!this.state.filteredConversations || this.state.filteredConversations.length === 0) && !this.state.searchTerm;
    }
    
    hasNoSearchResults() {
        return (!this.state.filteredConversations || this.state.filteredConversations.length === 0) && this.state.searchTerm;
    }
    
    hasMoreConversations() {
        return this.state.pagination && this.state.pagination.hasMore && !this.state.searchTerm;
    }
    
    getUnreadCount() {
        const convs = this.state.filteredConversations || [];
        return convs.filter(c => c.unread_count > 0).length;
    }
    
    /**
     * Normalize phone number to backend format: +CC NNN... (with space after country code)
     * Backend expects: /^\+[1-9]\d{0,2}\s\d{4,14}$/
     * Examples:
     *   "+91 9157000128" -> "+91 9157000128" ✓
     *   "+919157000128" -> "+91 9157000128" ✓
     *   "9157000128" -> "+91 9157000128" (if default country code is +91)
     */
    normalizePhoneNumber(phoneInput) {
        if (!phoneInput) return null;
        
        // Remove all spaces and non-digit characters except +
        let cleaned = phoneInput.trim().replace(/[^\d+]/g, '');
        
        // If it doesn't start with +, try to add country code (default: +91)
        if (!cleaned.startsWith('+')) {
            // Try extracting country code from common formats
            // E.g., "0919157000128" -> "+91 9157000128"
            if (cleaned.startsWith('91') && cleaned.length >= 12) {
                cleaned = '+' + cleaned;
            } else if (cleaned.startsWith('0') && cleaned.length >= 11) {
                // Remove leading 0 and add +91
                cleaned = '+91' + cleaned.substring(1);
            } else {
                // Assume it's Indian number without country code
                cleaned = '+91' + cleaned;
            }
        }
        
        // Add space after country code if missing
        // Match: +{1-3 digits}
        const countryCodeMatch = cleaned.match(/^\+(\d{1,3})(\d+)$/);
        if (countryCodeMatch) {
            const [, countryCode, number] = countryCodeMatch;
            cleaned = `+${countryCode} ${number}`;
        }
        
        // Validate final format
        if (cleaned.match(/^\+[1-9]\d{0,2}\s\d{4,14}$/)) {
            return cleaned;
        }
        
        console.warn("[WA] Phone number normalization failed:", phoneInput);
        return cleaned; // Return anyway, validation will catch it
    }
    
    handleChatUpdate(chatData) {
        // Handle real-time chat updates from Socket.IO (Option B: append with lookup map)
        // chatData format: { id, chatId, name, profilePicture, unreadCount, timestamp, latestMessage, ... }
        
        // Use id if available (from REST API), otherwise fall back to chatId (from socket events)
        const chatId = chatData.id || chatData.chatId;
        if (!chatData || !chatId) {
            return;
        }
        
        const existingIndex = this._conversationMap.get(chatId);
        
        // Map backend chat format to frontend format
        const updatedChat = {
            id: chatData.id || chatId,
            conversation_id: chatData.id || chatId, // Use id from API response, matches messages' chatId
            contact_name: chatData.name || 'Unknown',
            contact_phone: chatData.to || '',
            last_message_content: chatData.latestMessage?.body || chatData.latestMessage?.text || 'No messages yet',
            last_message_type: chatData.latestMessage?.messageType || chatData.latestMessage?.type || 'text',
            last_activity: chatData.timestamp || new Date().toISOString(),
            unread_count: chatData.unreadCount || 0,
            is_pinned: chatData.pinned || false,
            is_muted: chatData.isMuted || false,
            is_archived: chatData.archived || false,
            profile_picture: chatData.profilePicture || '/web/static/src/img/avatar.png',
            contact_status: 'online',
            is_group: chatData.isGroup || false
        };
        
        if (existingIndex !== undefined && existingIndex >= 0 && existingIndex < this.state.conversations.length) {
            // Chat exists: update it and move to top (1st position)
            const wasSelected = this.state.selectedConversation?.conversation_id === chatId;
            
            // If conversation is selected, clear unread count (don't trust backend for selected chats)
            if (wasSelected) {
                updatedChat.unread_count = 0;
            }
            // Otherwise, use backend value directly - don't increment manually
            // The backend already calculates the correct unreadCount
            
            this.state.conversations[existingIndex] = updatedChat;
            
            // Move to top (index 0)
            const [movedChat] = this.state.conversations.splice(existingIndex, 1);
            this.state.conversations.unshift(movedChat);
            
            // Update map: all indices shifted, so rebuild map
            this._rebuildConversationMap();
            
            // If this chat is currently selected, update selectedConversation reference
            if (wasSelected) {
                this.state.selectedConversation = movedChat; // Use movedChat which is now at index 0
            }
          
        } else {
            // New chat: add to top
            this.state.conversations.unshift(updatedChat);
            this._conversationMap.set(chatId, 0);
            // Shift all other indices in map
            for (let i = 1; i < this.state.conversations.length; i++) {
                const cid = this.state.conversations[i].conversation_id;
                if (cid) this._conversationMap.set(cid, i);
            }
        }
        
        // Apply search filter
        this.filterConversations();
    }
    
    /**
     * Generate consistent conversation ID from from/to phone numbers
     * Sorts phone numbers to ensure same conversation gets same ID regardless of direction
     */
    getConversationId(from, to) {
        if (!from || !to) return null;
        const participants = [from.trim(), to.trim()].filter(p => p).sort();
        if (participants.length !== 2) return null;
        return participants.join('_');
    }
    
    /**
     * Get conversation ID for a 1:1 chat using current user's phone and contact phone
     */
    getConversationIdForChat(contactPhone) {
        if (!this.phoneNumber || !contactPhone) return null;
        return this.getConversationId(this.phoneNumber, contactPhone);
    }
    
    /**
     * Find conversation by generated ID or backend chatId
     */
    // findConversationByMessage(msg) {
    //     const from = (msg.from || '').trim();
    //     const to = (msg.to || '').trim();
        
    //     if (!from || !to) {
    //         return null;
    //     }
        
    //     // Generate conversation ID from message
    //     const generatedId = this.getConversationId(from, to);
        
    //     // Try lookup map first (fastest) - check if generated ID is indexed
    //     if (generatedId) {
    //         const mapIndex = this._conversationMap.get(generatedId);
    //         if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
    //             const conv = this.state.conversations[mapIndex];
    //             // Verify it's still a match
    //             const convGeneratedId = this.getConversationIdForChat(conv.contact_phone);
    //             if (convGeneratedId === generatedId) {
    //                 return conv;
    //             }
    //         }
    //     }
        
    //     // Try to find by generated ID (for 1:1 chats) - linear search fallback
    //     if (generatedId) {
    //         const conv = this.state.conversations.find(c => {
    //             if (c.is_group) return false; // Skip groups
    //             const convGeneratedId = this.getConversationIdForChat(c.contact_phone);
    //             return convGeneratedId === generatedId;
    //         });
    //         if (conv) return conv;
    //     }
        
    //     // Try to find by phone number match (fallback)
    //     const conv = this.state.conversations.find(c => {
    //         const phone = (c.contact_phone || '').trim();
    //         return phone && (from === phone || to === phone);
    //     });
    //     return conv || null;
    // }
        /**
     * Find conversation by chatId (preferred) or by generated ID/phone number (fallback)
     */
        findConversationByMessage(msg) {
            // First, try to find by chatId if message includes it
            if (msg.chatId) {
                const mapIndex = this._conversationMap.get(msg.chatId);
                if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
                    const conv = this.state.conversations[mapIndex];
                    // Verify it matches
                    if (conv.conversation_id === msg.chatId) {
                        return conv;
                    }
                }
                
                // Fallback: linear search by conversation_id
                const conv = this.state.conversations.find(c => c.conversation_id === msg.chatId);
                if (conv) return conv;
            }
            
            // Fallback to phone number matching (existing logic)
            const from = (msg.from || '').trim();
            const to = (msg.to || '').trim();
            
            if (!from || !to) {
                return null;
            }
            
            // Generate conversation ID from message
            const generatedId = this.getConversationId(from, to);
            
            // Try lookup map first (fastest) - check if generated ID is indexed
            if (generatedId) {
                const mapIndex = this._conversationMap.get(generatedId);
                if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
                    const conv = this.state.conversations[mapIndex];
                    // Verify it's still a match
                    const convGeneratedId = this.getConversationIdForChat(conv.contact_phone);
                    if (convGeneratedId === generatedId) {
                        return conv;
                    }
                }
            }
            
            // Try to find by generated ID (for 1:1 chats) - linear search fallback
            if (generatedId) {
                const conv = this.state.conversations.find(c => {
                    if (c.is_group) return false; // Skip groups
                    const convGeneratedId = this.getConversationIdForChat(c.contact_phone);
                    return convGeneratedId === generatedId;
                });
                if (conv) return conv;
            }
            
            // Try to find by phone number match (fallback)
            const conv = this.state.conversations.find(c => {
                const phone = (c.contact_phone || '').trim();
                return phone && (from === phone || to === phone);
            });
            return conv || null;
        }
    
    _rebuildConversationMap() {
        // Rebuild conversation map after array modifications
        // Map both backend chatId and generated conversation IDs
        this._conversationMap.clear();
        this.state.conversations.forEach((conv, index) => {
            if (conv.conversation_id) {
                this._conversationMap.set(conv.conversation_id, index);
            }
            // Also index by generated conversation ID for 1:1 chats
            if (conv.contact_phone && !conv.is_group) {
                const generatedId = this.getConversationIdForChat(conv.contact_phone);
                if (generatedId) {
                    this._conversationMap.set(generatedId, index);
                }
            }
        });
    }
    
    handleMessageEvent(msg) {
        // Handle incoming message from socket (Option B: append if not exists)
        if (!msg || !msg.id) {
            return;
        }
        
        const msgId = msg.id;
        const from = (msg.from || '').trim();
        const to = (msg.to || '').trim();
        
        // Find conversation using consistent conversation ID matching
        const targetConversation = this.findConversationByMessage(msg);
        if (!targetConversation) {
            return;
        }
        
        const targetChatId = targetConversation.conversation_id || targetConversation.id;
        const selected = this.state.selectedConversation;
        const isSelected = selected && (selected.conversation_id === targetChatId || selected.id === targetChatId);
            
        // Map message to UI format
        const direction = msg.fromMe ? 'outbound' : 'inbound';
        let status = 'sent';
        const ack = parseInt(msg.ack, 10) || 0;
        
        if (ack >= 3) status = 'read';
        else if (ack >= 2) status = 'delivered';
        else if (ack >= 1) status = 'sent';
        
        const mappedMessage = {
            id: msgId,
            content: msg.body || msg.text || '',
            direction,
            msg_timestamp: msg.timestamp || msg.createdAt || msg.time,
            message_type: msg.messageType || msg.type || 'text',
            status,
            ack: ack,
            timestamp: (msg.timestamp || msg.createdAt || msg.time),
            type: (msg.messageType || msg.type || 'text'),
            fileName: msg.fileName || msg.filename || null,
            mimeType: msg.mimeType || null,
        };
        
        // If message belongs to currently open conversation, append if not exists
        if (isSelected) {
            if (!this._messageIdSet.has(msgId)) {
                // OPTIMISTIC MESSAGE MATCHING (COMMENTED OUT - no optimistic messages)
                // // Check if we have an optimistic message (temp ID) for this message
                // // Match by content and direction for outbound messages
                // if (mappedMessage.direction === 'outbound') {
                //     const optimisticIndex = this.state.messages.findIndex(m => 
                //         m.id && m.id.startsWith('temp_') && 
                //         m.content === mappedMessage.content &&
                //         m.direction === 'outbound'
                //     );
                //     
                //     if (optimisticIndex >= 0) {
                //         // Replace optimistic message with real one
                //         const tempId = this.state.messages[optimisticIndex].id;
                //         this.state.messages[optimisticIndex] = mappedMessage;
                //         this._messageIdSet.delete(tempId);
                //         this._messageIdSet.add(msgId);
                //         
                //         console.log("[WA][Action] ✅ Replaced optimistic message with real message:", msgId);
                //     } else {
                //         // Add new message
                //         this.state.messages.push(mappedMessage);
                //         this._messageIdSet.add(msgId);
                //         console.log("[WA][Action] ✅ Appended message to open chat:", msgId);
                //     }
                // } else {
                //     // Inbound message - just add it
                //     this.state.messages.push(mappedMessage);
                //     this._messageIdSet.add(msgId);
                //     console.log("[WA][Action] ✅ Appended inbound message to open chat:", msgId);
                // }
                
                // Just add the message from socket event
                this.state.messages.push(mappedMessage);
                this._messageIdSet.add(msgId);
                
                // Re-sort to ensure chronological order (oldest->newest)
                this.state.messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                this.decorateMessagesWithDaySeparators();
                
                // Auto-scroll to bottom if user is near bottom
                const container = this.refs?.messagesContainer;
                if (container) {
                    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
                    if (isNearBottom) {
                        setTimeout(() => {
                            try { container.scrollTop = container.scrollHeight; } catch (e) {}
                        }, 0);
                    }
                }
            } else {
                // Message already exists - but ack might have changed (status update)
                const existingMsgIndex = this.state.messages.findIndex(m => m.id === msgId);
                if (existingMsgIndex >= 0) {
                    const existingMsg = this.state.messages[existingMsgIndex];
                    
                    // Update ack if it changed (for status updates)
                    if (msg.ack !== undefined && msg.ack !== null) {
                        const newAck = parseInt(msg.ack, 10) || 0;
                        if (newAck !== existingMsg.ack) {
                            existingMsg.ack = newAck;
                            
                            // Update status based on new ack
                            if (newAck >= 3) existingMsg.status = 'read';
                            else if (newAck >= 2) existingMsg.status = 'delivered';
                            else if (newAck >= 1) existingMsg.status = 'sent';
                        }
                    }
                } else {
                }
            }
        }
        
        // Update chat metadata and move to top
        // Use the targetConversation object directly to find its index
        let chatIndex = this.state.conversations.findIndex(c => c === targetConversation);
        
        // If not found by reference, try by conversation_id or id
        if (chatIndex < 0) {
            chatIndex = this.state.conversations.findIndex(c => 
                (c.conversation_id && c.conversation_id === targetChatId) ||
                (c.id && c.id === targetChatId)
            );
        }
        
        // Fallback to map lookup if still not found
        if (chatIndex < 0) {
            const mapIndex = this._conversationMap.get(targetChatId);
            if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
                chatIndex = mapIndex;
            }
        }
        
        if (chatIndex >= 0 && chatIndex < this.state.conversations.length) {
            const chat = this.state.conversations[chatIndex];
            
            // Update chat metadata
            chat.last_message_content = mappedMessage.content;
            chat.last_message_type = mappedMessage.type;
            chat.last_activity = mappedMessage.timestamp;
            
            // Don't manually increment unread count here - the backend calculates it correctly
            // and sends it via the 'chat' event. If we increment here AND the backend sends
            // an updated count, we get double counting.
            // Only clear unread count if conversation is selected (user is viewing it)
            if (isSelected) {
                chat.unread_count = 0;
            }
            // Note: For unselected conversations, the unread count will be updated by handleChatUpdate()
            // when the backend sends the 'chat' event with the correct unreadCount
            
            // Move chat to top (1st position) - always move to top when new message arrives
            if (chatIndex !== 0) {
                const [movedChat] = this.state.conversations.splice(chatIndex, 1);
                this.state.conversations.unshift(movedChat);
                this._rebuildConversationMap();
                
                // Update selectedConversation reference if it was selected
                if (isSelected) {
                    this.state.selectedConversation = movedChat;
                }
            }
        } else {
            console.warn("[WA] Chat not found in conversations array");
        }
        
        // Apply search filter
        this.filterConversations();
    }
}

// Register the client action
registry.category("actions").add("whatsapp_web_client_action", WhatsAppWebClientAction);

