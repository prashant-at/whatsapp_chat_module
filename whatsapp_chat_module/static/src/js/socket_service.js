/** @odoo-module **/

import {registry} from "@web/core/registry";
// Note: load Socket.IO dynamically inside connect() to avoid top-level await issues

/**
 * Socket.IO Service for WhatsApp Real-time Communication
 */
export class SocketService {

    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.userId = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this._io = null; // cached Socket.IO factory after dynamic import
        this.apiKey = null; // API key for authentication
        this.phoneNumber = null; // Phone number for authentication
        this.clientOrigin = null; // Client origin/IP for authentication
        // Local subscribers registry so UI can react to events without DOM hacks
        this._subscribers = new Map(); // eventName -> Set<handler>
    }
    
    setAuthCredentials(apiKey, phoneNumber, origin = '127.0.0.1') {
        console.log("[WA][Socket] setAuthCredentials called:");
        
        this.apiKey = apiKey;
        this.phoneNumber = phoneNumber;
        // Store origin - default to 127.0.0.1 for now, can be made dynamic
        this.clientOrigin = origin || window.location.origin;
        
        
    }

    hasMatchingCredentials(apiKey, phoneNumber, origin) {
        const currentApiKey = this.apiKey || '';
        const currentPhone = this.phoneNumber || '';
        const currentOrigin = this.clientOrigin || window.location.origin;
        const targetOrigin = origin || window.location.origin;
        
        return (
            currentApiKey === (apiKey || '') &&
            currentPhone === (phoneNumber || '') &&
            currentOrigin === targetOrigin
        );
    }

    async disconnect() {
        if (this.socket) {
            // Remove all event listeners to prevent memory leaks
            this.socket.removeAllListeners();
            // Disconnect socket
            this.socket.disconnect();
            // Clear references
            this.socket = null;
            this.isConnected = false;
        }
    }

    async connect(userId, options = {}) {
        try {
            // Get credentials that will be used for connection
            const apiKey = this.apiKey || '';
            const phoneNumber = this.phoneNumber || '';
            const clientOrigin = this.clientOrigin || window.location.origin;
            
            // Check if already connected with matching credentials
            if (this.socket && this.isConnected) {
                if (this.hasMatchingCredentials(apiKey, phoneNumber, clientOrigin)) {
                    return;
                } else {
                    await this.disconnect();
                }
            }
            
            // If socket exists but not connected, clean it up
            if (this.socket && !this.isConnected) {
               
                await this.disconnect();
            }

            
            
            // Import Socket.IO client dynamically
            if (!this._io) {
                const mod = await import('https://cdn.socket.io/4.7.2/socket.io.esm.min.js');
                console.log("mod", mod);
                this._io = mod.default;
            }
            
            this.userId = userId || null;
            
            
            // Socket.IO connection options with authentication
            const socketOptions = {
                transports: ['websocket'],
                auth: {
                    'x-api-key': apiKey,
                    'x-phone-number': phoneNumber,
                    'origin': clientOrigin, // Used as systemIPAddress on backend
                },
            };
            
            if (apiKey && phoneNumber) {
                
            } else {
                
            }

            // Connect to your backend (local Socket.IO server)
            this.socket = this._io('http://localhost:3000', socketOptions);

            this.setupEventHandlers();
            
            
            
        } catch (error) {
            console.error("[WA][Socket] Failed to initialize Socket.IO:", error);
            throw error;
        }
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            socketId: this.socket ?. id || null,
            userId: this.userId
        };
    }

    setupEventHandlers() {
        if (!this.socket) 
            return;
        // Connection events
        this.socket.on('connect', () => {
            console.log("🔗 [Socket Event] CONNECT - Socket.IO connected:", this.socket.id);
            this.isConnected = true;
            // Backend automatically joins socket.id to room, no need to emit join_user
            console.log("🔗 [Socket Event] CONNECT - Socket connected successfully");
            this._emitLocal('connect', { socketId: this.socket.id });
        });

        this.socket.on('disconnect', (reason) => {
            console.log("🔌 [Socket Event] DISCONNECT - Socket.IO disconnected:", reason);
            this.isConnected = false;
            
            // Check if server disconnected due to authentication failure
            if (reason === 'io server disconnect') {
                console.error(" Server forcefully disconnected. Possible reasons:");
                // Don't auto-reconnect on server disconnect - it will just fail again
                return;
            }
            
            this.reconnectAttempts = 0;
            this.handleReconnection();
            this._emitLocal('disconnect', { reason });
        });

        this.socket.on('connect_error', (error) => {
            console.error(" [Socket Event] CONNECT_ERROR - Error message:", error.message);
            console.error(" [Socket Event] CONNECT_ERROR - Error stack:", error.stack);
            this.isConnected = false;
            this._emitLocal('connect_error', error);
        });

        // Listen for any error or message events from server
        // this.socket.onAny((eventName, ...args) => {
        //     console.log(`🔔 [Socket Event] Received event '${eventName}':`);
        // });

        // WhatsApp specific events - Backend wraps all events in { data: ... }
        this.socket.on('qr_code', ({ data }) => {
           
            
            // Update UI instantly via DOM
            this.updateQrPopupUI(data);
            
            // Also inform backend via RPC
            this.sendRPC('qr_code', data);
            this._emitLocal('qr_code', data);
        });

        this.socket.on('phone_mismatch', ({ data }) => {
            
            // Update UI instantly via DOM
            this.updateQrPopupUI(data);
            
            // Also inform backend via RPC
            this.sendRPC('phone_mismatch', data);
            this._emitLocal('phone_mismatch', data);
        });

        this.socket.on('status', ({ data }) => {
            this.sendRPC('status', data);
            this._emitLocal('status', data);
        });

        this.socket.on('message', ({ data }) => {
            // this.sendRPC('message', data);
            this._emitLocal('message', data);
        });

        this.socket.on('chat', ({ data }) => {
            // this.sendRPC('chat', data);
            this._emitLocal('chat', data);
        });
    }

    // Subscribe to local events (returns unsubscribe fn)
    on(eventName, handler) {
        if (!this._subscribers.has(eventName)) {
            this._subscribers.set(eventName, new Set());
        }
        this._subscribers.get(eventName).add(handler);
        return () => this.off(eventName, handler);
    }

    off(eventName, handler) {
        const set = this._subscribers.get(eventName);
        if (set) set.delete(handler);
    }

    _emitLocal(eventName, payload) {
        const set = this._subscribers.get(eventName);
        if (set) {
            set.forEach((cb) => {
                try { cb(payload); } catch (e) { console.warn('[WA][Socket] subscriber error', e); }
            });
        }
    }

    handleReconnection() {
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error("[WA][Socket] Max reconnection attempts reached, giving up");
            return;
        }
        this.reconnectAttempts ++;
        setTimeout(() => this.connect(this.userId), this.reconnectDelay);
    }

    /**
     * Helper method to update QR popup UI directly via DOM manipulation
     * This provides instant visual updates without requiring popup re-opening
     * @param {string|object} data - QR code data (string or object with qrCode property)
     * @param {number} retryCount - Internal retry counter (default: 0)
     */
    updateQrPopupUI(data, retryCount = 0) {
        let qrCode = null;
        if (typeof data === 'string') {
            // If data is a string, treat it as the QR code directly
            qrCode = data;
        } else if (data && typeof data === 'object') {
            // If data is an object, extract properties
            qrCode = data.qrCode || data.qr_code || data.qrCodeImage || null;
        }
        
        // 1️⃣ Update QR image directly - try multiple selectors for compatibility
        const qrImg = document.querySelector('.o_field_widget[name="qr_code_image_bin"] img') || 
                      document.querySelector('.qr-image img') ||
                      document.querySelector('[name="qr_code_image_bin"] img');
        
        if (qrImg && qrCode) {
            const qrSrc = qrCode.startsWith('data:image')
                ? qrCode
                : `data:image/png;base64,${qrCode}`;

            // Optional fade animation
            qrImg.style.opacity = '0.5';
            setTimeout(() => {
                qrImg.src = qrSrc;
                qrImg.style.opacity = '1';
            }, 100);
            console.log('[QR Popup]  Updated QR image');
        } else if (!qrImg) {
            // Retry mechanism: if element not found and we haven't exceeded max retries
            const maxRetries = 5;
            const retryDelay = 60; // Start with 200ms delay
            
            if (retryCount < maxRetries) {
                console.log(`[QR Popup]  QR image element not found (attempt ${retryCount + 1}/${maxRetries}), retrying in ${retryDelay}ms...`);
                setTimeout(() => {
                    this.updateQrPopupUI(data, retryCount + 1);
                }, retryDelay);
                return; // Exit early, will retry
            } else {
                console.warn('[QR Popup]  QR image element not found after max retries - popup may not be open');
            }
        } else if (qrImg && !qrCode) {
            console.warn('[QR Popup]  QR image found but no qrCode in data');
        }

        // 2️⃣ Update status message text
        const msgElem = document.querySelector('.o_field_widget[name="message"]') ||
                        document.querySelector('field[name="message"]');
        if (msgElem && data.message) {
            msgElem.textContent = data.message;
            console.log('[QR Popup]  Updated QR message');
        }


        // 5️⃣ Update QR data field if exists (for form state)
        const qrDataField = document.querySelector('.o_field_widget[name="qr_code_image"]') ||
                           document.querySelector('field[name="qr_code_image"]');
        if (qrDataField && qrCode) {
            const input = qrDataField.querySelector('input');
            if (input) {
                input.value = qrCode;
            }
            console.log('[QR Popup] ✅Updated QR data field');
        }
    }

    sendRPC(type, data) {
        console.log(`[Socket Event] ${type} received:`, data);
        fetch('/web/dataset/call_kw', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: {
                        model: 'whatsapp.qr.popup',
                        method: 'do_something',
                        args: [
                            'rpc', {type,data}
                        ],
                        kwargs: {}
                    }
                }
            )
        })
        .then(response => {
            if (!response.ok) {
                return response.json().catch(() => ({}));
            }
            return response.json();
        })
        .then((payload) => {
            if (payload.error) {
                console.error(`[Socket Event] RPC error response:`, payload.error);
                return;
            }
            
            const result = payload && payload.result;
            if (!result) {
                console.warn('[Socket Event]  RPC returned no result:');
                return;
            }

            // Execute server-returned actions: act_window (refresh popup) or display_notification
            const actionService = window.odoo?.env?.services?.action || window.odoo?.__env__?.services?.action;
            if (actionService && (result.type === 'ir.actions.act_window' || result.tag === 'display_notification')) {
                actionService.doAction(result);
                return;
            }

            // Backward path: explicit phone_mismatch refresh event
            if (type === 'phone_mismatch' && result.res_model === 'whatsapp.qr.popup' && result.res_id) {
                window.dispatchEvent(new CustomEvent('whatsapp_qr_refresh', { detail: { popup_id: result.res_id } }));
            }
        })
        .catch(error => {
            console.error('[Socket Event] Error details:', error.message, error.stack);
        });
    }
};

// Export a singleton so other modules can use the same service instance
const socketService = new SocketService();
export default socketService;




