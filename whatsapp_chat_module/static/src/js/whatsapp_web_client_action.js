/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import socketService from "./socket_service";

export class WhatsAppWebClientAction extends Component {
    static template = "whatsapp_chat_module.whatsapp_web_template";
    
    setup() {
        super.setup();
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.rpc = useService("rpc");
        this.userService = useService("user");
        // Backend API URL - configurable via Odoo config or fallback to default
        this.backendApiUrl = this.env?.services?.config?.whatsapp_backend_url || 'http://localhost:4000';
        this.apiKey = null;
        this.phoneNumber = null;
        
        this.state = useState({
            showConnectionSelector: false,
            showQRModal: false,
            stage: 'boot',
            qrImage: null,
            banner: '',
            error: '',
            needsAuth: false,
            canSendMessages: false,
            connections: [],
            selectedConnection: null,
            conversations: [],
            filteredConversations: [],
            selectedConversation: null,
            messages: [],
            searchTerm: "",
            messageInput: "",
            isLoading: false,
            switchingConnection: false,
            showEmojiPanel: false,
            showContactsPopup: false,
            contactSharingMode: false,
            selectedContactsForSharing: [],
            contacts: [],
            contactsSearchTerm: "",
            // showLocationPicker: false,
            // locationMap: null,
            // locationMarker: null,
            // locationSearchQuery: "",
            // selectedLocation: null,
            isLoadingContacts: false,
            pagination: { pageIndex: 1, pageSize: 50, hasMore: true, isLoadingMore: false },
            messagePagination: { pageIndex: 1, pageSize: 50, hasMore: true, isLoadingMore: false },
            isLoadingMessages: false,
            selectedMedia: null,
            mediaUploading: false,
            editingMessageId: null,
            showAttachmentMenu: false,
            attachmentPickerType: 'all',
            showMobileSidebar: false,
            pendingRequests: [],
            showMessageContextMenu: false,
            contextMenuMessage: null,
            contextMenuPosition: { x: 0, y: 0 },
            showDeleteSubmenu: false,
            showReactionPicker: false,
            showFullReactionPicker: false,
        });
        
        // Show sidebar by default on mobile when no conversation is selected
        if (typeof window !== 'undefined' && window.innerWidth <= 768 && !this.state.selectedConversation) {
            this.state.showMobileSidebar = true;
        }
        
        this._lastMessagesFetchTs = 0;
        this._conversationMap = new Map();
        this._messageIdSet = new Set();
        this._scrollDebounceTimer = null;
        this._creatingLeadMessageId = null;
        this._unsubscribe = [];
        this._setupSocketListeners();
        this.loadData();
    }

    _setupSocketListeners() {
        this._unsubscribe.push(socketService.on('status', async (data) => {
            
            try {
                if(data.type === "qr_code"){
                    this._handleQRCode(data.data)
                }
                const type = data?.type || data?.status;
                this.state.connectionStatus = type || 'unknown';
                if (type === 'authenticated') {
                    this.state.banner = 'Authenticated, preparing…';
                } else if (type === 'ready') {
                    this.state.banner = '';
                    this.state.stage = 'ready';
                    this.state.qrImage = null;
                    this.state.showQRModal = false;
                    this.state.canSendMessages = true;
                    this.state.isLoading = false;
                    this.updateConnectionStatuses();
                    // Process all pending requests when connection is ready
                    const pendingRequests = [...this.state.pendingRequests];
                    this.state.pendingRequests = [];
                    
                    for (let index = 0; index < pendingRequests.length; index++) {
                        const element = pendingRequests[index];
                        
                        try {
                            if(element.type === 'loadConversations'){
                                await this.loadConversations(element.resetPagination !== false);
                            }
                            else if(element.type === 'loadMessages'){
                                await this.loadMessages(element.chatId, element.reset !== false);
                            }
                            else if(element.type === 'loadContacts'){
                                await this.loadContacts(element.pageIndex, element.pageSize, { append: element.append || false });
                            }
                            else if(element.type === 'sendMessage'){
                                // Ensure the conversation is still selected
                                if(element.chatId){
                                    const conversation = this.state.conversations.find(c => c.id === element.chatId);
                                    if(conversation && (!this.state.selectedConversation || this.state.selectedConversation?.id !== element.chatId)){
                                        this.state.selectedConversation = conversation;
                                    }
                                }
                                // Restore the state and call sendMessage again
                                if(this.state.selectedConversation){
                                    this.state.messageInput = element.messageText || '';
                                    if(element.selectedMedia){
                                        this.state.selectedMedia = element.selectedMedia;
                                    }
                                    await this.sendMessage();
                                } else {
                                    console.warn(`[WA] Cannot retry sendMessage: conversation ${element.chatId} not found`);
                                }
                            }
                            else if(element.type === 'saveEdit'){
                                // Restore editing state and call saveEdit again
                                this.state.editingMessageId = element.messageId;
                                this.state.messageInput = element.messageText;
                                await this.saveEdit();
                            }
                            else if(element.type === 'reactToMessage'){
                                // Retry reaction
                                await this.sendReaction(element.messageId, element.reaction);
                            }
                            else if(element.type === 'deleteMessage'){
                                // Retry delete
                                await this.deleteMessage(element.messageId, element.everyone !== undefined ? element.everyone : false);
                            }
                            else {
                                // Fallback for old format (backward compatibility)
                                if(element.method === 'GET' && element.url && element.url.includes('api/chat')){
                                    await this.loadConversations(element.pageIndex == 1);
                                }else if(element.method === 'GET' && element.url && element.url.includes('api/message')){
                                    await this.loadMessages(element.chatId, true);
                                }else if(element.method === 'GET' && element.url && element.url.includes('api/contact')){
                                    await this.loadContacts(element.pageIndex || 1, element.pageSize || 50, { append: element.append || false });
                                }else if(element.method && element.url){
                                    // For other requests, try to fetch directly (may not work for FormData)
                                    await fetch(element.url, { 
                                        method: element.method, 
                                        headers: element.headers, 
                                        body: element.body 
                                    });
                                }
                            }
                        } catch (error) {
                            console.error(`[WA] Error retrying pending request ${element.type || element.method || 'unknown'}:`, error);
                        }
                    }

                } else if (type === 'disconnected') {
                    this.state.canSendMessages = false;
                    this.state.banner = 'Disconnected. Please re-scan.';
                    this.state.stage = this.state.stage === 'ready' ? 'qr' : this.state.stage;
                    // this.state.showQRModal = true;
                    this.updateConnectionStatuses();
                } else if (type === 'qr_code_mismatch') {
                    try {
                        this._handlePhoneMismatch(data);
                    } catch (error) {
                        console.error("[WA] Error in phone mismatch handler:", error.message || error);
                    }
                } else if (type === 'auth_failure') {
                    this.state.error = data?.message || 'Authentication failed';
                    this.state.needsAuth = true;
                }
            } catch (error) {
                console.error("[WA] Error in status handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('connect', () => {
            try {
                this.updateConnectionStatuses();
            } catch (error) {
                console.error("[WA] Error in connect handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('disconnect', () => {
            try {
                this.updateConnectionStatuses();
            } catch (error) {
                console.error("[WA] Error in disconnect handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('chat', (chatData) => {
           
            try {
                this.handleChatUpdate(chatData);
            } catch (error) {
                console.error("[WA] Error in chat handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('message', (messageData) => {
            try {
                this.handleMessageEvent(messageData);
            } catch (error) {
                console.error("[WA] Error in chat handler:", error.message || error);
            }
        }));
      
       
        this._unsubscribe.push(socketService.on('contact', (contactData) => {
            
            try {
                this.handleContactEvent(contactData);
            } catch (error) {
                console.error("[WA] Error in contact handler:", error.message || error);
            }
        }));
    }

    _handleQRCode(data) {
        const img = typeof data === 'string' ? data : (data?.qrCode || '');
        if (img) {
            this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
        }
        this.state.stage = 'qr';
        // this.state.showQRModal = true;
        // this.state.isLoading = false;
    }

    _handlePhoneMismatch(data) {
        const img = data?.data?.qrCode || '';
        if (img) {
            this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
        }
        this.state.error = data?.message || 'Phone mismatch. Please scan with the correct number.';
        this.state.stage = 'qr';
        // this.state.showQRModal = true;
        // this.state.isLoading = false;
    }

    mounted() {
        setTimeout(() => this._attachScrollListener(), 100);
    }
    
    _attachScrollListener() {
        if (this._onMessagesScroll && this._messagesContainer) {
            this._messagesContainer.removeEventListener('scroll', this._onMessagesScroll);
        }
        const container = this.refs?.messagesContainer || document.querySelector('.messages-container');
        if (!container) return;
        this._messagesContainer = container;
        this._onMessagesScroll = () => {
            if (this._scrollDebounceTimer) clearTimeout(this._scrollDebounceTimer);
            this._scrollDebounceTimer = setTimeout(() => {
                const scrollThreshold = 50;
                const isNearTop = container.scrollTop <= scrollThreshold;
                const hasScrollableContent = container.scrollHeight > container.clientHeight;
                const canLoadMore = !this.state.messagePagination.isLoadingMore && this.state.messagePagination.hasMore;
                if (isNearTop && hasScrollableContent && canLoadMore) {
                    this.loadMoreMessages();
                }
            }, 100);
        };
        container.addEventListener('scroll', this._onMessagesScroll, { passive: true });
    }

    willUnmount() {
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
    
    async loadData() {
        this.state.isLoading = true;
        try {
            try {
                const backendUrl = await this.orm.call('ir.config_parameter', 'get_param', ['whatsapp_chat_module.backend_api_url', 'http://localhost:3000']);
                this.backendApiUrl = backendUrl;
            } catch(e){
                console.warn("[WA] Failed to get backend URL from config, using default:", e);
                this.backendApiUrl = 'http://localhost:4000';
            }
            let connections = [];
            try {
                connections = await Promise.race([
                    this.orm.searchRead("whatsapp.connection", [], ["name", "from_field", "api_key", "is_default", "socket_connection_ready"]),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Connection fetch timeout")), 10000))
                ]);
            } catch (error) {
                connections = [];
            }
            this.state.connections = (connections || []).map(conn => ({
                ...conn,
                phone_number: conn.from_field,
                connection_status: this.getConnectionStatus(conn)
            }));
            let userDefaultConnectionId = null;
            try {
                const currentUserId = this.userService.userId;
                if (currentUserId) {
                    const currentUser = await this.orm.searchRead("res.users", [["id", "=", currentUserId]], ["whatsapp_default_connection_id"]);
                    if (currentUser && currentUser.length > 0 && currentUser[0].whatsapp_default_connection_id) {
                        userDefaultConnectionId = currentUser[0].whatsapp_default_connection_id[0];
                    }
                }
            } catch (error) {
                console.error("[WA] Error loading user default connection:", error.message || error);
            }
            let defaultConnection = null;
            if (userDefaultConnectionId) {
                defaultConnection = connections.find(c => c.id === userDefaultConnectionId);
            }
            if (!defaultConnection) {
                defaultConnection = connections.find(c => c.is_default);
            }
            if (defaultConnection) {
                this.state.selectedConnection = defaultConnection;
                this.updateConnectionStatuses();
                if (defaultConnection.api_key && defaultConnection.from_field) {
                    let phoneNumber = defaultConnection.from_field;
                    this.apiKey = defaultConnection.api_key.trim();
                    this.phoneNumber = phoneNumber;
                    socketService.setAuthCredentials(this.apiKey, this.phoneNumber, window.location.origin);
                    socketService.connect().then(() => {
                        this.updateConnectionStatuses();
                    }).catch((e) => {
                        this.updateConnectionStatuses();
                    });
                    try {
                        await this.loadConversations(true);
                        this.state.stage = 'ready';
                        // this.state.isLoading = false;
                        return;
                    } catch (convErr) {
                        console.error("[WA] Error loading conversations on init:", convErr.message || convErr);
                    }
                }
            } else {
                if (connections.length > 0) {
                    const firstConnection = connections[0];
                    await this.selectConnection(firstConnection.id);
                } else {
                    this.state.error = "No WhatsApp connections configured. Please create a connection first.";
                }
            }
        } catch (error) {
            if (!error.message || !error.message.includes("timeout")) {
                console.error("[WA] Error loading data:", error.message || error);
            }
            this.state.connections = this.state.connections || [];
            this.state.conversations = this.state.conversations || [];
        } finally {
            if (this.state.stage !== 'ready' && this.state.stage !== 'qr') {
                // this.state.isLoading = false;
            }
            if (this.state.update) {
                this.state.update();
            }
        }
    }
    
    async loadConversations(resetPagination = false) {
        try {
            if (resetPagination) {
                this.state.pagination.pageIndex = 1;
                this.state.conversations = [];
            }
            const { pageIndex, pageSize } = this.state.pagination;
            if (!this.apiKey || !this.phoneNumber) {
                this.state.conversations = [];
                this.state.filteredConversations = [];
                return;
            }
            let normalizedPhone = this.phoneNumber.trim();
            if (!normalizedPhone.match(/^\+[1-9]\d{0,2}\s\d{4,14}$/)) {
                throw new Error(`Invalid phone number format: ${normalizedPhone}. Expected: +CC NNN... (with space)`);
            }
            const pageIndexNum = parseInt(pageIndex, 10);
            const pageSizeNum = parseInt(pageSize, 10);
            if (isNaN(pageIndexNum) || pageIndexNum < 1) {
                throw new Error(`Invalid pageIndex: ${pageIndex}. Must be a positive integer >= 1`);
            }
            if (isNaN(pageSizeNum) || pageSizeNum < 1) {
                throw new Error(`Invalid pageSize: ${pageSize}. Must be a positive integer >= 1`);
            }
            const url = new URL(`${this.backendApiUrl}/api/chat`);
            url.searchParams.append('pageIndex', pageIndexNum.toString());
            url.searchParams.append('pageSize', pageSizeNum.toString());
            url.searchParams.append('hasPagination',true);
            const headers = {
                'x-api-key': this.apiKey.trim(),
                'x-phone-number': this.phoneNumber.trim(),
                'Content-Type': 'application/json',
            };
            const response = await fetch(url.toString(), { method: 'GET', headers });
            const result = await this._parseResponse(response);

            if (!response.ok) {
                const errorMessage = result.message || result.error || response.statusText;
                throw new Error(`HTTP ${response.status}: ${errorMessage}`);
            }
            if(this.state.isLoading && response.status === 200){
                this.state.isLoading = false;
            }
            if (!result.success) {
                throw new Error(result.message || 'Failed to load chats');
            }
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'loadConversations',
                    pageIndex: pageIndexNum,
                    resetPagination: resetPagination
                });
            }
            else{
            const { items, meta } = result.data || {};
            const conversations = items || [];
            const hasMore = meta?.hasNextPage || false;
            const mappedConversations = conversations.map(chat => this._mapBackendChatToConversation(chat));
            if (resetPagination || pageIndex === 1) {
                this.state.conversations = mappedConversations;
            } else {
                const existingIds = new Set(this.state.conversations.map(c => c.id));
                const newConversations = mappedConversations.filter(c => !existingIds.has(c.id));
                this.state.conversations = [...this.state.conversations, ...newConversations];
            }
            this.state.conversations.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
            this._rebuildConversationMap();
            this.state.pagination.hasMore = hasMore;
            this.state.pagination.pageIndex = meta?.pageIndex || pageIndex;
            this.state.pagination.isLoadingMore = false;
            this.filterConversations();
        }
        } catch (error) {
            console.error("[WA] Error loading conversations:", error.message || error);
            this.state.conversations = [];
            this.state.filteredConversations = [];
            this.state.pagination.isLoadingMore = false;
            if (error.message && !error.message.includes('Invalid phone number format')) {
                this.state.error = 'Failed to load conversations. Please try again.';
            }
        }
    }

    _mapBackendChatToConversation(chat) {
        const latest = chat.latestMessage || {};
        let preview = latest.body || chat.latestMessage || "";
        if (latest.messageType) {
            switch (latest.messageType) {
                case "chat":
                case "text":
                    preview = latest.body || preview || "";
                    break;
                case "document":
                    preview = `📄 ${latest.fileName || "Document"}`;
                    break;
                case "image":
                    preview = "📷 Photo";
                    break;
                case "video":
                    preview = "🎥 Video";
                    break;
                case "audio":
                    preview = "🎵 Audio";
                    break;
                case "location": {
                    const location = latest.location || {};
                    const address = location.address;
                    if (address) {
                        preview = `📍 ${address}`;
                    } else {
                        preview = "📍 Location";
                    }
                    break;
                    
                }
                case "multi_vcard":
                case "vcard": {
                    // Get first contact name
                    let contactName = "";
                    if (latest.contacts && Array.isArray(latest.contacts) && latest.contacts.length > 0) {
                        const firstContact = latest.contacts[0];
                        contactName = firstContact.fullName || firstContact.name || firstContact.pushname || "";
                    } else if (latest.vcards) {
                        // Parse vcards if needed
                        const parsed = this.getParsedVcards(latest);
                        if (parsed && parsed.length > 0) {
                            const firstContact = parsed[0];
                            contactName = firstContact.fullName || firstContact.name || firstContact.pushname || "";
                        }
                    }
                    if (contactName) {
                        preview = `👤 ${contactName}`;
                    } else {
                        preview = "👤 Contact";
                    }
                    break;
                }
                default:
                    preview = latest.body || preview || "";
            }
        }
        // Determine direction of latest message
        const latestMessageDirection = latest.fromMe ? 'outbound' : (latest.direction || (latest.fromMe === false ? 'inbound' : null));                                                                                 
        return {
            ...chat,
            latestMessage: preview,
            latestMessageId: latest.id || chat.latestMessageId,
            latestMessageAck: latest.ack ? parseInt(latest.ack, 10) : 0,
            latestMessageDirection: latestMessageDirection || 'inbound', // Default to inbound if not specified
            timestamp: latest.timestamp || chat.timestamp,
            lastMessageType: latest.messageType || chat.lastMessageType,
        };
    }

    async _parseResponse(response) {
        try {
            return await response.json();
        } catch (parseError) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${text}`);
        }
    }

    _getApiHeaders() {
        if (!this.apiKey || !this.phoneNumber) {
            throw new Error('API credentials not available');
        }
        return {
            'x-api-key': this.apiKey.trim(),
            'x-phone-number': this.phoneNumber.trim(),
        };
    }
    
    filterConversations() {
        const searchTerm = (this.state.searchTerm || "").toLowerCase().trim();
        if (!searchTerm) {
            this.state.filteredConversations = [...this.state.conversations];
        } else {
            this.state.filteredConversations = this.state.conversations.filter(conv => {
                const name = (conv.name || "").toLowerCase();
                const phone = (conv.contact_phone || "").toLowerCase();
                // const lastMessage = (conv.latestMessage || latestMessageId).toLowerCase();
                return name.includes(searchTerm) || phone.includes(searchTerm);
            });
        }
    }
    
    onSearchInput(event) {
        this.state.searchTerm = event.target.value;
        this.filterConversations();
    }
    
    async loadMoreConversations() {
        if (this.state.pagination.isLoadingMore || !this.state.pagination.hasMore) return;
        this.state.pagination.isLoadingMore = true;
        this.state.pagination.pageIndex += 1;
        try {
            await this.loadConversations(false);
        } catch (error) {
            console.error("[WA] Error loading more conversations:", error.message || error);
            this.state.pagination.pageIndex = Math.max(1, this.state.pagination.pageIndex - 1);
        } finally {
            this.state.pagination.isLoadingMore = false;
        }
    }
    
    async selectConnection(connectionId) {
        const connection = this.state.connections.find(c => c.id === connectionId);
        if (connection) {
            this.state.error = '';
            this.state.qrImage = null;
            // this.state.showQRModal = false;
            this.state.isLoading = false;
            this.state.switchingConnection = true;
            this.state.selectedConnection = connection;
            this.state.showConnectionSelector = false;
            this.updateConnectionStatuses();
            this.state.selectedConversation = null;
            // Show sidebar when conversation is cleared (on mobile)
            this.updateMobileSidebarVisibility();
            this.state.messages = [];
            this._messageIdSet.clear();
            this.state.conversations = [];
            this.state.filteredConversations = [];
            try {
                if (connection.api_key && connection.from_field) {
                    let phoneNumber = connection.from_field;
                    if (!phoneNumber) {
                        this.state.isLoading = false;
                        this.state.switchingConnection = false;
                        return;
                    }
                    this.apiKey = connection.api_key.trim();
                    this.phoneNumber = phoneNumber;
                    socketService.setAuthCredentials(this.apiKey, this.phoneNumber, this.clientOrigin || window.location.origin);
                    if (socketService.socket) {
                        socketService.socket.disconnect();
                    }
                    try {
                        await socketService.connect();
                        this.updateConnectionStatuses();
                    } catch (e) {
                        console.error("[WA] Socket reconnection failed:", e.message || e);
                        this.state.error = 'Failed to reconnect socket. Please try again.';
                        this.updateConnectionStatuses();
                    }
                }
                await this.loadConversations(true);
                this.state.switchingConnection = false;
                this.state.stage = 'ready';
                this.state.canSendMessages = true;
            } catch (error) {
                console.error("[WA] Error switching connection:", error.message || error);
                this.state.error = error.message || 'Failed to switch connection. Please try again.';
                this.state.stage = 'ready';
            } finally {
                this.state.switchingConnection = false;
            }
        }
    }
    
    showConnectionSelector() {
        this.state.showConnectionSelector = true;
    }
    
    closeQRModal() { 
        this.state.showQRModal = false;
    }
    
    async selectConversation(conversationId) {
        const conversation = this.state.filteredConversations.find(c => c.id === conversationId) ||
                             this.state.conversations.find(c => c.id === conversationId);
        if (conversation) {
            conversation.unreadCount = 0;
            const chatIndex = this._conversationMap.get(conversation.id);
            if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                this.state.conversations[chatIndex].unreadCount = 0;
            }
            this.state.selectedConversation = conversation;
            this.state.messagePagination.pageIndex = 1;
            this.state.messagePagination.pageSize = 50;
            this.state.messagePagination.hasMore = true;
            this.state.messagePagination.isLoadingMore = false;
            this.state.messages = [];
            this._messageIdSet.clear();
            this.loadMessages(conversationId, true);
            this.filterConversations();
            
            // Update mobile sidebar visibility when chat is selected
            this.updateMobileSidebarVisibility();
        }
    }
    
    toggleMobileSidebar() {
        this.state.showMobileSidebar = !this.state.showMobileSidebar;
    }
    
    // Method to update mobile sidebar visibility based on conversation state
    updateMobileSidebarVisibility() {
        if (typeof window !== 'undefined' && window.innerWidth <= 768) {
            // Show sidebar if no conversation is selected, hide if conversation is selected
            this.state.showMobileSidebar = !this.state.selectedConversation;
        }
    }
    
    closeMobileSidebar() {
        // Only close if there's a conversation selected
        // If no conversation, keep sidebar open (user needs to see chat list)
        if (this.state.selectedConversation) {
            this.state.showMobileSidebar = false;
        }
    }
    
    toggleContactsPopup() {
        this.state.showContactsPopup = !this.state.showContactsPopup;
        if (this.state.showContactsPopup && this.state.contacts.length === 0) {
            this.loadContacts(1, 50, { append: false });
        } else if (!this.state.showContactsPopup) {
            // Reset sharing mode when closing
            this.state.contactSharingMode = false;
            this.state.selectedContactsForSharing = [];
        }
    }
    
    async loadContacts(pageIndex = 1, pageSize = 50, { append = false } = {}) {
        if (this.state.isLoadingContacts) return;
        this.state.isLoadingContacts = true;
        try {
            if (!this.apiKey || !this.phoneNumber) {
                if (!append) this.state.contacts = [];
                return;
            }
            const baseUrl = this.backendApiUrl || "http://localhost:3000";
            const url = new URL(`${baseUrl}/api/contact`);
            url.searchParams.append('pageIndex', String(pageIndex));
            url.searchParams.append('pageSize', String(pageSize));
            let headers;
            try {
                headers = this._getApiHeaders();
            } catch (error) {
                this.state.isLoadingContacts = false;
                this.state.error = 'API credentials not available. Please reconnect.';
                return;
            }
            const response = await fetch(url.toString(), { method: 'GET', headers });
            const result = await this._parseResponse(response);
            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to load contacts');
            }
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'loadContacts',
                    pageIndex: pageIndex,
                    pageSize: pageSize,
                    append: append
                });
                this.state.isLoadingContacts = false;
                return;
            }
            const contactsPayload = result.data?.items || [];
            const contacts = contactsPayload.map(c => ({
                ...c,  // Pass through all backend fields
                // Add aliases for backward compatibility if needed
                display_name: c.name,  // For template compatibility
                phone_number: c.phoneNumber,  // For template compatibility
                profile_picture: c.profilePicture,  // For template compatibility
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
            console.error("[WA] Error loading contacts:", error.message || error);
            if (!append) {
                this.state.contacts = [];
                this.state.contactsMeta = { pageIndex: 1, pageSize, totalCount: 0, totalPages: 0, hasPreviousPage: false, hasNextPage: false };
            }
            this.state.error = 'Failed to load contacts. Please try again.';
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
        this.state.contactsSearchTerm = (ev.target.value || '').toLowerCase().trim();
    }
    
    getFilteredContacts() {
        const searchTerm = (this.state.contactsSearchTerm || '').toLowerCase().trim();
        if (!searchTerm) return this.state.contacts;
        return this.state.contacts.filter(contact => {
            const name = (contact.name || contact.pushname || '').toLowerCase();
            const phone = (contact.phoneNumber || '').toLowerCase();
            return name.includes(searchTerm) || phone.includes(searchTerm);
        });
    }
    
    isContactSelected(contactId) {
        return this.state.selectedContactsForSharing.some(c => c.id === contactId);
    }
    
    toggleContactSelection(contact) {
        const index = this.state.selectedContactsForSharing.findIndex(c => c.id === contact.id);
        if (index >= 0) {
            this.state.selectedContactsForSharing.splice(index, 1);
        } else {
            this.state.selectedContactsForSharing.push(contact);
        }
        this.state.selectedContactsForSharing = [...this.state.selectedContactsForSharing];
    }
    
    async shareContacts() {
        if (this.state.selectedContactsForSharing.length === 0) return;
        
        this.state.showContactsPopup = false;
        this.state.contactsSearchTerm = "";
        this.state.contactSharingMode = false;
        
        if (!this.state.selectedConversation) return;
        
        try {
            this.state.selectedMedia = {
                type: 'multi_vcard',
                contacts: [...this.state.selectedContactsForSharing],
                preview: null
            };
            this.state.selectedContactsForSharing = [];
            await this.sendMessage();
        } catch (error) {
            console.error("[WA] Error sharing contacts:", error.message || error);
            this.state.error = 'Failed to share contacts. Please try again.';
        }
    }
    
    parseSimpleVCard(vcard) {
        if (!vcard || typeof vcard !== 'string') return { fullName: null, phoneNumber: null };
        
        const lines = vcard.split(/\r?\n/);
        let fullName = null;
        let phoneNumber = null;
        
        for (const line of lines) {
            if (line.startsWith("FN:")) {
                fullName = line.replace("FN:", "").trim();
            } else if (line.startsWith("TEL")) {
                phoneNumber = line.split(":")[1]?.trim() || null;
            }
            if (fullName && phoneNumber) break; // Early exit if both found
        }
        
        return { fullName, phoneNumber };
    }
    
    getParsedVcards(message) {
        if (message.contacts && Array.isArray(message.contacts)) {
            return message.contacts;
        }
        
        if (!message.vcards) return [];
        
        if (typeof message.vcards === 'string') {
            const parsed = this.parseSimpleVCard(message.vcards);
            return parsed.fullName || parsed.phoneNumber ? [parsed] : [];
        }
        
        if (Array.isArray(message.vcards)) {
            return message.vcards
                .map(vcard => typeof vcard === 'string' ? this.parseSimpleVCard(vcard) : vcard)
                .filter(vcard => vcard && (vcard.fullName || vcard.phoneNumber));
        }
        
        return [];
    }
    
    // async openLocationPicker() {
    //     this.state.showLocationPicker = true;
    //     this.state.selectedLocation = null;
    //     this.state.locationSearchQuery = "";
        
    //     // Wait longer for modal to be fully rendered and visible
    //     setTimeout(() => this.initLocationMap(), 300);
    // }
    
    // closeLocationPicker() {
    //     this.state.showLocationPicker = false;
    //     this.state.selectedLocation = null;
    //     this.state.locationSearchQuery = "";
    //     if (this.state.locationMap) {
    //         this.state.locationMap.remove();
    //         this.state.locationMap = null;
    //         this.state.locationMarker = null;
    //     }
    // }
    
    // initLocationMap() {
    //     // Use document.querySelector for modal elements (they might be in a portal)
    //     const mapContainer = document.querySelector('#location-map-container');
    //     if (!mapContainer) {
    //         setTimeout(() => this.initLocationMap(), 100);
    //         return;
    //     }
        
    //     // Check if container is visible and has dimensions
    //     const rect = mapContainer.getBoundingClientRect();
    //     if (rect.width === 0 || rect.height === 0) {
    //         console.log('[WA] Map container has no dimensions, retrying...');
    //         setTimeout(() => this.initLocationMap(), 100);
    //         return;
    //     }
        
    //     if (typeof L === 'undefined') {
    //         this.loadLeafletLibrary().then(() => {
    //             setTimeout(() => this.initLocationMap(), 100);
    //         }).catch(err => {
    //             console.error('[WA] Failed to load Leaflet:', err);
    //             this.state.error = 'Failed to load map. Please refresh the page.';
    //         });
    //         return;
    //     }
        
    //     if (this.state.locationMap) {
    //         this.state.locationMap.remove();
    //         this.state.locationMap = null;
    //     }
        
    //     try {
    //         // Initialize map centered on a default location
    //         const defaultCenter = [20.5937, 78.9629]; // India center
    //         this.state.locationMap = L.map('location-map-container', {
    //             center: defaultCenter,
    //             zoom: 10,
    //             zoomControl: true
    //         });
            
    //         L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    //             attribution: '© OpenStreetMap contributors',
    //             maxZoom: 19
    //         }).addTo(this.state.locationMap);
            
    //         // Wait for map to be ready before adding handlers
    //         this.state.locationMap.whenReady(() => {
    //             // Invalidate size to ensure map renders correctly
    //             setTimeout(() => {
    //                 this.state.locationMap.invalidateSize();
    //             }, 100);
                
    //             // Add click handler
    //             this.state.locationMap.on('click', (e) => {
    //                 this.selectLocationFromMap(e.latlng.lat, e.latlng.lng);
    //             });
                
    //             // Try to get current location after map is ready
    //             this.getCurrentLocation();
    //         });
    //     } catch (error) {
    //         console.error('[WA] Error initializing map:', error);
    //         this.state.error = 'Failed to initialize map. Please try again.';
    //     }
    // }
    
    // loadLeafletLibrary() {
    //     return new Promise((resolve, reject) => {
    //         if (typeof L !== 'undefined') {
    //             resolve();
    //             return;
    //         }
            
    //         // Check if already loading
    //         if (document.querySelector('link[href*="leaflet"]') || document.querySelector('script[src*="leaflet"]')) {
    //             let attempts = 0;
    //             const checkInterval = setInterval(() => {
    //                 attempts++;
    //                 if (typeof L !== 'undefined') {
    //                     clearInterval(checkInterval);
    //                     resolve();
    //                 } else if (attempts > 50) { // 5 seconds
    //                     clearInterval(checkInterval);
    //                     reject(new Error('Leaflet failed to load'));
    //                 }
    //             }, 100);
    //             return;
    //         }
            
    //         // Load Leaflet CSS
    //         const link = document.createElement('link');
    //         link.rel = 'stylesheet';
    //         link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    //         link.crossOrigin = '';
    //         document.head.appendChild(link);
            
    //         // Load Leaflet JS
    //         const script = document.createElement('script');
    //         script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    //         script.crossOrigin = '';
    //         script.onload = () => {
    //             // Wait a bit for L to be fully available
    //             setTimeout(() => {
    //                 if (typeof L !== 'undefined') {
    //                     resolve();
    //                 } else {
    //                     reject(new Error('Leaflet loaded but L is undefined'));
    //                 }
    //             }, 100);
    //         };
    //         script.onerror = () => reject(new Error('Failed to load Leaflet script'));
    //         document.head.appendChild(script);
    //     });
    // }
    
    // async getCurrentLocation() {
    //     if (!this.state.locationMap) {
    //         console.warn('[WA] Map not initialized yet');
    //         return;
    //     }
        
    //     if (!navigator.geolocation) {
    //         this.state.error = 'Geolocation is not supported by your browser.';
    //         return;
    //     }
        
    //     try {
    //         const position = await new Promise((resolve, reject) => {
    //             navigator.geolocation.getCurrentPosition(resolve, reject, {
    //                 enableHighAccuracy: true,
    //                 timeout: 10000,
    //                 maximumAge: 0
    //             });
    //         });
            
    //         const lat = position.coords.latitude;
    //         const lng = position.coords.longitude;
            
    //         if (this.state.locationMap) {
    //             this.state.locationMap.setView([lat, lng], 15);
    //             await this.selectLocationFromMap(lat, lng);
    //         }
    //     } catch (error) {
    //         console.error('[WA] Error getting current location:', error);
    //         // Continue without current location
    //     }
    // }
    
    // async selectLocationFromMap(lat, lng) {
    //     // Update marker
    //     if (this.state.locationMarker) {
    //         this.state.locationMarker.setLatLng([lat, lng]);
    //     } else {
    //         this.state.locationMarker = L.marker([lat, lng], {
    //             draggable: true
    //         }).addTo(this.state.locationMap);
            
    //         this.state.locationMarker.on('dragend', (e) => {
    //             const pos = e.target.getLatLng();
    //             this.selectLocationFromMap(pos.lat, pos.lng);
    //         });
    //     }
        
    //     // Reverse geocode to get address
    //     const address = await this.reverseGeocode(lat, lng);
        
    //     this.state.selectedLocation = {
    //         latitude: lat,
    //         longitude: lng,
    //         name: address.name || '',
    //         address: address.address || ''
    //     };
    // }
    
    // async reverseGeocode(lat, lng) {
    //     try {
    //         const response = await fetch(
    //             `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
    //             {
    //                 headers: {
    //                     'User-Agent': 'WhatsApp-Chat-Module'
    //                 }
    //             }
    //         );
    //         const data = await response.json();
            
    //         if (data && data.address) {
    //             const addr = data.address;
    //             const name = addr.name || addr.road || addr.city || addr.town || '';
    //             const addressParts = [
    //                 addr.road,
    //                 addr.neighbourhood,
    //                 addr.suburb,
    //                 addr.city || addr.town,
    //                 addr.state,
    //                 addr.country
    //             ].filter(Boolean);
                
    //             return {
    //                 name: name,
    //                 address: addressParts.join(', ')
    //             };
    //         }
    //     } catch (error) {
    //         console.error('[WA] Reverse geocoding error:', error);
    //     }
        
    //     return { name: '', address: '' };
    // }
    
    // async searchLocationAddress() {
    //     const query = this.state.locationSearchQuery.trim();
    //     if (!query) return;
        
    //     if (!this.state.locationMap) {
    //         this.state.error = 'Map is not ready yet. Please wait a moment.';
    //         return;
    //     }
        
    //     try {
    //         const response = await fetch(
    //             `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
    //             {
    //                 headers: {
    //                     'User-Agent': 'WhatsApp-Chat-Module'
    //                 }
    //             }
    //         );
    //         const results = await response.json();
            
    //         if (results && results.length > 0) {
    //             const first = results[0];
    //             const lat = parseFloat(first.lat);
    //             const lng = parseFloat(first.lon);
                
    //             if (this.state.locationMap) {
    //                 this.state.locationMap.setView([lat, lng], 15);
    //                 await this.selectLocationFromMap(lat, lng);
    //             }
    //         } else {
    //             this.state.error = 'Location not found. Please try a different search.';
    //         }
    //     } catch (error) {
    //         console.error('[WA] Geocoding error:', error);
    //         this.state.error = 'Failed to search location. Please try again.';
    //     }
    // }
    
    // confirmLocationSelection() {
    //     if (!this.state.selectedLocation) {
    //         this.state.error = 'Please select a location on the map.';
    //         return;
    //     }
        
    //     // Set as selected media
    //     this.state.selectedMedia = {
    //         type: 'location',
    //         location: { ...this.state.selectedLocation },
    //         preview: null
    //     };
        
    //     this.closeLocationPicker();
    // }
    
    async openChatWithContact(contact) {
        if (this.state.contactSharingMode) {
            this.toggleContactSelection(contact);
            return;
        }
        
        this.state.showContactsPopup = false;
        this.state.contactsSearchTerm = "";
        try {
            const conversation = {
                // id: contact.id,
                // name: contact.name || contact.pushname || 'Unknown',
                // profilePicture: contact.profilePicture || '/web/static/src/img/avatar.png',
                // isGroup: false,
                // unreadCount: 0,
                // // timestamp: ,
                // pinned: false,
                // isMuted: false,
                // archived: false,
                ...contact,  // Spread all contact fields (id, name, pushname, phoneNumber, profilePicture, etc.)
                isGroup: false,  // Contacts are not groups
                unreadCount: 0,  // New conversation
                timestamp: new Date().toISOString(),  // For sorting
                latestMessage: null,  // No messages yet
                pinned: false,
                isMuted: false,
                archived: false,
            };
            let existingConv = this.state.conversations.find(c => 
                c.id === conversation.id
            );
            if (!existingConv) {
                this.state.conversations.unshift(conversation);
                this._rebuildConversationMap();
            } else {
                Object.assign(existingConv, {
                    name: conversation.name || conversation.pushname,
                    phoneNumber: conversation.phoneNumber,
                    profilePicture: conversation.profilePicture,
                });
            }
            await this.selectConversation(conversation.id);
        } catch (error) {
            console.error("[WA] Error opening chat with contact:", error.message || error);
            this.state.error = 'Failed to open chat. Please try again.';
        }
    }
    
    async loadMessages(conversationId, reset = false) {
        let previousPageIndex = this.state.messagePagination.pageIndex;
        try {
            if (this.state.isLoadingMessages) return;
            this.state.isLoadingMessages = true;
            if (!this.apiKey || !this.phoneNumber) {
                this.state.isLoadingMessages = false;
                return;
            }
            const selected = this.state.selectedConversation;
            if (!selected) return;
            if (reset) {
                this.state.messagePagination.pageIndex = 1;
                this.state.messagePagination.hasMore = true;
            } else {
                this.state.messagePagination.pageIndex += 1;
            }
            const { pageIndex, pageSize } = this.state.messagePagination;
            const chatId = selected.conversation_id || selected.id || conversationId;
            const url = new URL(`${this.backendApiUrl}/api/message`);
            url.searchParams.append('chatId', chatId);
            url.searchParams.append('pageIndex', parseInt(pageIndex, 10).toString());
            url.searchParams.append('pageSize', parseInt(pageSize, 10).toString());
            url.searchParams.append('hasPagination',true);
            let headers;
            try {
                headers = { ...this._getApiHeaders(), 'Content-Type': 'application/json' };
            } catch (error) {
                this.state.isLoadingMessages = false;
                this.state.error = 'API credentials not available. Please reconnect.';
                return;
            }
            this.state.messagePagination.isLoadingMore = !reset;
            const response = await fetch(url.toString(), { method: 'GET', headers });
            const result = await this._parseResponse(response);
            if (!response.ok || !result?.success) {
                const message = result?.message || response.statusText;
                throw new Error(`HTTP ${response.status}: ${message}`);
            }
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'loadMessages',
                    chatId: chatId,
                    pageIndex: pageIndex,
                    pageSize: pageSize,
                    reset: reset
                });
                this.state.isLoadingMessages = false;
                return;
            }
            const { items = [], meta = {} } = result.data || {};
            const visibleItems = items.filter(item => !item.deletedType || item.deletedType !== 'deleted_for_me');
            const mapped = visibleItems.map((m) => this._mapBackendMessageToUI(m));
            const sortAsc = (arr) => arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
            const scrollState = reset ? null : this.captureScrollState();
            if (reset || pageIndex === 1) {

                const existingSocketMessages = this.state.messages.filter(msg => {
                
                    return msg.id && !mapped.some(m => m.id === msg.id);
                });
                
               
                const allMessages = sortAsc(mapped);
                
               
                if (existingSocketMessages.length > 0) {
                    allMessages.push(...existingSocketMessages);
                    allMessages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                }
                
                
                this.state.messages = allMessages;
                this.decorateMessagesWithDaySeparators();
                this._messageIdSet.clear();
                this.state.messages.forEach(msg => {
                    if (msg.id) this._messageIdSet.add(msg.id);
                });
            } else {
                const olderAsc = sortAsc(mapped);
                const uniqueOlderMessages = olderAsc.filter(msg => {
                    if (!msg.id) return false;
                    if (this._messageIdSet.has(msg.id)) return false;
                    this._messageIdSet.add(msg.id);
                    return true;
                });
                this.state.messages = [...uniqueOlderMessages, ...this.state.messages];
                this.decorateMessagesWithDaySeparators();
            }
            this.state.messagePagination.hasMore = meta?.hasNextPage ?? (mapped.length === pageSize);
            if (meta?.pageIndex !== undefined) {
                this.state.messagePagination.pageIndex = meta.pageIndex;
            }
            if (mapped.length === 0 && !reset) {
                this.state.messagePagination.pageIndex = Math.max(1, this.state.messagePagination.pageIndex - 1);
                this.state.messagePagination.hasMore = false;
            }
            this.state.messagePagination.isLoadingMore = false;
            this._lastMessagesFetchTs = Date.now();
            if (!reset) {
                this.restoreScrollPosition(scrollState);
            }
            if (reset) {
                this.scrollToBottom(true);
                setTimeout(() => this._attachScrollListener(), 200);
            } else {
                setTimeout(() => this._attachScrollListener(), 50);
            }
        } catch (error) {
            console.error("[WA] Error loading messages:", error.message || error);
            if (!reset && previousPageIndex !== undefined) {
                this.state.messagePagination.pageIndex = previousPageIndex;
            }
            this.state.messagePagination.isLoadingMore = false;
            if (this.state.selectedConversation) {
                this.state.error = 'Failed to load messages. Please try again.';
            }
        } finally {
            this.state.isLoadingMessages = false;
        }
    }

    buildDataUrl(fileData,mimeType){
    if(!fileData) return null;
    return `data:${mimeType};base64,${fileData}`;
    }

    _mapBackendMessageToUI(m) {
        const direction = m.fromMe ? 'outbound' : 'inbound';
        const ack = parseInt(m.ack, 10) || 0;
        let status = 'sent';
        if (ack >= 3) status = 'read';
        else if (ack >= 2) status = 'delivered';
        else if (ack >= 1) status = 'sent';
        
        const isDeleted = m.deletedType === 'deleted_for_everyone';
        // Map reactions if they exist and group by emoji
        let reactions = [];
        if (m.reactions && Array.isArray(m.reactions)) {
            // Group reactions by emoji and aggregate counts
            const reactionMap = new Map();
            m.reactions.forEach(r => {
                const emoji = r.emoji || r.reaction || '';
                if (!emoji) return;
                
                if (reactionMap.has(emoji)) {
                    const existing = reactionMap.get(emoji);
                    const newCount = r.count || (r.users ? r.users.length : 1);
                    existing.count += newCount;
                    // Merge users arrays (avoid duplicates)
                    if (r.users && Array.isArray(r.users)) {
                        r.users.forEach(userId => {
                            if (userId && !existing.users.includes(userId)) {
                                existing.users.push(userId);
                            }
                        });
                    }
                } else {
                    reactionMap.set(emoji, {
                        emoji: emoji,
                        count: r.count || (r.users ? r.users.length : 1),
                        users: r.users ? [...r.users] : []
                    });
                }
            });
            reactions = Array.from(reactionMap.values());
        }
        
        return {
            ...m,
            direction,
            mediaData: this.buildDataUrl(m.fileData,m.mimeType),
            status: status,
            ack: ack,
            reactions: reactions,
            // Add aliases for backward compatibility if needed
            isDeleted: isDeleted,
            content: m.body,  // For template compatibility
            type: m.messageType,  // For template compatibility
        };
    }

    async loadMoreMessages() {
        if (!this.state.selectedConversation) return;
        if (!this.state.messagePagination.hasMore || this.state.messagePagination.isLoadingMore) return;
        try {
            await this.loadMessages(this.state.selectedConversation.id, false);
        } catch (error) {
            console.error("[WA] Error loading more messages:", error.message || error);
        }
    }
    
    async sendMessage() {
        
        if (this.state.editingMessageId) { this.saveEdit(); return; }
        const messageText = this.state.messageInput.trim();
        const hasMedia = this.state.selectedMedia !== null;
        if ((!messageText && !hasMedia) || !this.state.selectedConversation) return;
        const selected = this.state.selectedConversation;
       
        const recipientPhone = selected.phoneNumber?.trim();
        const chatId = selected.id;
        
        // if (!recipientPhone) return;
        // if (!this.apiKey || !this.phoneNumber) return;
        const originalMessage = messageText;
        const selectedMedia = this.state.selectedMedia;
        // console.log("selectedMedia",selectedMedia.file)
        this.state.messageInput = "";
        this.removeSelectedMedia();
        // Reset textarea height after clearing input
        setTimeout(() => this.resetTextareaHeight(), 0);
        const messageType = selectedMedia ? selectedMedia.type : 'chat';
        try {
            this.state.mediaUploading = true;
            const url = `${this.backendApiUrl}/api/message`;
            let headers;
            try {
                headers = this._getApiHeaders();
                // headers['Content-Type'] = 'multipart/form-data';
            } catch (error) {
                this.state.mediaUploading = false;
                this.state.error = 'API credentials not available. Please reconnect.';
                this.state.messageInput = originalMessage;
                if (selectedMedia) {
                    this.state.selectedMedia = selectedMedia;
                }
                return;
            }
            let response;
                const formData = new FormData();
                formData.append("byChatId", true)
            formData.append('chatId', chatId);
                formData.append('messageType', messageType);
            if(originalMessage){
                formData.append('body', originalMessage);
            }
            
            // Handle multi_vcard messages
            if (messageType === 'multi_vcard' && selectedMedia?.contacts) {
                selectedMedia.contacts.forEach((contact, index) => {
                    formData.append(`vcards[${index}][name]`, contact.name || contact.pushname || contact.fullName || '');
                    formData.append(`vcards[${index}][phone]`, contact.phoneNumber || contact.phone || '');
                });
            } 
            // else if (messageType === 'location' && selectedMedia?.location) {
            //     formData.append('location[latitude]', selectedMedia.location.latitude.toString());
            //     formData.append('location[longitude]', selectedMedia.location.longitude.toString());
            //     if (selectedMedia.location.name) {
            //         formData.append('location[name]', selectedMedia.location.name);
            //     }
            //     if (selectedMedia.location.address) {
            //         formData.append('location[address]', selectedMedia.location.address);
            //     }
            // }
             else if(selectedMedia?.file) {
                formData.append('files[0]', selectedMedia.file);
            }
               
                response = await fetch(url, { method: 'POST', headers, body: formData });
           
            this.state.mediaUploading = false;
            const result = await this._parseResponse(response);

            if (!response.ok || !result?.success) {
                this.state.messageInput = originalMessage;
                if (selectedMedia) {
                    this.state.selectedMedia = selectedMedia;
                }
                throw new Error(result?.message || result?.error || 'Failed to send message');
            }
            else if(response.status === 201){
                // Store the data needed to recreate the request, not FormData itself
                const requestData = {
                    type: 'sendMessage',
                    chatId: chatId,
                    messageText: originalMessage,
                    messageType: messageType,
                    selectedMedia: selectedMedia ? {
                        type: selectedMedia.type,
                        file: selectedMedia.file, // File object can be stored
                        contacts: selectedMedia.contacts // For multi_vcard
                    } : null
                };
                this.state.pendingRequests.push(requestData);
                // Restore the input and media so user can see what's pending
                this.state.messageInput = originalMessage;
                if (selectedMedia) {
                    this.state.selectedMedia = selectedMedia;
                }
                this.state.mediaUploading = false;
                return;
            }else {
                this.scrollToBottom(true);
                // this._updateChatMetadataAndMoveToTop(selected, originalMessage, selectedMedia, messageType);
            }
        } catch (error) {
            console.error("[WA] Error sending message:", error.message || error);
            this.state.mediaUploading = false;
            this.state.error = error.message || 'Failed to send message. Please try again.';
        }
    }

    canEditMessage(message) {
        if (!message.id || message.direction !== 'outbound' || (message.type !== 'text' && message.messageType !== 'text' && message.type !== 'chat' && message.messageType !== 'chat')) return false;
        const age = Date.now() - (new Date(message.timestamp || 0).getTime());
        return age < 15 * 60 * 1000;
    }

    startEdit(message) {
        if (!this.canEditMessage(message)) return;
        this.state.editingMessageId = message.id;
        this.state.messageInput = message.content || '';
    }

    async saveEdit() {
        if (!this.state.editingMessageId) return;
        const messageText = this.state.messageInput.trim();
        if (!messageText) { this.cancelEdit(); return; }
        const message = this.state.messages.find(m => m.id === this.state.editingMessageId);
        if (!message) { this.cancelEdit(); return; }
        const messageId = String(message.id || '');
        if (!messageId) { this.cancelEdit(); return; }

        const originalText = (message.content || '').trim();
        if (messageText === originalText) {
        this.cancelEdit(); // No change, just cancel
        return;
    }
        try {
            const response = await fetch(`${this.backendApiUrl}/api/message/${messageId}`, {
                method: 'PUT',
                headers: {...this._getApiHeaders(), 'Content-Type': 'application/json'},
                body: JSON.stringify({ body: messageText })
            });
            const result = await this._parseResponse(response);
            if (!response.ok || !result?.success) throw new Error(result?.message || 'Failed to edit message');
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'saveEdit',
                    messageId: messageId,
                    messageText: messageText
                });
                this.cancelEdit();
                return;
            }
            
            // UI will be updated by socket event or on next message refresh
            console.log("[WA] Message edit request sent successfully. Waiting for socket update...");
            this.cancelEdit();
        } catch (error) {
            console.error("[WA] Error editing message:", error.message || error);
            this.state.error = error.message || 'Failed to edit message. Please try again.';
        }
    }

    cancelEdit() {
        this.state.editingMessageId = null;
        this.state.messageInput = '';
    }

    openMessageContextMenu(message, event) {
        if (event) {
            event.stopPropagation();
        }
        this.state.contextMenuMessage = message;
        this.state.showDeleteSubmenu = false;
        this.state.showReactionPicker = false;
        this.state.showFullReactionPicker = false;
        
        // Store the button element for CSS positioning
        if (event && event.currentTarget) {
            const button = event.currentTarget;
            const messageElement = button.closest('.message');
            if (messageElement) {
                messageElement.setAttribute('data-context-menu-open', 'true');
                this.state.contextMenuButton = button;
            }
        }
        
        this.state.showMessageContextMenu = true;
        
        // Add click outside handler
        setTimeout(() => {
            const handleClickOutside = (e) => {
                if (this.state.showMessageContextMenu) {
                    const menu = document.querySelector('.message-context-menu-content');
                    const isInsideMenu = menu && (menu.contains(e.target) || menu === e.target);
                    const isDropdownBtn = e.target.closest('.message-dropdown-btn');
                    const isEmojiPicker = e.target.closest('.emoji-mart-container') || e.target.closest('em-emoji-picker');
                    
                    if (!isInsideMenu && !isDropdownBtn && !isEmojiPicker) {
                        this.closeMessageContextMenu();
                        document.removeEventListener('click', handleClickOutside);
                    }
                }
            };
            setTimeout(() => {
                document.addEventListener('click', handleClickOutside);
            }, 0);
        }, 0);
    }

    closeMessageContextMenu() {
        this.state.showMessageContextMenu = false;
        this.state.contextMenuMessage = null;
        this.state.showDeleteSubmenu = false;
        this.state.showReactionPicker = false;
        this.state.showFullReactionPicker = false;
        this.state.contextMenuButton = null;
        
        // Remove data attribute from message element
        const messageElement = document.querySelector('.message[data-context-menu-open="true"]');
        if (messageElement) {
            messageElement.removeAttribute('data-context-menu-open');
        }
    }

    handleContextMenuEdit() {
        const message = this.state.contextMenuMessage;
        if (!message || !this.canEditMessage(message)) return;
        this.closeMessageContextMenu();
        this.startEdit(message);
    }

    handleContextMenuReact() {
        // Show emoji picker library
        this.state.showReactionPicker = true;
        
        // Initialize emoji picker if not already loaded
        this.initEmojiPicker();
        
        // Attach event listener after DOM update
        this.attachEmojiPickerListener();
    }

    initEmojiPicker() {
        // EmojiMart bundle is now loaded from local files via manifest
        // No need to preload scripts dynamically
    }

    attachEmojiPickerListener() {
        // Use requestAnimationFrame to wait for DOM update
        requestAnimationFrame(() => {
            setTimeout(async () => {
                const pickerContainer = document.querySelector('.emoji-mart-container');
                if (pickerContainer && !pickerContainer.hasAttribute('data-picker-initialized')) {
                    pickerContainer.setAttribute('data-picker-initialized', 'true');
                    
                    try {
                        // Check if emoji-mart bundle is loaded (from local file)
                        if (typeof EmojiMart === 'undefined') {
                            throw new Error('EmojiMart bundle not loaded. Make sure emoji-mart-bundle.js is included in assets.');
                        }
                        
                        // Use the local emoji-mart bundle
                        const { Picker } = EmojiMart;
                        
                        // Create and mount the picker
                        const picker = new Picker({
                            onEmojiSelect: (emoji) => {
                                this.onEmojiPickerSelect(emoji);
                            },
                            theme: 'light',
                            previewPosition: 'none',
                            skinTonePosition: 'search',
                        });
                        
                        // Clear container and append picker
                        pickerContainer.innerHTML = '';
                        pickerContainer.appendChild(picker);
                        
                        console.log('[WA] Emoji picker initialized successfully from local bundle');
                    } catch (error) {
                        console.error('[WA] Error initializing EmojiMart:', error);
                        // Fallback: show error message
                    }
                }
            }, 100);
        });
    }

    async selectReaction(emoji) {
        const message = this.state.contextMenuMessage;
        if (!message || !message.id) return;
        
        // Normalize current phone number
        const currentUserId = this.phoneNumber
            ?.replace(/\+/g, '')
            .replace(/\s+/g, '')
            .replace(/@c\.us$/i, '');
       
        // Check if already reacted
        const alreadyReacted = message.reactions?.some(r => {
            if (r.emoji !== emoji) return false;
            
            // Normalize and compare each user in the reaction
            return r.users?.some(userId => {
                const normalizedUserId = userId
                    ?.replace(/\+/g, '')
                    .replace(/\s+/g, '')
                    .replace(/@c\.us$/i, '');
               
                return normalizedUserId === currentUserId;
            });
        });
        
        this.closeMessageContextMenu();
        
        // Toggle: empty string if already reacted, emoji if not
        await this.sendReaction(message.id, alreadyReacted ? '' : emoji);
    }

    onEmojiPickerSelect(emoji) {
        // EmojiMart returns emoji object with native property
        const emojiString = emoji?.native || emoji?.unified || emoji;
        if (emojiString) {
            this.selectReaction(emojiString);
        }
    }

    async sendReaction(messageId, emoji) {
        try {
            const messageIdStr = String(messageId);
            const url = `${this.backendApiUrl}/api/message/reaction/${messageIdStr}`;
            const headers = {...this._getApiHeaders(), 'Content-Type': 'application/json'};
            
            const response = await fetch(url, {
                method: 'PUT',
                headers: headers,
                body: JSON.stringify({ reaction: emoji })
            });
            
            const result = await this._parseResponse(response);
            
            if (!response.ok || !result?.success) {
                throw new Error(result?.message || 'Failed to react to message');
            }
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'reactToMessage',
                    messageId: messageIdStr,
                    reaction: emoji
                });
                return;
            }
            
            // Update message reactions in UI
            // The socket will handle the actual reaction update
            console.log("[WA] Reaction sent successfully");
        } catch (error) {
            console.error("[WA] Error reacting to message:", error.message || error);
            this.state.error = error.message || 'Failed to react to message. Please try again.';
        }
    }

    handleContextMenuDelete() {
        // Show delete submenu instead of directly deleting
        this.state.showDeleteSubmenu = true;
    }

    async deleteMessageForMe() {
        const message = this.state.contextMenuMessage;
        if (!message || !message.id) return;
        
        this.closeMessageContextMenu();
        await this.deleteMessage(message.id, false);
    }

    async deleteMessageForEveryone() {
        const message = this.state.contextMenuMessage;
        if (!message || !message.id || message.direction !== 'outbound') return;
        
        this.closeMessageContextMenu();
        await this.deleteMessage(message.id, true);
    }

    async deleteMessage(messageId, everyone = false) {
        try {
            const messageIdStr = String(messageId);
            const url = `${this.backendApiUrl}/api/message/revoke/${messageIdStr}`;
            const headers = {...this._getApiHeaders(), 'Content-Type': 'application/json'};
            
            const response = await fetch(url, {
                method: 'PUT',
                headers: headers,
                body: JSON.stringify({ everyone: everyone })
            });
            
            const result = await this._parseResponse(response);
            
            if (!response.ok || !result?.success) {
                throw new Error(result?.message || 'Failed to delete message');
            }
            else if(response.status === 201){
                this.state.pendingRequests.push({
                    type: 'deleteMessage',
                    messageId: messageIdStr,
                    everyone: everyone
                });
                return;
            }
            
            // UI will be updated by socket event or on next message refresh
            console.log(`[WA] Message delete request sent successfully (${everyone ? 'for everyone' : 'for me'}). Waiting for socket update...`);
        } catch (error) {
            console.error("[WA] Error deleting message:", error.message || error);
            this.state.error = error.message || 'Failed to delete message. Please try again.';
        }
    }

    _updateChatMetadataAndMoveToTop(selected, originalMessage, selectedMedia, messageType) {
        const chatIndex = this._conversationMap.get(selected.id);
        if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
            const chat = this.state.conversations[chatIndex];
            chat.latestMessage = originalMessage || (selectedMedia ? selectedMedia.file.name : '');
            // chat.last_message_type = messageType;
            if (chatIndex !== 0) {
                const [movedChat] = this.state.conversations.splice(chatIndex, 1);
                this.state.conversations.unshift(movedChat);
                this._rebuildConversationMap();
                this.state.selectedConversation = movedChat;
            }
            this.filterConversations();
        }
    }
    
    handleKeyPress(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
    }

    handleTextareaInput(event) {
        const textarea = event.target;
        // Reset height to auto to get the correct scrollHeight
        textarea.style.height = 'auto';
        
        // Calculate the new height (line-height is 20px, padding is 18px total)
        const lineHeight = 20;
        const maxRows = 4;
        const maxHeight = (lineHeight * maxRows) + 18; // 4 rows + padding
        const newHeight = Math.min(textarea.scrollHeight, maxHeight);
        
        // Set the new height
        textarea.style.height = newHeight + 'px';
        
        // Show scrollbar if content exceeds max height
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    resetTextareaHeight() {
        // Reset textarea height after message is sent
        if (this.refs && this.refs.messageTextarea && this.refs.messageTextarea.el) {
            const textarea = this.refs.messageTextarea.el;
            textarea.style.height = 'auto';
            textarea.style.overflowY = 'hidden';
        }
    }
    
    refreshData() {
        this.loadData();
    }
    
    getConnectionStatus(connection) {
        if (!connection) return 'disconnected';
        const isSelected = this.state.selectedConnection?.id === connection.id;
        const socketConnected = socketService.isConnected;
        const hasMatchingCredentials = socketService.hasMatchingCredentials(
            connection.api_key || '',
            connection.phone_number || connection.from_field || '',
            window.location.origin
        );
        if (socketConnected && hasMatchingCredentials && (isSelected || connection.socket_connection_ready)) {
            return 'connected';
        }
        return 'disconnected';
    }
    
    updateConnectionStatuses() {
        this.state.connections = this.state.connections.map(conn => ({
            ...conn,
            connection_status: this.getConnectionStatus(conn)
        }));
    }
    
    formatLastActivity(dateString) {
        if (!dateString) return "";
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return dateString;
            // Convert UTC to IST (UTC+5:30)
            const istOffset = 5.5 * 60 * 60 * 1000;
            const istDate = new Date(date.getTime() + istOffset);
            
            // Get today's start in IST
            const today = new Date();
            const todayIST = new Date(today.getTime() + istOffset);
            const todayStart = new Date(todayIST.getUTCFullYear(), todayIST.getUTCMonth(), todayIST.getUTCDate());
            const dateStart = new Date(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate());
            const diffDays = Math.round((todayStart - dateStart) / 86400000);
            
            if (diffDays === 0) {
                // Today: show time in AM/PM format
                const hours = istDate.getUTCHours();
                const minutes = istDate.getUTCMinutes();
                const ampm = hours >= 12 ? 'PM' : 'AM';
                const displayHours = hours % 12 || 12;
                const displayMinutes = String(minutes).padStart(2, '0');
                return `${displayHours}:${displayMinutes} ${ampm}`;
            } else if (diffDays === 1) {
                // Yesterday
                return "Yesterday";
            } else if (diffDays < 7) {
                // Within 5-6 days: show day name
                return istDate.toLocaleDateString(undefined, { weekday: 'long' });
            } else {
                // Older: show date DD/MM/YYYY
                const pad = (n) => String(n).padStart(2, "0");
                return `${pad(istDate.getUTCDate())}/${pad(istDate.getUTCMonth() + 1)}/${istDate.getUTCFullYear()}`;
            }
        } catch (error) {
            return dateString;
        }
    }
    
    formatMessageTime(dateString) {
        // if (!dateString) return "";
        // // Extract time directly from ISO string (e.g., "2025-11-25T04:26:23.000Z" -> "04:26")
        // const match = dateString.match(/T(\d{2}):(\d{2})/);
        // if (match) {
        //     return `${match[1]}:${match[2]}`;
        // }
        // // Fallback if format doesn't match
        // return dateString;
        if (!dateString) return "";
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return dateString;
            // Convert UTC to IST (UTC+5:30)
            const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
            const istDate = new Date(date.getTime() + istOffset);
            // Format as HH:MM AM/PM
            const hours = istDate.getUTCHours();
            const minutes = istDate.getUTCMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            const displayMinutes = String(minutes).padStart(2, '0');
            return `${displayHours}:${displayMinutes} ${ampm}`;
        } catch (error) {
            return dateString;
        }
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
        if (!Array.isArray(this.state.messages) || !this.state.messages.length) return;
        let lastDayKey = null;
        this.state.messages.forEach((msg) => {
            const timestamp = msg.timestamp;
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
        const container = this._getMessagesContainer();
        if (!container) return null;
        return {
            scrollHeight: container.scrollHeight,
            scrollTop: container.scrollTop,
        };
    }

    _getMessagesContainer() {
        return this.refs?.messagesContainer || this._messagesContainer || document.querySelector('.messages-container');
    }
    
    restoreScrollPosition(scrollState) {
        if (!scrollState) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = this._getMessagesContainer();
                if (!container) return;
                const newScrollHeight = container.scrollHeight;
                const diff = newScrollHeight - scrollState.scrollHeight;
                if (diff <= 0) return;
                container.scrollTop = scrollState.scrollTop + diff;
            });
        });
    }
    
    scrollToBottom(force = true) {
        const scrollToBottom = (attempts = 0) => {
            const container = this._getMessagesContainer();
            if (container) {
                try {
                    if (force) {
                        container.scrollTop = container.scrollHeight;
                    } else {
                        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
                        if (isNearBottom) {
                            container.scrollTop = container.scrollHeight;
                        } else {
                            return;
                        }
                    }
                    if (attempts < 3 && container.scrollTop < container.scrollHeight - container.clientHeight - 10) {
                        setTimeout(() => scrollToBottom(attempts + 1), 100);
                    }
                } catch (e) {}
            } else if (attempts < 5) {
                setTimeout(() => scrollToBottom(attempts + 1), 100);
            }
        };
        requestAnimationFrame(() => {
            setTimeout(() => scrollToBottom(0), 100);
        });
    }
    
    getAckColor(message) {
        if (message.direction !== 'outbound') return null;
        const ack = message.ack || 0;
        return ack >= 3 ? '#53bdeb' : '#667781';
    }
    
    getEmojis() {
        return ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣"];
    }
    
    getAttachmentAccept() {
        const config = this._getAttachmentConfig(this.state.attachmentPickerType || 'all');
        return config.accept;
    }
    
    openMediaSelector() {
        this.openFilePickerForType(this.state.attachmentPickerType || 'all');
    }

    toggleAttachmentMenu(event) {
        if (event) {
            event.stopPropagation(); // Prevent bubbling to document click handler
        }
        this.state.showAttachmentMenu = !this.state.showAttachmentMenu;
        
        // Add click outside handler when opening menu (same pattern as message context menu)
        if (this.state.showAttachmentMenu) {
            setTimeout(() => {
                const handleClickOutside = (e) => {
                    if (this.state.showAttachmentMenu) {
                        const attachmentMenu = this.el?.querySelector('.attachment-menu');
                        const toggleButton = this.el?.querySelector('.attachment-toggle');
                        const isInsideMenu = attachmentMenu && (attachmentMenu.contains(e.target) || attachmentMenu === e.target);
                        const isToggleButton = toggleButton && (toggleButton.contains(e.target) || toggleButton === e.target);
                        
                        if (!isInsideMenu && !isToggleButton) {
                            this.closeAttachmentMenu();
                            document.removeEventListener('click', handleClickOutside);
                        }
                    }
                };
                setTimeout(() => {
                    document.addEventListener('click', handleClickOutside);
                }, 0);
            }, 0);
        }
    }

    closeAttachmentMenu() {
        this.state.showAttachmentMenu = false;
    }

    handleAttachmentOption(option) {
        this.closeAttachmentMenu();
        switch(option) {
            case 'document':
            case 'media':
            case 'audio':
                this.openFilePickerForType(option);
                break;
            case 'contact':
                this.state.contactSharingMode = true;
                this.state.selectedContactsForSharing = [];
                this.state.showContactsPopup = true;
                if (this.state.contacts.length === 0) {
                    this.loadContacts(1, 50, { append: false });
                }
                break;
            // case 'location':
            //     this.openLocationPicker();
            //     break;
            case 'poll':
            case 'event':
            case 'sticker':
                this.state.error = `${option.charAt(0).toUpperCase() + option.slice(1)} sharing coming soon.`;
                break;
            default:
                this.openFilePickerForType('all');
        }
    }

    _getFileInput() {
        return this.refs?.fileInput ||
                        (this.__owl__?.refs?.fileInput) ||
                        (this.el?.querySelector('.whatsapp-file-input') || this.el?.querySelector('input[type="file"]')) ||
                        document.querySelector('.whatsapp-file-input');
    }

    _getAttachmentConfig(type = 'all') {
        const configs = {
            document: {
                accept: ".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.ppt,.pptx"
            },
            media: {
                accept: "image/*,video/*"
            },
            audio: {
                accept: "audio/*"
            },
            all: {
                accept: "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.ppt,.pptx"
            }
        };
        return configs[type] || configs.all;
    }

    openFilePickerForType(type = 'all') {
        const fileInput = this._getFileInput();
        if (!fileInput) return;
        const config = this._getAttachmentConfig(type);
        if (!config) return;
        fileInput.setAttribute('accept', config.accept);
        if (config.capture) {
            fileInput.setAttribute('capture', config.capture);
        } else {
            fileInput.removeAttribute('capture');
        }
        this.state.attachmentPickerType = type;
        fileInput.value = '';
        fileInput.click();
    }
    
    handleFileSelect(event) {
        try {
            const file = event.target.files[0];
            if (!file) return;
            const fileType = this.detectMediaType(file);
            let preview = null;
            if (fileType === 'image' || fileType === 'video') {
                preview = URL.createObjectURL(file);
            }
            this.state.selectedMedia = { file: file, type: fileType, preview: preview };
            event.target.value = '';
        } catch (error) {
            console.error("[WA] Error handling file select:", error.message || error);
            this.state.error = 'Failed to process file. Please try again.';
            event.target.value = '';
        }
    }
    
    detectMediaType(file) {
        const mimeType = file.type.toLowerCase();
        const fileName = file.name.toLowerCase();
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
        if (docExtensions.some(ext => fileName.endsWith(ext))) return 'document';
        return 'document';
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
        if (!message || message.direction !== 'inbound') return;
        if (!this.state.selectedConversation) return;
        if (this._creatingLeadMessageId === message.id) return;
        const conversation = this.state.selectedConversation;

        
        const payload = {
            message_id: message.id,
            message_content: message.body || message.content || '',
            message_type: message.messageType || message.type || 'text',
            timestamp: message.timestamp || null,
            message_direction: message.direction,
            contact_name: conversation.contact_name || conversation.name || '',
            contact_phone: conversation.phoneNumber || '',
            conversation_id: conversation.conversation_id || conversation.id || null,
            fromContact: message.fromContact.phoneNumber || null,
        };
        this._creatingLeadMessageId = message.id;
        try {
            const action = await this.rpc('/whatsapp/create_lead_action', payload);
            if (action) {
                await this.actionService.doAction(action);
            }
        } catch (error) {
            console.error("[WA] Failed to create lead:", error.message || error);
        } finally {
            if (this._creatingLeadMessageId === message.id) {
                this._creatingLeadMessageId = null;
            }
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
        return convs.filter(c => c.unreadCount > 0).length;
    }
    
    handleChatUpdate(payload) {
       
        const chatData = payload.data
        try {
            const chatId = chatData.id || chatData.chatId;
            if (!chatData || !chatId) return;
            const existingIndex = this._conversationMap.get(chatId);
            const updatedChat = this._mapBackendChatToConversation(chatData);
            // updatedChat.contact_status = 'online';
            if (existingIndex !== undefined && existingIndex >= 0 && existingIndex < this.state.conversations.length) {
                const wasSelected = this.state.selectedConversation?.id === chatId;
                if (wasSelected) {
                    updatedChat.unreadCount = 0;
                }
                this.state.conversations[existingIndex] = updatedChat;
                const [movedChat] = this.state.conversations.splice(existingIndex, 1);
                this.state.conversations.unshift(movedChat);
                this._rebuildConversationMap();
                if (wasSelected) {
                    this.state.selectedConversation = movedChat;
                }
            } else {
                this.state.conversations.unshift(updatedChat);
                this._conversationMap.set(chatId, 0);
                for (let i = 1; i < this.state.conversations.length; i++) {
                    const cid = this.state.conversations[i].id;
                    if (cid) this._conversationMap.set(cid, i);
                }
            }
            this.state.conversations.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
            this._rebuildConversationMap();
            this.filterConversations();
        } catch (error) {
            console.error("[WA] Error handling chat update:", error.message || error);
        }
    }
    
    handleContactEvent(payload) {
        const contact = payload?.data ?? payload;
        if (!contact || !contact.id) {
            return;
        }
    
        // Normalise for templates that expect legacy field names.
        const normalized = {
            ...contact,
            display_name: contact.name ?? contact.pushname ?? '',
            phone_number: contact.phoneNumber ?? contact.phone_number ?? '',
            profile_picture: contact.profilePicture ?? contact.profile_picture ?? '',
        };
    
        if (!Array.isArray(this.state.contacts)) {
            this.state.contacts = [];
        }
    
        const existingIdx = this.state.contacts.findIndex((c) => c.id === normalized.id);
        if (existingIdx >= 0) {
            this.state.contacts[existingIdx] = { ...this.state.contacts[existingIdx], ...normalized };
        } else {
            this.state.contacts.unshift(normalized);
        }
    
        // Refresh derived views
        this.state.contacts = [...this.state.contacts];
        this.filterConversations(); // ensures conversation chips using contact info update
    }
    
    getConversationId(from, to) {
        if (!from || !to) return null;
        const participants = [from.trim(), to.trim()].filter(p => p).sort();
        if (participants.length !== 2) return null;
        return participants.join('_');
    }
    
    getConversationIdForChat(contactPhone) {
        if (!this.phoneNumber || !contactPhone) return null;
        return this.getConversationId(this.phoneNumber, contactPhone);
    }
    
    findConversationByMessage(msg) {
        if (msg.chatId) {
            const mapIndex = this._conversationMap.get(msg.chatId);
            if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
                const conv = this.state.conversations[mapIndex];
                if (conv.id === msg.chatId) return conv;
            }
            const conv = this.state.conversations.find(c => c.id === msg.chatId);
            if (conv) return conv;
        }
        const from = (msg.from || '').trim();
        const to = (msg.to || '').trim();
        if (!from || !to) return null;
        const generatedId = this.getConversationId(from, to);
        if (generatedId) {
            const mapIndex = this._conversationMap.get(generatedId);
            if (mapIndex !== undefined && mapIndex >= 0 && mapIndex < this.state.conversations.length) {
                const conv = this.state.conversations[mapIndex];
                const convGeneratedId = this.getConversationIdForChat(conv.contact_phone);
                if (convGeneratedId === generatedId) return conv;
            }
            const conv = this.state.conversations.find(c => {
                if (c.is_group) return false;
                const convGeneratedId = this.getConversationIdForChat(c.contact_phone);
                return convGeneratedId === generatedId;
            });
            if (conv) return conv;
        }
        return this.state.conversations.find(c => {
            const phone = (c.contact_phone || '').trim();
            return phone && (from === phone || to === phone);
        }) || null;
    }
    
    _rebuildConversationMap() {
        this._conversationMap.clear();
        this.state.conversations.forEach((conv, index) => {
            if (conv.id) {
                this._conversationMap.set(conv.id, index);
            }
            // if (conv.contact_phone && !conv.is_group) {
            //     const generatedId = this.getConversationIdForChat(conv.contact_phone);
            //     if (generatedId) {
            //         this._conversationMap.set(generatedId, index);
            //     }
            // }
        });
    }
    
    handleReactionEvent(msg) {
        
        try {
            if (!msg.reactions || !Array.isArray(msg.reactions) || !msg.id) return;
            
            const targetMessage = this.state.messages.find(m => m.id === msg.id);
            if (!targetMessage) return;
            
            // Group reactions by emoji and collect senderIds
            const reactionMap = new Map();
            msg.reactions.forEach(r => {
                const emoji = r.reaction || r.emoji || '';
                if (!emoji) return;
                
                const senderId = r.senderId || '';
                const isDeleted = r.deletedAt !== null && r.deletedAt !== undefined;
                
                if (!reactionMap.has(emoji)) {
                    reactionMap.set(emoji, {
                        emoji: emoji,
                        count: 0,
                        users: []
                    });
                }
                
                const existing = reactionMap.get(emoji);
                if (isDeleted) {
                    // Skip deleted reactions in the grouping
                    return;
                }
                
                // Add senderId if not present
                if (senderId && !existing.users.includes(senderId)) {
                    existing.users.push(senderId);
                    existing.count++;
                } else if (!senderId) {
                    existing.count++;
                }
            });
            
            targetMessage.reactions = Array.from(reactionMap.values());
        } catch (error) {
            console.error("[WA] Error handling reaction event:", error.message || error);
        }
        
    }
    
    handleMessageEvent(chatData) {
        const msg = chatData.data;
       
        try {
            if (!msg || !msg.id) {
                console.log("[WA] handleMessageEvent: No msg or msg.id, returning");
                return;
            }
            
            // Handle reaction events
            if (msg.reactions && msg.id) {
                // console.log("[WA] handleMessageEvent: Handling as reaction event");
                this.handleReactionEvent(msg);
                // return;
            }
            if (msg.deletedType || msg.deletedAt) {
                // console.log("[WA] handleMessageEvent: Handling as delete event");
                this.handleMessageDelete(msg);
                return;
            }
            
            const msgId = msg.id;
          
            const targetConversation = this.findConversationByMessage(msg);
            
            if (!targetConversation) {
                console.log("[WA] handleMessageEvent: No target conversation found, returning");
                return;
            }
            const targetChatId = targetConversation.id || targetConversation.id;
            const selected = this.state.selectedConversation;
            const isSelected = selected && (selected.id === targetChatId || selected.id === targetChatId);
            const mappedMessage = this._mapBackendMessageToUI(msg);
            if (isSelected) {
               
                const existsInSet = this._messageIdSet.has(msgId);
                const existsInArray = this.state.messages.some(m => m.id === msgId);
               
                
                if (!existsInSet && !existsInArray) {
                
                    this.state.messages.push(mappedMessage);
                    this._messageIdSet.add(msgId);
                    this.state.messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                    this.decorateMessagesWithDaySeparators();
                 
                } else if (existsInArray && !existsInSet) {
                   
                    this._messageIdSet.add(msgId);
                    
                    const existingMsgIndex = this.state.messages.findIndex(m => m.id === msgId);
                    if (existingMsgIndex >= 0) {
                        const existingMsg = this.state.messages[existingMsgIndex];
                        
                        // Update content if changed (handles edits)
                        if (msg.body !== undefined && msg.body !== existingMsg.content) {
                            existingMsg.content = msg.body;
                            existingMsg.is_edited = true;
                            existingMsg.edited_at = msg.edited_at || Date.now();
                        }
                        
                        // Update ack status
                        if (msg.ack !== undefined && msg.ack !== null) {
                            const newAck = parseInt(msg.ack, 10) || 0;
                            if (newAck !== existingMsg.ack) {
                                existingMsg.ack = newAck;
                                if (newAck >= 3) existingMsg.status = 'read';
                                else if (newAck >= 2) existingMsg.status = 'delivered';
                                else if (newAck >= 1) existingMsg.status = 'sent';
                            }
                        }
                    }
                } else {
                
                    const existingMsgIndex = this.state.messages.findIndex(m => m.id === msgId);
                    if (existingMsgIndex >= 0) {
                        const existingMsg = this.state.messages[existingMsgIndex];
                        
                        // Update content if changed (handles edits)
                        if (msg.body !== undefined && msg.body !== existingMsg.content) {
                            existingMsg.content = msg.body;
                            existingMsg.is_edited = true;
                            existingMsg.edited_at = msg.edited_at || Date.now();
                        }
                        
                        // Update ack status
                        if (msg.ack !== undefined && msg.ack !== null) {
                            const newAck = parseInt(msg.ack, 10) || 0;
                            if (newAck !== existingMsg.ack) {
                                existingMsg.ack = newAck;
                                if (newAck >= 3) existingMsg.status = 'read';
                                else if (newAck >= 2) existingMsg.status = 'delivered';
                                else if (newAck >= 1) existingMsg.status = 'sent';
                            }
                        }
                    }
                }
            } else {
                console.log("[WA] handleMessageEvent: Conversation not selected, skipping message UI update");
            }
            let chatIndex = this._conversationMap.get(targetChatId);
            if (chatIndex === undefined || chatIndex < 0 || chatIndex >= this.state.conversations.length) {
                
                chatIndex = this.state.conversations.findIndex(c => c === targetConversation);
                if (chatIndex < 0) {
                    
                    chatIndex = this.state.conversations.findIndex(c => 
                        (c.conversation_id && c.conversation_id === targetChatId) ||
                        (c.id && c.id === targetChatId)
                    );
                }
            }
            
            if (chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                const chat = this.state.conversations[chatIndex];
                const oldTimestamp = chat.timestamp;
                // chat.latestMessage = mappedMessage.content;
                // chat.last_message_type = mappedMessage.type;
                // chat.timestamp = mappedMessage.timestamp;
               
                if (isSelected) {
                    chat.unreadCount = 0;
                }
                if (chatIndex !== 0) {
                  
                    const [movedChat] = this.state.conversations.splice(chatIndex, 1);
                    this.state.conversations.unshift(movedChat);
                    this._rebuildConversationMap();
                    if (isSelected) {
                        this.state.selectedConversation = movedChat;
                    }
                }
            } else {
                console.log("[WA] handleMessageEvent: Chat index invalid, not updating chat metadata");
            }
            this.state.conversations.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
            this._rebuildConversationMap();
            this.filterConversations();
            console.log("[WA] handleMessageEvent: Completed processing message");
        } catch (error) {
            console.error("[WA] Error handling message event:", error.message || error);
        }
    }
    handleMessageDelete(msg) {
        try {
            if (!msg || !msg.id) return;
            
            const msgId = msg.id;
            const deletedType = msg.deletedType || 'deleted_for_me';
            
            // Find the message in the current conversation's messages
            const messageIndex = this.state.messages.findIndex(m => m.id === msgId);
            
            if (messageIndex >= 0) {
                if (deletedType === 'deleted_for_everyone') {
                    const deletedMsg = this.state.messages[messageIndex];
                    const isOwnMessage = deletedMsg.fromMe || deletedMsg.direction === 'outbound';
                    const placeholder = isOwnMessage ? 'You deleted this message' : 'This message was deleted';

                    deletedMsg.isDeleted = true;
                    deletedMsg.deletedType = 'deleted_for_everyone';
                    deletedMsg.deletedAt = msg.deletedAt || new Date().toISOString();
                    deletedMsg.content = placeholder;
                    deletedMsg.body = placeholder;
                    deletedMsg.media = null;
                    deletedMsg.media_url = null;
                                
                } else {
                    // deleted_for_me - remove from UI completely
                    this.state.messages.splice(messageIndex, 1);
                    this._messageIdSet.delete(msgId);
                    this.decorateMessagesWithDaySeparators();
                }
            }
            
            // Update conversation's latest message if the deleted message was the latest
            const targetConversation = this.findConversationByMessage(msg);
            if (targetConversation) {
                const targetChatId = targetConversation.id || targetConversation.conversation_id;
                const chatIndex = this._conversationMap.get(targetChatId);
                
                if (chatIndex !== undefined && chatIndex >= 0 && chatIndex < this.state.conversations.length) {
                    const chat = this.state.conversations[chatIndex];
                    
                    // If the deleted message was the latest, update to the previous message
                    if (chat.latestMessageId === msgId || chat.latestMessage === msg.body || chat.latestMessage === msg.content) {
                        // Find the most recent non-deleted message
                        const recentMessages = this.state.messages
                            .filter(m => m.id !== msgId && !m.isDeleted)
                            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
                        
                        if (recentMessages.length > 0) {
                            chat.latestMessage = recentMessages[0].content || recentMessages[0].body || 'No messages yet';
                            chat.timestamp = recentMessages[0].timestamp;
                        } else {
                            chat.latestMessage = null;
                            chat.timestamp = null;
                        }
                    }
                }
            }
            
            this.filterConversations();
        } catch (error) {
            console.error("[WA] Error handling message delete:", error.message || error);
        }
    }
}

registry.category("actions").add("whatsapp_web_client_action", WhatsAppWebClientAction);
