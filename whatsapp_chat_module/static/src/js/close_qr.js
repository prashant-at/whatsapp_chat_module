/** @odoo-module **/

import { registry } from "@web/core/registry";
import { session } from "@web/session";

/**
 * Listen for 'qr_popup' bus notifications and close the popup window
 * when backend sends a close signal.
 */
function setupQrPopupBus(env) {
    const bus = env.services.bus_service;
    const notificationService = env.services.notification;
    const actionService = env.services.action;
    const dialogService = env.services.dialog;
    const dbName = session.db || env.services.user?.db?.name || 'default';
    const partnerId = env.services.user?.partnerId || null;
    const subscribedChannels = new Set();

    // Subscribe to QR popup channel
    const subscribeToQrPopupChannel = (popupId) => {
        if (!popupId) return;
        const channel = `${dbName}_qr_popup_${popupId}`;
        if (subscribedChannels.has(channel)) return;
        
        try {
            bus.addChannel(channel);
            subscribedChannels.add(channel);
        } catch (error) {
            console.error(`[QR Popup Bus] Error subscribing to channel ${channel}:`, error);
        }
    };

    // Extract popup ID from form view (simplified - keep only reliable methods)
    const extractPopupId = (formView) => {
        if (!formView) return null;
        
        // Method 1: Data attributes
        let popupId = formView.dataset?.resId || formView.dataset?.res_id ||
                     formView.getAttribute('data-res-id') || formView.getAttribute('data-res_id');
        
        // Method 2: Hidden input field
        if (!popupId) {
            const idInput = formView.querySelector?.('input[name="id"]');
            if (idInput) popupId = idInput.value || idInput.getAttribute('value');
        }
        
        // Method 3: Odoo internal props
        if (!popupId && formView.__owl__) {
            popupId = formView.__owl__.props?.resId || formView.__owl__.props?.res_id;
        }
        
        // Method 4: Traverse component tree
        if (!popupId && formView.__owl__) {
            try {
                let component = formView.__owl__;
                for (let i = 0; i < 5 && component && !popupId; i++) {
                    if (component.props?.resId || component.props?.res_id) {
                        popupId = String(component.props.resId || component.props.res_id);
                        break;
                    }
                    component = component.parent || component.__parent__;
                }
            } catch (e) {
                // Silent fail
            }
        }
        
        return popupId ? String(popupId) : null;
    };

    // Detect QR popup form and subscribe
    const detectAndSubscribe = (formView) => {
        if (!formView) return;
        
        const isQrPopupForm = 
            formView.dataset?.model === 'whatsapp.qr.popup' ||
            formView.getAttribute('data-model') === 'whatsapp.qr.popup' ||
            formView.__owl__?.props?.resModel === 'whatsapp.qr.popup' ||
            (formView.querySelector?.('field[name="qr_code_image_bin"]') && 
             formView.querySelector?.('field[name="countdown_display"]'));
        
        if (isQrPopupForm) {
            const popupId = extractPopupId(formView);
            if (popupId) {
                const modal = formView.closest?.('.modal') || formView.closest?.('.o_dialog') || formView.closest?.('.o_technical_modal');
                if (modal) {
                    modal.classList.add('o_whatsapp_qr_modal');
                    modal.dataset.popupId = popupId;
                }
                subscribeToQrPopupChannel(popupId);
            } else {
                // Retry once after delay
                setTimeout(() => {
                    const retryId = extractPopupId(formView);
                    if (retryId) subscribeToQrPopupChannel(retryId);
                }, 500);
            }
        }
    };

    // Monitor DOM for QR popup forms
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                
                let formView = null;
                if (node.matches?.('.o_form_view') || node.matches?.('form')) {
                    formView = node;
                } else {
                    formView = node.querySelector?.('.o_form_view') || node.querySelector?.('form');
                }
                
                if (formView) detectAndSubscribe(formView);
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    
    // Check for existing popup on initialization
    [100, 500].forEach((delay) => {
        setTimeout(() => {
            const existingForm = document.querySelector('.o_form_view[data-model="whatsapp.qr.popup"]') ||
                                document.querySelector('form[data-model="whatsapp.qr.popup"]');
            if (existingForm) {
                const popupId = extractPopupId(existingForm);
                if (popupId) subscribeToQrPopupChannel(popupId);
            }
        }, delay);
    });

    // Handle bus notifications
    bus.addEventListener("notification", (ev) => {
        let notifications = [];
        
        if (Array.isArray(ev.detail)) {
            // Format 1: Direct array of notification objects
            // Don't filter here - process all notifications and check type inside loop
            notifications = ev.detail
                .filter(notif => notif.type === 'qr_popup_close' || notif.type === 'whatsapp_compose_close')
                .map(notif => {
                    const channel = notif.payload?.popup_id 
                        ? [dbName, `${dbName}_qr_popup_${notif.payload.popup_id}`]
                        : [dbName, 'res.partner', partnerId];
                    return [channel, { type: notif.type, payload: notif.payload }];
                });
        } else if (ev.detail?.notifications) {
            // Format 2: Traditional [channel, message] tuples
            notifications = ev.detail.notifications;
        }
        
        notifications.forEach((notification) => {
            const [channel, message] = notification;
            
            // Handle QR popup close
            if (message?.type === "qr_popup_close") {
                const channelArray = Array.isArray(channel) ? channel : [channel];
                const isQrPopupChannel = channelArray.length >= 2 && 
                                         channelArray[0] === dbName &&
                                         channelArray[1]?.startsWith(`${dbName}_qr_popup_`);
                const isUserPartnerChannel = channelArray.length === 3 &&
                                            channelArray[0] === dbName &&
                                            channelArray[1] === 'res.partner' &&
                                            channelArray[2] === partnerId;
                
                if (!isQrPopupChannel && !isUserPartnerChannel) return;

                const payload = message.payload || {};

                // Unsubscribe from channel
                if (payload.popup_id) {
                    const channelName = `${dbName}_qr_popup_${payload.popup_id}`;
                    if (subscribedChannels.has(channelName)) {
                        bus.deleteChannel(channelName);
                        subscribedChannels.delete(channelName);
                    }
                }

                // Show notification
                if (notificationService && payload.message) {
                    notificationService.add(payload.message, {
                        title: payload.title || "WhatsApp",
                        type: payload.type || "success",
                        sticky: payload.sticky ?? false,
                    });
                }

                // Close modal
                setTimeout(() => {
                    // Try dialog service first (most reliable)
                    if (dialogService?.closeAll) {
                        const hasActiveDialog = document.querySelector('.o_dialog, .modal.show, .o_technical_modal');
                        if (hasActiveDialog) {
                            dialogService.closeAll();
                            return;
                        }
                    }
                }, 100);
                
                return; // Exit early
            }
            // Handle compose wizard close (direct flow)
            else if (message?.type === "whatsapp_compose_close") {
                const channelArray = Array.isArray(channel) ? channel : [channel];
                const isUserPartnerChannel = channelArray.length === 3 &&
                                            channelArray[0] === dbName &&
                                            channelArray[1] === 'res.partner' &&
                                            channelArray[2] === partnerId;
                
                if (!isUserPartnerChannel) return;
                
                const payload = message.payload || {};
                
                // 1. Show notification first
                if (notificationService && payload.message) {
                    notificationService.add(payload.message, {
                        title: payload.title || "WhatsApp",
                        type: payload.type || "success",
                        sticky: payload.sticky ?? false,
                    });
                }
                
                // 2. Close compose wizard modal after short delay (to ensure notification is visible)
                setTimeout(() => {
                    if (dialogService?.closeAll) {
                        const hasActiveDialog = document.querySelector('.o_dialog, .modal.show, .o_technical_modal');
                        if (hasActiveDialog) {
                            dialogService.closeAll();
                        }
                    }
                }, 500); // Slightly longer delay to ensure notification is shown
                
                return; // Exit early
            }
        });
    });
}

// Register the service
registry.category("services").add("whatsapp_qr_popup_bus", {
    dependencies: ["bus_service", "notification", "action", "dialog"],
    start(env) {
        setupQrPopupBus(env);
        return {};
    },
});
