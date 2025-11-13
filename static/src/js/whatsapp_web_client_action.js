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
        });
        // Timestamp for debouncing message refetch
        this._lastMessagesFetchTs = 0;
        
        // Lookup maps for efficient de-duplication (Option B)
        this._conversationMap = new Map(); // Key: chatId (conversation_id), Value: index in conversations array
        this._messageIdSet = new Set(); // Set of message IDs for currently open conversation
        
        // Scroll handler debounce
        this._scrollDebounceTimer = null;
        
        console.log("[WA][Action] ===== WhatsApp Web Client Action Initialized =====");
        console.log("[WA][Action] Starting to load connections and credentials...");

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
            console.warn("[WA][Action] ⚠️ Messages container not found for scroll listener");
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
                    console.log("[WA][Action] 📜 Scroll to top detected, loading more messages...", {
                        scrollTop: container.scrollTop,
                        scrollHeight: container.scrollHeight,
                        clientHeight: container.clientHeight,
                        hasMore: this.state.messagePagination.hasMore,
                        isLoadingMore: this.state.messagePagination.isLoadingMore
                    });
                    this.loadMoreMessages();
                }
            }, 100); // Debounce for 100ms
        };
        
        container.addEventListener('scroll', this._onMessagesScroll, { passive: true });
        console.log("[WA][Action] ✅ Scroll listener attached to messages container");
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
        console.log("qrcodenumberpayload", this.phoneNumber);
        const headers = {
            'x-api-key': this.apiKey.trim(),
            // 'x-phone-number': "+91 9157000128",
            'x-phone-number': this.phoneNumber.trim(),
            // 'x-system-ip': '127.0.0.1',
            'Content-Type': 'application/json'
        };

        const url = `${this.backendApiUrl}/api/whatsapp/qr`;
        console.log("[WA][Action] Triggering QR flow:", { url, headers: { 'x-api-key': headers['x-api-key']?.substring(0,20)+"...", 'x-phone-number': headers['x-phone-number'] } });

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
        console.warn('[WA][Action] QR trigger response:', response.status, result?.message);
        if (response.status === 400) {
            this.state.error = result?.message || 'Validation error starting QR flow';
        } else if (response.status === 401 || response.status === 403) {
            this.state.needsAuth = true;
            this.state.error = result?.message || 'Authentication required to start QR flow';
        }
        return false;
    }
    
    async loadData() {
        console.log("[WA][Action] loadData() called - fetching connections from database...");
        this.state.isLoading = true;
        
        // Safety timeout: Force loading to complete after 10 seconds
        const loadingTimeout = setTimeout(() => {
            console.warn("[WA][Action] ⚠️ Loading timeout reached - forcing completion");
            this.state.isLoading = false;
        }, 10000);
        
        try {
            // Load connections with api_key and from_field for authentication
            console.log("[WA][Action] Fetching connections from database...");
            let connections = [];
            try {
                connections = await Promise.race([
                    this.orm.searchRead(
                "whatsapp.connection",
                [],
                ["name", "from_field", "api_key", "is_default"]
                    ),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Connection fetch timeout")), 10000))
                ]);
            } catch (error) {
                // If connection fetch times out or fails, continue without connections
                console.warn("[WA][Action] ⚠️ Failed to fetch connections, continuing without them:", error.message);
                connections = [];
            }
            
            console.log("[WA][Action] Found", connections.length, "connections in database");
            console.log("connections", connections);
            this.state.connections = connections || [];
            
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
                        console.log("[WA][Action] Found user's default connection ID:", userDefaultConnectionId);
                    }
                }
            } catch (error) {
                console.warn("[WA][Action] ⚠️ Could not fetch user's default connection:", error.message);
            }
            
            // Find connection: user's default > global default
            let defaultConnection = null;
            if (userDefaultConnectionId) {
                defaultConnection = connections.find(c => c.id === userDefaultConnectionId);
                if (defaultConnection) {
                    console.log("[WA][Action] Using user's default connection:", defaultConnection.name);
                } else {
                    console.warn("[WA][Action] ⚠️ User's default connection not found in authorized connections, falling back to global default");
                }
            }
            
            // Fallback to global default if user's default not found
            if (!defaultConnection) {
                defaultConnection = connections.find(c => c.is_default);
                if (defaultConnection) {
                    console.log("[WA][Action] Using global default connection:", defaultConnection.name);
                }
            }
            
            if (defaultConnection) {
                this.state.selectedConnection = defaultConnection;
                
                // Set socket authentication with API credentials
                if (defaultConnection.api_key && defaultConnection.from_field) {
                    // Normalize phone number to backend format: +CC NNN... (with space after country code)
                    let phoneNumber = defaultConnection.from_field;
                    
                    console.log("[WA][Action] Setting credentials for default connection:");
                    console.log("[WA][Action]   - API Key:", defaultConnection.api_key?.substring(0, 20) + '...');
                    console.log("[WA][Action]   - Phone Number (original):", defaultConnection.from_field);
                    console.log("[WA][Action]   - Phone Number (normalized):", phoneNumber);
                    console.log("[WA][Action]   - Origin: 127.0.0.1");
                    
                    if (!phoneNumber) {
                        console.error("[WA][Action] ❌ Failed to normalize phone number:", defaultConnection.from_field);
                        console.error("[WA][Action] Expected format: +CC NNN... (e.g., '+91 9157000128')");
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
                        console.log("[WA][Action] ✅ Socket connected with credentials");
                    }).catch((e) => {
                        console.error("[WA][Action] ❌ Socket connection failed:", e);
                        // Don't block UI if socket fails
                    });

                    // New flow: try to load chats immediately; if unauthenticated, socket will emit QR
                    try {
                        await this.loadConversations(true);
                        // Mark UI ready when chats are available
                        this.state.stage = 'ready';
                        return;
                    } catch (convErr) {
                        console.warn("[WA][Action] ⚠️ Initial chats fetch failed, waiting for socket QR:", convErr?.message || convErr);
                        // Do not force QR via REST; rely on socket 'qr_code' event
                    }
                } else {
                    console.warn("[WA][Action] ⚠️ No credentials available for default connection");
                }
            } else {
                console.log("[WA][Action] No default connection found in database");
                if (connections.length > 0) {
                    console.log("[WA][Action] Prompting user to select a connection");
                    this.state.showConnectionSelector = true;
                } else {
                    console.warn("[WA][Action] ⚠️ No connections available");
                    // Show error message in UI
                    this.state.error = "No WhatsApp connections configured. Please create a connection first.";
                }
            }
            
            // New flow: if not yet ready, we already attempted chats; rely on sockets for QR
        } catch (error) {
            // Only log unexpected errors (not timeouts which we handle gracefully)
            if (!error.message || !error.message.includes("timeout")) {
                console.error("[WA][Action] ❌ Unexpected error loading data:", error);
                console.error("[WA][Action] Error details:", error.message, error.stack);
            } else {
                console.warn("[WA][Action] ⚠️ Timeout occurred but continuing:", error.message);
            }
            // Ensure state is set on error
            this.state.connections = this.state.connections || [];
            this.state.conversations = this.state.conversations || [];
        } finally {
            clearTimeout(loadingTimeout);
            console.log("[WA][Action] ✅ Setting isLoading to false");
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
                console.warn("[WA][Action] ⚠️ No API credentials available, skipping chat load");
                console.warn("[WA][Action]   - apiKey:", this.apiKey ? 'Present' : 'MISSING');
                console.warn("[WA][Action]   - phoneNumber:", this.phoneNumber ? 'Present' : 'MISSING');
                this.state.conversations = [];
                this.state.filteredConversations = [];
                return;
            }
            
            // Validate phone number format: must be "+CC NNN..." with space
            // Backend expects: /^\+[1-9]\d{0,2}\s\d{4,14}$/
            let normalizedPhone = this.phoneNumber.trim();
            if (!normalizedPhone.match(/^\+[1-9]\d{0,2}\s\d{4,14}$/)) {
                console.error("[WA][Action] ❌ Invalid phone number format:", normalizedPhone);
                console.error("[WA][Action] Expected format: +CC NNN... (e.g., '+91 9157000128')");
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
            console.log("Phoneinchatapayload", this.phoneNumber);
            const headers = {
                'x-api-key': this.apiKey.trim(),
                // 'x-phone-number': normalizedPhone,
                // 'x-phone-number': "+91 9157000128",
                'x-phone-number': this.phoneNumber.trim(),
                // 'x-system-ip': '127.0.0.1',
                'Content-Type': 'application/json'
            };
            
            console.log("[WA][Action] loadConversations() - Request details:", {
                url: url.toString(),
                method: 'POST',
                headers: {
                    'x-api-key': headers['x-api-key'].substring(0, 20) + '...',
                    'x-phone-number': headers['x-phone-number']
                },
                queryParams: {
                    pageIndex: pageIndexNum,
                    pageSize: pageSizeNum
                }
            });
            
            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: headers
            });
            
            // Parse response (even if error status)
            let result;
            try {
                result = await response.json();
                console.log("resultchatapi", result);
            } catch (parseError) {
                // If response is not JSON, get text
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }
            
            if (!response.ok) {
                // Do not change stage here; backend may keep request pending until QR scanned
                const errorMessage = result.message || result.error || response.statusText;
                console.error("[WA][Action] ❌ API Error Response:", {
                    status: response.status,
                    statusText: response.statusText,
                    message: errorMessage,
                    fullResponse: result
                });
                throw new Error(`HTTP ${response.status}: ${errorMessage}`);
            }
            
            console.log("[WA][Action] ✅ API response received:", result);
            
            if (!result.success) {
                throw new Error(result.message || 'Failed to load chats');
            }
            
            const { chats, meta } = result.data || {};
            const conversations = chats || [];
            const hasMore = meta?.hasNextPage || false;
            
            console.log("[WA][Action] loadConversations() - Received", conversations, "chats, hasMore:", hasMore);
            
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
            console.log("conversationsaftersorting", this.state.conversations);
            
            // Populate conversation lookup map (Option B)
            this._rebuildConversationMap();
            
            // Update pagination state from backend response
            this.state.pagination.hasMore = hasMore;
            this.state.pagination.pageIndex = meta?.pageIndex || pageIndex;
            this.state.pagination.isLoadingMore = false;
            
            // Apply search filter if exists
            this.filterConversations();
        } catch (error) {
            console.error("[WA][Action] ❌ Error loading conversations:", error);
            console.error("[WA][Action] Error details:", error.message, error.stack);
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
        
        console.log("[WA][Action] Filtered conversations:", this.state.filteredConversations.length, "from", this.state.conversations.length);
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
            this.state.isLoading = false;
            this.state.switchingConnection = true;
            
            this.state.selectedConnection = connection;
            this.state.showConnectionSelector = false;
            
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
                        console.error("[WA][Action] ❌ Failed to normalize phone number for connection:", connection.name);
                        console.error("[WA][Action] Original:", connection.from_field);
                        this.state.isLoading = false;
                        this.state.switchingConnection = false;
                        return;
                    }
                    
                    console.log("[WA][Action] Setting credentials for connection:", connection.name);
                    console.log("[WA][Action]   - API Key:", connection.api_key?.substring(0, 20) + '...');
                    console.log("[WA][Action]   - Phone Number (original):", connection.from_field);
                    console.log("[WA][Action]   - Phone Number (normalized):", phoneNumber);
                    console.log("[WA][Action]   - Origin: 127.0.0.1");
                    
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
                        console.log("[WA][Action] Disconnecting old socket...");
                        socketService.socket.disconnect();
                    }
                    try {
                        await socketService.connect();
                        console.log("[WA][Action] ✅ Socket reconnected with credentials for:", connection.name);
                    } catch (e) {
                        console.error("[WA][Action] ❌ Socket reconnection failed:", e);
                    }
                } else {
                    console.warn("[WA][Action] ⚠️ No credentials available for connection:", connection.name);
                }
                
                await this.loadConversations(true); // Reset pagination when switching connections

                // Set stage to 'ready' to show the main interface
                this.state.stage = 'ready';
                this.state.canSendMessages = true;
            } catch (error) {
                console.error("[WA][Action] Error switching connection:", error);
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
                console.warn("[WA][Action] ⚠️ No API credentials available for loading contacts");
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
            console.error("[WA][Action] Failed to load contacts:", error);
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
        console.log("[WA][Action] Opening chat with contact:", contact);
        
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
            console.error("[WA][Action] Error opening chat with contact:", error);
        }
    }
    
    async loadMessages(conversationId, reset = false) {
        // Store previous pageIndex for error recovery (outside try block for catch access)
        let previousPageIndex = this.state.messagePagination.pageIndex;
        
        try {
            if (this.state.isLoadingMessages) return;
            this.state.isLoadingMessages = true;
            if (!this.apiKey || !this.phoneNumber) {
                console.warn("[WA][Action] ⚠️ No API credentials available for messages");
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
            console.log("selected.conversation_id", chatId);
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

            console.log("[WA][Action] loadMessages() - Request:", {
                url: url.toString(),
                headers: { 'x-api-key': headers['x-api-key'].substring(0,20)+"...", 'x-phone-number': headers['x-phone-number'] },
                // body: { to: selected.contact_phone },
                chatId:selected.conversation_id,
                pageIndex,
                pageSize,
                reset,
                previousPageIndex: reset ? 1 : previousPageIndex
            });

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
                if (typeof m.ack === 'number') {
                    if (m.ack >= 3) status = 'delivered'; // treat 3+ as double ticks/read
                    else if (m.ack >= 2) status = 'delivered';
                    else if (m.ack >= 1) status = 'sent';
                }
                return {
                    id: m.id || m.messageId,
                    content: m.body || m.text || '',
                    direction,
                    msg_timestamp: m.timestamp || m.createdAt || m.time,
                    message_type: m.messageType || m.type || 'text',
                    status,
                    // Derived fields used by template
                    timestamp: (m.timestamp || m.createdAt || m.time),
                    type: (m.messageType || m.type || 'text'),
                };
            });

            // Sort ascending so latest appears at the bottom
            const sortAsc = (arr) => arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

            if (reset || pageIndex === 1) {
                // First load: replace and scroll to bottom
                this.state.messages = sortAsc(mapped);
                // Populate message ID set (Option B)
                this._messageIdSet.clear();
                this.state.messages.forEach(msg => {
                    if (msg.id) this._messageIdSet.add(msg.id);
                });
            } else {
                // Load older: prepend in ascending order before current list
                const olderAsc = sortAsc(mapped);
                this.state.messages = [...olderAsc, ...this.state.messages];
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

            // Optionally, keep scroll position when prepending older messages
            if (!reset) {
                const container = this.refs?.messagesContainer;
                if (container) {
                    // Nudge down slightly to avoid jump; a full preservation would need height diff calc
                    container.scrollTop = 10;
                }
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
                                console.log("[WA][Action] 📜 Scrolled to bottom:", {
                                    scrollTop: container.scrollTop,
                                    scrollHeight: container.scrollHeight,
                                    clientHeight: container.clientHeight
                                });
                                
                                // Try again after a short delay if scroll didn't work (DOM might still be updating)
                                if (attempts < 3 && container.scrollTop < container.scrollHeight - container.clientHeight - 10) {
                                    setTimeout(() => scrollToBottom(attempts + 1), 100);
                                }
                            }
                        } catch (e) {
                            console.warn("[WA][Action] ⚠️ Error scrolling to bottom:", e);
                        }
                        
                        // Re-attach scroll listener after messages are rendered
                        this._attachScrollListener();
                    } else if (attempts < 5) {
                        // Retry finding container (DOM might not be ready yet)
                        setTimeout(() => scrollToBottom(attempts + 1), 100);
                    } else {
                        console.warn("[WA][Action] ⚠️ Messages container not found after multiple attempts");
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
            console.error("[WA][Action] ❌ Error loading messages:", error);
            // Revert pageIndex on error if we were loading more
            if (!reset && previousPageIndex !== undefined) {
                this.state.messagePagination.pageIndex = previousPageIndex;
                console.log("[WA][Action] Reverted pageIndex to:", previousPageIndex);
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
        if (!messageText || !this.state.selectedConversation) return;
        
        const selected = this.state.selectedConversation;
        const recipientPhone = selected.contact_phone?.trim();
        
        if (!recipientPhone) {
            console.error("[WA][Action] ❌ No recipient phone number available");
            return;
        }
        
        if (!this.apiKey || !this.phoneNumber) {
            console.error("[WA][Action] ❌ No API credentials available");
            return;
        }
        
        // Store original message for optimistic update
        const originalMessage = messageText;
        
        // Clear input immediately for better UX
        this.state.messageInput = "";
        
        // Create optimistic message (will be replaced by real message from socket)
        const tempMessageId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const optimisticMessage = {
            id: tempMessageId,
            content: originalMessage,
            direction: 'outbound',
            msg_timestamp: new Date().toISOString(),
            message_type: 'chat',
            status: 'pending', // Will update when socket confirms
            timestamp: new Date().toISOString(),
            type: 'chat'
        };
        
        // Append optimistic message to UI
        this.state.messages.push(optimisticMessage);
        this._messageIdSet.add(tempMessageId);
        
        // Scroll to bottom after adding message
        setTimeout(() => {
            const container = this.refs?.messagesContainer;
            if (container) {
                try { container.scrollTop = container.scrollHeight; } catch (e) {}
            }
        }, 0);
        
        try {
            const url = `${this.backendApiUrl}/api/whatsapp/send`;
            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
                // 'Origin': '127.0.0.1', // Can be made dynamic
                'Content-Type': 'application/json'
            };
            
            const body = JSON.stringify({
                to: recipientPhone,
                messageType: 'chat',
                body: originalMessage
            });
            
            console.log("[WA][Action] Sending message:", {
                url,
                to: recipientPhone,
                body: originalMessage,
                headers: {
                    'x-api-key': headers['x-api-key'].substring(0, 20) + '...',
                    'x-phone-number': headers['x-phone-number']
                }
            });
            
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: body
            });
            
            let result;
            try {
                result = await response.json();
            } catch (e) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
            }
            
            if (!response.ok || !result?.success) {
                const errorMessage = result?.message || result?.error || response.statusText;
                
                // Remove optimistic message on error
                const messageIndex = this.state.messages.findIndex(m => m.id === tempMessageId);
                if (messageIndex >= 0) {
                    this.state.messages.splice(messageIndex, 1);
                    this._messageIdSet.delete(tempMessageId);
                }
                
                // Restore input
                this.state.messageInput = originalMessage;
                
                throw new Error(`Failed to send message: ${errorMessage}`);
            }
            
            console.log("[WA][Action] ✅ Message sent successfully:", result);
            
            // Note: The actual message will arrive via socket event and replace the optimistic one
            // We keep the optimistic message for now, socket handler will dedupe by real message ID
            
            // Update chat metadata (last message)
            const chatIndex = this._conversationMap.get(selected.conversation_id);
            if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                const chat = this.state.conversations[chatIndex];
                chat.last_message_content = originalMessage;
                chat.last_message_type = 'chat';
                chat.last_activity = optimisticMessage.timestamp;
                
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
            console.error("[WA][Action] ❌ Error sending message:", error);
            console.error("[WA][Action] Error details:", error.message, error.stack);
            
            // Show error to user (you can add a toast/notification here)
            // For now, we just log it - input was already cleared, optimistic message was removed
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
    
    getEmojis() {
        return ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣"];
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
        
        console.warn("[WA][Action] ⚠️ Could not normalize phone number:", phoneInput, "->", cleaned);
        return cleaned; // Return anyway, validation will catch it
    }
    
    handleChatUpdate(chatData) {
        // Handle real-time chat updates from Socket.IO (Option B: append with lookup map)
        // chatData format: { id, chatId, name, profilePicture, unreadCount, timestamp, latestMessage, ... }
        console.log("[WA][Action] 📱 Chat update received:", chatData);
        
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
            
            console.log("[WA][Action] ✅ Updated and moved chat to top:", chatId);
        } else {
            // New chat: add to top
            this.state.conversations.unshift(updatedChat);
            this._conversationMap.set(chatId, 0);
            // Shift all other indices in map
            for (let i = 1; i < this.state.conversations.length; i++) {
                const cid = this.state.conversations[i].conversation_id;
                if (cid) this._conversationMap.set(cid, i);
            }
            console.log("[WA][Action] ✅ Added new chat to top:", chatId);
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
            console.log("[WA][Action] ⚠️ Could not find conversation for message:", msgId, "from:", from, "to:", to);
            return;
        }
        
        const targetChatId = targetConversation.conversation_id || targetConversation.id;
        const selected = this.state.selectedConversation;
        const isSelected = selected && (selected.conversation_id === targetChatId || selected.id === targetChatId);
            
        // Map message to UI format
        const direction = msg.fromMe ? 'outbound' : 'inbound';
        let status = 'sent';
        if (typeof msg.ack === 'number') {
            if (msg.ack >= 3) status = 'delivered';
            else if (msg.ack >= 2) status = 'delivered';
            else if (msg.ack >= 1) status = 'sent';
        }
        
        const mappedMessage = {
            id: msgId,
            content: msg.body || msg.text || '',
            direction,
            msg_timestamp: msg.timestamp || msg.createdAt || msg.time,
            message_type: msg.messageType || msg.type || 'text',
            status,
            timestamp: (msg.timestamp || msg.createdAt || msg.time),
            type: (msg.messageType || msg.type || 'text'),
        };
        
        // If message belongs to currently open conversation, append if not exists
        if (isSelected) {
            if (!this._messageIdSet.has(msgId)) {
                // Check if we have an optimistic message (temp ID) for this message
                // Match by content and direction for outbound messages
                if (mappedMessage.direction === 'outbound') {
                    const optimisticIndex = this.state.messages.findIndex(m => 
                        m.id && m.id.startsWith('temp_') && 
                        m.content === mappedMessage.content &&
                        m.direction === 'outbound'
                    );
                    
                    if (optimisticIndex >= 0) {
                        // Replace optimistic message with real one
                        const tempId = this.state.messages[optimisticIndex].id;
                        this.state.messages[optimisticIndex] = mappedMessage;
                        this._messageIdSet.delete(tempId);
                        this._messageIdSet.add(msgId);
                        
                        console.log("[WA][Action] ✅ Replaced optimistic message with real message:", msgId);
                    } else {
                        // Add new message
                        this.state.messages.push(mappedMessage);
                        this._messageIdSet.add(msgId);
                        console.log("[WA][Action] ✅ Appended message to open chat:", msgId);
                    }
                } else {
                    // Inbound message - just add it
                    this.state.messages.push(mappedMessage);
                    this._messageIdSet.add(msgId);
                    console.log("[WA][Action] ✅ Appended inbound message to open chat:", msgId);
                }
                
                // Re-sort to ensure chronological order (oldest->newest)
                this.state.messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                
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
                console.log("[WA][Action] ⚠️ Message already exists, skipping:", msgId);
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
                
                console.log("[WA][Action] ✅ Updated and moved chat to top due to new message:", targetChatId);
            } else {
                // Chat is already at top, just log the update
                console.log("[WA][Action] ✅ Updated chat metadata (already at top):", targetChatId);
            }
        } else {
            console.warn("[WA][Action] ⚠️ Could not find chat in conversations array to update:", {
                targetChatId,
                conversation_id: targetConversation.conversation_id,
                id: targetConversation.id,
                totalConversations: this.state.conversations.length
            });
        }
        
        // Apply search filter
        this.filterConversations();
    }
}

// Register the client action
registry.category("actions").add("whatsapp_web_client_action", WhatsAppWebClientAction);

