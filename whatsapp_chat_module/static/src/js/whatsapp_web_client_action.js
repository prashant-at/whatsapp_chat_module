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
        this.backendApiUrl = this.env?.services?.config?.whatsapp_backend_url || 'http://localhost:3000';
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
            contacts: [],
            contactsSearchTerm: "",
            isLoadingContacts: false,
            pagination: { pageIndex: 1, pageSize: 50, hasMore: true, isLoadingMore: false },
            messagePagination: { pageIndex: 1, pageSize: 50, hasMore: true, isLoadingMore: false },
            isLoadingMessages: false,
            selectedMedia: null,
            mediaUploading: false,
            editingMessageId: null,
        });
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
        this._unsubscribe.push(socketService.on('status', (data) => {
            console.log("status event data",data)
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
                    if (!this._initialChatsLoaded) {
                        this._initialChatsLoaded = true;
                        (async () => {
                            try {
                                await this.loadConversations(true);
                            } catch (error) {
                                console.error("[WA] Error loading conversations:", error.message || error);
                                this.state.error = 'Failed to load conversations. Please refresh.';
                            }
                        })();
                    }
                } else if (type === 'disconnected') {
                    this.state.canSendMessages = false;
                    this.state.banner = 'Disconnected. Please re-scan.';
                    this.state.stage = this.state.stage === 'ready' ? 'qr' : this.state.stage;
                    this.state.showQRModal = true;
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
            console.log("chat event",chatData)
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
        this._unsubscribe.push(socketService.on('qr_code', (data) => {
            try {
                this._handleQRCode(data);
            } catch (error) {
                console.error("[WA] Error in QR code handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('phone_mismatch', (data) => {
            try {
                this._handlePhoneMismatch(data);
            } catch (error) {
                console.error("[WA] Error in phone mismatch handler:", error.message || error);
            }
        }));
        this._unsubscribe.push(socketService.on('contact', (contactData) => {
            console.log("contact event",contactData)
            try {
                this.handleContactEvent(contactData);
            } catch (error) {
                console.error("[WA] Error in contact handler:", error.message || error);
            }
        }));
        // this._unsubscribe.push(socketService.on('message', (msg) => {
        //     try {
        //         this.handleMessageEvent(msg);
        //     } catch (error) {
        //         console.error("[WA] Error in message handler:", error.message || error);
        //     }
        // }));
    }

    _handleQRCode(data) {
        const img = typeof data === 'string' ? data : (data?.qrCode || '');
        if (img) {
            this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
        }
        this.state.stage = 'qr';
        this.state.showQRModal = true;
        // this.state.isLoading = false;
    }

    _handlePhoneMismatch(data) {
        const img = data?.data?.qrCode || '';
        if (img) {
            this.state.qrImage = img.startsWith('data:image') ? img : `data:image/png;base64,${img}`;
        }
        this.state.error = data?.message || 'Phone mismatch. Please scan with the correct number.';
        this.state.stage = 'qr';
        this.state.showQRModal = true;
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
                this.backendApiUrl = 'http://localhost:3000';
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
        return {
           ...chat
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
            this.state.showQRModal = false;
            this.state.isLoading = false;
            this.state.switchingConnection = true;
            this.state.selectedConnection = connection;
            this.state.showConnectionSelector = false;
            this.updateConnectionStatuses();
            this.state.selectedConversation = null;
            this.state.messages = [];
            this._messageIdSet.clear();
            this.state.conversations = [];
            this.state.filteredConversations = [];
            this._initialChatsLoaded = false;
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
    
    async openChatWithContact(contact) {
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
        console.log('send message click')
        if (this.state.editingMessageId) { this.saveEdit(); return; }
        const messageText = this.state.messageInput.trim();
        const hasMedia = this.state.selectedMedia !== null;
        if ((!messageText && !hasMedia) || !this.state.selectedConversation) return;
        const selected = this.state.selectedConversation;
        console.log("selected convo",selected)
        const recipientPhone = selected.phoneNumber?.trim();
        if (!recipientPhone) return;
        if (!this.apiKey || !this.phoneNumber) return;
        const originalMessage = messageText;
        const selectedMedia = this.state.selectedMedia;
        this.state.messageInput = "";
        this.removeSelectedMedia();
        const messageType = selectedMedia ? selectedMedia.type : 'chat';
        try {
            this.state.mediaUploading = true;
            const url = `${this.backendApiUrl}/api/send`;
            let headers;
            try {
                headers = this._getApiHeaders();
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
            if (selectedMedia) {
                const formData = new FormData();
                formData.append('to', recipientPhone);
                formData.append('messageType', messageType);
                formData.append('body', originalMessage || '');
                formData.append('files', selectedMedia.file, selectedMedia.file.name);
                response = await fetch(url, { method: 'POST', headers, body: formData });
            } else {
                headers['Content-Type'] = 'application/json';
                const body = { to: recipientPhone, messageType: messageType, body: originalMessage || '' };
                response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
            }
            this.state.mediaUploading = false;
            const result = await this._parseResponse(response);
            if (!response.ok || !result?.success) {
                this.state.messageInput = originalMessage;
                if (selectedMedia) {
                    this.state.selectedMedia = selectedMedia;
                }
                throw new Error(result?.message || result?.error || 'Failed to send message');
            }
            this.scrollToBottom(true);
            this._updateChatMetadataAndMoveToTop(selected, originalMessage, selectedMedia, messageType);
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
            const response = await fetch(`${this.backendApiUrl}/api/edit`, {
                method: 'PUT',
                headers: {...this._getApiHeaders(), 'Content-Type': 'application/json'},
                body: JSON.stringify({ messageId: messageId, newText: messageText })
            });
            const result = await this._parseResponse(response);
            if (!response.ok || !result?.success) throw new Error(result?.message || 'Failed to edit message');
            message.content = messageText;
            message.is_edited = true;
            message.edited_at = Date.now();
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
        // Extract time directly from ISO string (e.g., "2025-11-25T04:26:23.000Z" -> "04:26")
        const match = dateString.match(/T(\d{2}):(\d{2})/);
        if (match) {
            return `${match[1]}:${match[2]}`;
        }
        // Fallback if format doesn't match
        return dateString;
    }
    
    formatMessageTime(dateString) {
        if (!dateString) return "";
        // Extract time directly from ISO string (e.g., "2025-11-25T04:26:23.000Z" -> "04:26")
        const match = dateString.match(/T(\d{2}):(\d{2})/);
        if (match) {
            return `${match[1]}:${match[2]}`;
        }
        // Fallback if format doesn't match
        return dateString;
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
    
    getFileAcceptTypes() {
        return "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";
    }
    
    openMediaSelector() {
        const fileInput = this.refs?.fileInput || 
                        (this.__owl__?.refs?.fileInput) ||
                        (this.el?.querySelector('.whatsapp-file-input') || this.el?.querySelector('input[type="file"]')) ||
                        document.querySelector('.whatsapp-file-input');
        if (fileInput) fileInput.click();
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
        console.log("leadConversation",conversation)
        const payload = {
            message_id: message.id,
            message_content: message.body || message.content || '',
            message_type: message.messageType || message.type || 'text',
            timestamp: message.timestamp || null,
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
        console.log("chatdataupdate",payload)
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
            if (!msg.reaction || !msg.messageId) return;
            const targetMessage = this.state.messages.find(m => m.id === msg.messageId);
            if (!targetMessage) return;
            
            // Initialize reactions array if it doesn't exist
            if (!targetMessage.reactions) {
                targetMessage.reactions = [];
            }
            
            // Find existing reaction for this emoji
            const existingReaction = targetMessage.reactions.find(r => r.emoji === msg.reaction);
            const senderId = msg.senderId || msg.from || '';
            
            if (existingReaction) {
                // Check if sender already reacted with this emoji
                if (!existingReaction.users.includes(senderId)) {
                    existingReaction.users.push(senderId);
                    existingReaction.count++;
                }
            } else {
                // Create new reaction
                targetMessage.reactions.push({
                    emoji: msg.reaction,
                    count: 1,
                    users: senderId ? [senderId] : []
                });
            }
        } catch (error) {
            console.error("[WA] Error handling reaction event:", error.message || error);
        }
    }
    
    handleMessageEvent(chatData) {
        const msg = chatData.data;
        console.log("msg in handle chat data",msg)
        try {
            if (!msg || !msg.id) return;
            
            // Handle reaction events
            if (msg.reaction && msg.messageId) {
                this.handleReactionEvent(msg);
                return;
            }
            if (msg.deletedType || msg.deletedAt) {
                this.handleMessageDelete(msg);
                return;
            }
            
            const msgId = msg.id;
            const targetConversation = this.findConversationByMessage(msg);
            if (!targetConversation) return;
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
                chat.latestMessage = mappedMessage.content;
                // chat.last_message_type = mappedMessage.type;
                chat.timestamp = mappedMessage.timestamp;
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
            }
            this.filterConversations();
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
                    // Mark as deleted but keep in UI (show "This message was deleted")
                    const deletedMsg = this.state.messages[messageIndex];
                    deletedMsg.isDeleted = true;
                    deletedMsg.deletedType = 'deleted_for_everyone';
                    deletedMsg.deletedAt = msg.deletedAt || new Date().toISOString();
                    // deletedMsg.content = 'This message was deleted';
                    // deletedMsg.body = 'This message was deleted';
                    // Remove media if present
                    // deletedMsg.media_url = null;
                    // deletedMsg.media = null;
                    // deletedMsg.fileName = null;
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
