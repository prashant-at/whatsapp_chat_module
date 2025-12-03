/** @odoo-module **/

import { registry } from "@web/core/registry";
import socketService from "./socket_service";


// 1️⃣ First, register socketService as a proper Odoo service
registry.category("services").add("socket_service", {
    dependencies: [],
    start(env) {
        socketService._env = env;  // Give it access to env
        return socketService;
    }
});
// 2️⃣ Then register the initializer that depends on socket_service
registry.category("services").add("wa_socket_initializer", {
    dependencies: ["bus_service", "socket_service"],  // Wait for both services to be ready
    async start(env, { bus_service }) {
        try {
            const svc = env.services.socket_service;  // Now guaranteed to be available
            
            // Listen for "Connect" button clicks (high priority)
            // bus_service is guaranteed to be available via dependencies
            const handleConnectNotification = async (ev) => {
                // Extract notifications from event (handle different formats)
                const notifications = Array.isArray(ev.detail) 
                    ? ev.detail 
                    : ev.detail?.notifications || (ev.detail ? [ev.detail] : []);
                
                for (const notification of notifications) {
                    // Extract message from [channel, message] tuple or direct message
                    const message = Array.isArray(notification) && notification.length >= 2 
                        ? notification[1] 
                        : notification;
                    
                    // Only process whatsapp_connect_socket notifications
                    if (message?.type !== 'whatsapp_connect_socket') {
                        continue;
                    }
                    
                    const payload = message.payload || message;
                    if (payload.action !== 'connect_socket' || payload.priority !== 'high') {
                        continue;
                    }
                    
                    const { connection_id, api_key, phone_number, origin } = payload;
                    if (!api_key || !phone_number) {
                        console.error("[WA][Init] Missing credentials in connect notification");
                        continue;
                    }
                    
                    const targetOrigin = origin || window.location.origin;
                    
                    // Handle existing socket connection
                    if (svc.socket) {
                        if (svc.hasMatchingCredentials(api_key, phone_number, targetOrigin)) {
                            // Already connected with same credentials
                            return;
                        }
                        // Disconnect and reconnect with new credentials
                        await svc.disconnect();
                    }
                    
                    // Set credentials and connect
                    svc.setAuthCredentials(api_key, phone_number, targetOrigin);
                    try {
                        await svc.connect();
                        
                        // Wait for socket to actually be connected
                        // Check connection status with timeout
                        let attempts = 0;
                        const maxAttempts = 20; // 2 seconds max (20 * 100ms)
                        while (!svc.isConnected && attempts < maxAttempts) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                            attempts++;
                        }
                        
                        // Send confirmation to Python that socket is connected
                        if (svc.isConnected && connection_id) {
                            const orm = env.services.orm;
                            try {
                                await orm.call(
                                    'whatsapp.connection',
                                    'confirm_socket_connected',
                                    [[connection_id]]
                                );
                            } catch (e) {
                                console.error("[WA][Init] Failed to confirm socket connection:", e);
                            }
                        }
                    } catch (e) {
                        console.error("[WA][Init] Socket connection failed:", e);
                    }
                    return; // Process only first matching notification
                }
            };
            
            bus_service.addEventListener("notification", handleConnectNotification);
            
            // Try to connect with default connection on startup
            try {
                const orm = env.services.orm;
                const connections = await orm.searchRead(
                    "whatsapp.connection",
                    [],
                    ["name", "from_field", "api_key", "is_default"]
                );
                
                // Priority: User's default connection > Global default connection
                let defaultConnection = null;
                
                // Try user's default connection first
                const userId = env.services.user?.userId;
                if (userId) {
                    try {
                        const [currentUser] = await orm.searchRead(
                            "res.users",
                            [["id", "=", userId]],
                            ["whatsapp_default_connection_id"]
                        );
                        if (currentUser?.whatsapp_default_connection_id) {
                            const userDefaultId = currentUser.whatsapp_default_connection_id[0];
                            defaultConnection = connections.find(c => c.id === userDefaultId);
                        }
                    } catch (error) {
                        // Silently fall back to global default
                    }
                }
                
                // Fallback to global default
                if (!defaultConnection) {
                    defaultConnection = connections.find(c => c.is_default);
                }
                
                // Connect if valid default connection found
                if (defaultConnection?.api_key && defaultConnection.from_field) {
                    const origin = window.location.origin;
                    
                    // Skip if already connected with same credentials
                    if (svc.socket && svc.isConnected) {
                        if (svc.hasMatchingCredentials(defaultConnection.api_key, defaultConnection.from_field, origin)) {
                            return {};
                        }
                    }
                    
                    svc.setAuthCredentials(
                        defaultConnection.api_key.trim(),
                        defaultConnection.from_field,
                        origin
                    );
                    await svc.connect();
                }
            } catch (e) {
                // Silently fail - will connect when credentials are set via notification
            }
        } catch (e) {
            console.error("[WA][Init] Service initialization failed:", e);
        }
        return {};
    },
});



