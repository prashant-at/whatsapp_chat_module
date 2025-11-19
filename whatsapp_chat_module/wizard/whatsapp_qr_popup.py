# -*- coding: utf-8 -*-

import datetime
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging
import time
import requests
import json
from datetime import timedelta

_logger = logging.getLogger(__name__)


class WhatsAppQRPopup(models.TransientModel):
    _name = 'whatsapp.qr.popup'
    _description = 'WhatsApp QR Code Popup'

    qr_code_image = fields.Text('QR Code Data', readonly=True)
    # Binary used by the image widget (kept in sync with qr_code_image)
    qr_code_image_bin = fields.Binary('QR Code', compute='_compute_qr_code_image_bin', store=False, readonly=True)
    qr_code_filename = fields.Char('QR Code Filename', readonly=True)
    from_number = fields.Char('From Number', readonly=True)
    from_name = fields.Char('From Name', readonly=True)
    message = fields.Text('Message', readonly=True)
    
    # Store original wizard data
    original_wizard_id = fields.Many2one('whatsapp.chat.simple.wizard', string='Original Wizard')
    original_campaign_id = fields.Many2one('whatsapp.marketing.campaign', string='Original Campaign')
    original_test_wizard_id = fields.Many2one('whatsapp.marketing.campaign.test', string='Original Test Wizard')
    # Store test data in case test wizard is closed
    test_phone_to = fields.Char('Test Phone Number', readonly=True, help='Phone number for test message')
    test_campaign_id = fields.Many2one('whatsapp.marketing.campaign', string='Test Campaign', readonly=True, help='Campaign for test message')
    # Live update counter (direct field for popup updates)
    qr_update_count = fields.Integer(
        string='QR Updates',
        default=0,
        readonly=True,
    )
    
    # QR Management fields
    qr_expires_at = fields.Datetime('QR Expires At', readonly=True)
    countdown_seconds = fields.Integer('Countdown Seconds', default=120)  # 2 minutes
    is_expired = fields.Boolean('Is Expired', default=False)
    retry_count = fields.Integer('Retry Count', default=0)
    max_retries = fields.Integer('Max Retries', default=3)
    last_qr_string = fields.Char('Last QR String', readonly=True)
    api_key = fields.Char('API Key', readonly=True)
    phone_number = fields.Char('Phone Number', readonly=True)
    
    # Context storage for chatter logging
    original_context = fields.Text('Original Context', readonly=True, help='Stored context from wizard for chatter logging')
    active_model = fields.Char('Active Model', readonly=True, help='Model name for chatter logging')
    active_id = fields.Integer('Active ID', readonly=True, help='Record ID for chatter logging')
    
    # Computed field for countdown display
    countdown_display = fields.Char('Countdown Display', compute='_compute_countdown_display', store=False)
    
    @api.depends('qr_expires_at', 'countdown_seconds')
    def _compute_countdown_display(self):
        """Compute countdown display text"""
        for rec in self:
            if rec.qr_expires_at:
                now = fields.Datetime.now()
                time_diff = (rec.qr_expires_at - now).total_seconds()
                
                if time_diff <= 0:
                    rec.countdown_display = 'EXPIRED'
                elif time_diff <= 30:
                    rec.countdown_display = f'{int(time_diff)}s'
                elif time_diff <= 60:
                    rec.countdown_display = f'{int(time_diff)}s'
                else:
                    rec.countdown_display = f'{int(time_diff / 60)}m'
            else:
                rec.countdown_display = '2m'

    @api.model
    def create_from_socket_event(self, vals):
        """Create QR popup from Socket.IO event"""
        try:
            _logger.info(f" [QR Popup] Creating popup from socket event: {vals}")
            
            # Create the popup record
            popup = self.create({
                'qr_code_image': vals.get('qr_code_image', ''),
                'qr_code_filename': vals.get('qr_code_filename', 'whatsapp_qr_code.png'),
                'from_number': vals.get('from_number', ''),
                'from_name': vals.get('from_name', ''),
                'message': vals.get('message', 'Please scan QR code to connect WhatsApp'),
                'api_key': vals.get('api_key', ''),
                'phone_number': vals.get('phone_number', ''),
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                'countdown_seconds': 120,
                'is_expired': False,
                'retry_count': 0,
                'last_qr_string': vals.get('qr_code_image', '')[:100] if vals.get('qr_code_image') else ''
            })
            
            _logger.info(f" [QR Popup] Created popup with ID: {popup.id}")
            
            # Return the popup ID for opening
            return popup.id
            
        except Exception as e:
            _logger.error(f" [QR Popup] Error creating popup from socket event: {e}")
            raise UserError(_("Failed to create QR popup: %s") % str(e))

    def write(self, vals):
        """Override write method to handle QR updates"""
        _logger.info(f" [QR Popup] Writing to QR popup {self.ids}: {vals}")
        
        # If updating QR code, reset expiration timer
        if 'qr_code_image' in vals:
            vals.update({
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                'countdown_seconds': 120,
                'is_expired': False,
            })
            _logger.info(f"[QR Popup] QR code updated, resetting expiration timer")
            
            # Remove qr_code_image_bin from vals to let computed field handle it
            if 'qr_code_image_bin' in vals:
                del vals['qr_code_image_bin']
                _logger.info(f" [QR Popup] Removed qr_code_image_bin from vals, letting computed field handle it")
        
        result = super().write(vals)
        _logger.info(f" [QR Popup] Write completed for {self.ids}")
        
        # If this is a QR update, trigger UI refresh via notification
        if 'qr_code_image' in vals and self.env.context.get('refresh_popup_after_update'):
            _logger.info(f" [QR Popup] QR updated, triggering UI refresh for popup {self.ids[0]}")
            # Store the refresh action in a way that can be accessed
            self.env['ir.actions.act_window'].create({
                'name': 'QR Popup Refresh',
                'res_model': 'whatsapp.qr.popup',
                'res_id': self.ids[0],
                'view_mode': 'form',
                'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                'target': 'new',
            })
        
        return result

    def update_qr_from_socket(self, qr_data):
        """Update QR popup from socket event and refresh UI"""
        try:
            _logger.info(f" [QR Popup] Updating QR from socket for popup {self.ids}")
            
            # Find the latest popup record
            popup = self.env['whatsapp.qr.popup'].search([], order='create_date desc', limit=1)
            if not popup:
                _logger.warning(f" [QR Popup] No popup found for socket update")
                return False
            
            # Extract QR data
            qr_img = qr_data.get('qrCode') or qr_data.get('qr_img') or qr_data.get('qr_code_image')
            if not qr_img:
                _logger.warning(f" [QR Popup] No QR image data in socket event")
                return False
            
            # Ensure base64 prefix
            if not qr_img.startswith('data:image'):
                qr_img = f"data:image/png;base64,{qr_img}"
            
            # Check for duplicate QR (prevent unnecessary updates)
            if popup.last_qr_string and qr_img.startswith(popup.last_qr_string):
                _logger.info(f"[QR Popup] Duplicate QR detected, skipping update")
                return False
            
            # Increment counter
            current_count = popup.qr_update_count or 0
            new_count = current_count + 1
            
            # Update popup with refresh context
            update_vals = {
                'qr_code_image': qr_img,
                'qr_code_filename': 'whatsapp_qr_code.png',
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=popup.countdown_seconds),
                'is_expired': False,
                'qr_update_count': new_count,
                'last_qr_string': qr_img[:100],  # Store first 100 chars for deduplication
                'message': 'Please scan the updated QR code.'
            }
            
            # Write with refresh context
            popup.with_context(refresh_popup_after_update=True).write(update_vals)
            
            _logger.info(f" [QR Popup] Updated popup ID {popup.id} with new QR code (update #{new_count})")
            return True
            
        except Exception as e:
            _logger.error(f" [QR Popup] Error updating QR from socket: {e}")
            return False

    @api.model
    def handle_socket_qr_update(self, qr_data):
        """Handle QR updates from socket events - called directly"""
        try:
            _logger.info(f" [QR Popup] Direct socket QR update: {qr_data}")
            
            # Find the latest popup record
            popup = self.env['whatsapp.qr.popup'].search([], order='create_date desc', limit=1)
            if not popup:
                _logger.warning(f" [QR Popup] No popup found for socket update")
                return False
            
            # Extract QR code
            qr_code = qr_data.get('qrCode') if isinstance(qr_data, dict) else qr_data
            
            if not qr_code:
                _logger.warning(f" [QR Popup] No QR code data in socket event")
                return False
            
            # Ensure base64 prefix
            if not qr_code.startswith('data:image'):
                qr_code = f"data:image/png;base64,{qr_code}"
            
            # Check for duplicate QR (prevent unnecessary updates)
            if popup.last_qr_string and qr_code.startswith(popup.last_qr_string):
                _logger.info(f" [QR Popup] Duplicate QR detected, skipping update")
                return False
            
            # Increment counter
            current_count = popup.qr_update_count or 0
            new_count = current_count + 1
            
            # Update popup
            update_vals = {
                'qr_code_image': qr_code,
                'qr_code_filename': 'whatsapp_qr_code.png',
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=popup.countdown_seconds),
                'is_expired': False,
                'qr_update_count': new_count,
                'last_qr_string': qr_code[:100],  # Store first 100 chars for deduplication
                'message': 'Please scan the updated QR code.'
            }
            
            # Write to popup
            popup.write(update_vals)
            
            _logger.info(f" [QR Popup] Updated popup ID {popup.id} with new QR code (update #{new_count})")
            return True
            
        except Exception as e:
            _logger.error(f" [QR Popup] Error in handle_socket_qr_update: {e}")
            return False

    def _handle_phone_mismatch_event(self, mismatch_data):
        """Handle phone mismatch events from socket"""
        try:
            _logger.info(f" [QR Popup] Handling phone mismatch event: {mismatch_data}")
            
            # Find popup by original_wizard_id to ensure we update the correct one
            # Try to get the wizard from context or search all popups with original_wizard_id
            popup = None
            wizard_id = self.env.context.get('active_id')  # Try to get from context
            
            if wizard_id:
                # Search for popup related to this wizard
                from odoo.addons.base.models.ir_model import Model
                try:
                    wizard = self.env[self.env.context.get('active_model')].browse(wizard_id)
                    if hasattr(wizard, 'qr_popup_id') and wizard.qr_popup_id:
                        popup = wizard.qr_popup_id
                except:
                    pass
            
            # Fallback: find any non-expired popup with original_wizard_id
            if not popup:
                popup = self.env['whatsapp.qr.popup'].search([
                    ('original_wizard_id', '!=', False),
                    ('is_expired', '=', False)
                ], order='create_date desc', limit=1)
            
            # Last resort: find any non-expired popup
            if not popup:
                popup = self.env['whatsapp.qr.popup'].search([
                    ('is_expired', '=', False)
                ], order='create_date desc', limit=1)
                
            if not popup:
                _logger.warning(f" [QR Popup] No popup found for phone mismatch event")
                return False
            
            _logger.info(f"📱 [QR Popup] Found popup ID: {popup.id} for mismatch update")
            
            # Extract data - handle nested structure
            inner_data = mismatch_data
            if isinstance(mismatch_data, dict) and 'data' in mismatch_data:
                inner_data = mismatch_data['data']
            
            # Extract message and new QR code
            message = inner_data.get('message', 'Phone number mismatch! Please scan with the correct number.')
            qr_code = inner_data.get('qrCode')
            
            _logger.info(f" [QR Popup] Phone mismatch details - Message: {message}")
            _logger.info(f" [QR Popup] New QR code provided: {bool(qr_code)}")
            
            if qr_code:
                # Ensure base64 prefix
                if not qr_code.startswith('data:image'):
                    qr_code = f"data:image/png;base64,{qr_code}"
                
                # Update popup with new QR code/new_message
                popup.write({
                    'qr_code_image': qr_code,
                    'qr_code_filename': 'whatsapp_qr_code_mismatch.png',
                    'message': message,
                    'qr_expires_at': fields.Datetime.now() + timedelta(seconds=popup.countdown_seconds),
                    'is_expired': False,
                    'last_qr_string': qr_code[:100]
                })
                
                _logger.info(f" [QR Popup] Successfully updated QR code for phone mismatch - Popup ID: {popup.id}")
                _logger.info(f" [QR Popup] Updated message shown to user: {message}")
                
                # Return action to refresh the UI modal with updated QR code
                return {
                    'type': 'ir.actions.act_window',
                    'name': 'WhatsApp Authentication Required',
                    'res_model': 'whatsapp.qr.popup',
                    'res_id': popup.id,
                    'view_mode': 'form',
                    'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                    'target': 'new',
                    'context': self.env.context,
                }
            else:
                _logger.warning(f" [QR Popup] No QR code in phone mismatch event")
                return False
            
        except Exception as e:
            _logger.error(f" [QR Popup] Error handling phone mismatch event: {e}")
            return False

    def _handle_status_event(self, status_data):
        """Handle status events from socket"""
        try:
            _logger.info(f" [QR Popup] Handling status event: {status_data}")
            
            # Extract status type - handle nested structure {data: {type: 'ready', message: '...'}}
            status_type = None
            if isinstance(status_data, dict):
                # First try direct access
                status_type = status_data.get('type')
                # If not found, try nested structure
                if not status_type and 'data' in status_data:
                    inner_data = status_data['data']
                    if isinstance(inner_data, dict):
                        status_type = inner_data.get('type')
                        message = inner_data.get('message', '')
                        _logger.info(f" [QR Popup] Found nested status: type={status_type}, message={message}")
            
            if not status_type:
                _logger.warning(f" [QR Popup] No status type found in data: {status_data}")
                return False
            
            # Around line 355-356, fix:

            time_threshold = datetime.datetime.now() - timedelta(minutes=2)
            time_threshold_str = fields.Datetime.to_string(time_threshold)
            # Find the latest QR popup
            popup = self.env['whatsapp.qr.popup'].search([('create_date', '>=', time_threshold_str)], order='create_date desc', limit=1)
          
            if not popup:
                _logger.warning(f" [QR Popup] No popup found for status event")
                return False
            
            # Handle different status types
            # if status_type == 'authenticated':
            #     _logger.info(f"[QR Popup] Authenticated successfully")
            #     popup.write({'message': 'Authenticated! WhatsApp is connecting...'})
            #     return True
            
            elif status_type == 'ready':
                _logger.info(f" [QR Popup] WhatsApp is ready, closing popup and sending messages")
                
                # Find the latest NON-EXPIRED QR popup (exclude old/stale ones)
                popup = self.env['whatsapp.qr.popup'].search([
                    ('create_date', '>=', time_threshold_str)
                ], order='create_date desc', limit=1)
                if not popup:
                    _logger.warning(f" [QR Popup] No active popup found for ready status")
                    return False
                
                # Trigger message sending - check which type this popup is
                # Test messages take priority (check first)
                if (popup.original_test_wizard_id or popup.test_phone_to) and not popup.original_campaign_id:
                    # Test wizard popup - trigger test resend
                    if popup.original_test_wizard_id:
                        # Try to use test wizard if it still exists
                        try:
                            test_wizard = popup.original_test_wizard_id
                            if test_wizard.exists():
                                _logger.info(f" [QR Popup] Triggering test resend for test wizard {test_wizard.id}")
                                test_wizard.resend_test(popup=popup)
                            else:
                                # Test wizard was closed, use stored data
                                _logger.info(f" [QR Popup] Test wizard closed, using stored test data")
                                if popup.test_campaign_id and popup.test_phone_to:
                                    result = popup.test_campaign_id._send_to_recipient_via_api(
                                        popup.test_phone_to.strip(),
                                        'Test Recipient',
                                        popup.test_campaign_id.body,
                                        popup.test_campaign_id.attachment_ids
                                    )
                                    if not result.get('success'):
                                        _logger.error(f" [QR Popup] Failed to send test: {result.get('error')}")
                        except Exception as e:
                            _logger.error(f" [QR Popup] Error triggering test resend: {e}")
                            # Fallback: try using stored test data
                            if popup.test_campaign_id and popup.test_phone_to:
                                try:
                                    popup.test_campaign_id._send_to_recipient_via_api(
                                        popup.test_phone_to.strip(),
                                        'Test Recipient',
                                        popup.test_campaign_id.body,
                                        popup.test_campaign_id.attachment_ids
                                    )
                                except Exception as e2:
                                    _logger.error(f" [QR Popup] Fallback test send also failed: {e2}")
                    else:
                        # Only stored test data available
                        _logger.info(f" [QR Popup] Using stored test data (wizard not available)")
                        if popup.test_campaign_id and popup.test_phone_to:
                            try:
                                result = popup.test_campaign_id._send_to_recipient_via_api(
                                    popup.test_phone_to.strip(),
                                    'Test Recipient',
                                    popup.test_campaign_id.body,
                                    popup.test_campaign_id.attachment_ids
                                )
                                if not result.get('success'):
                                    _logger.error(f" [QR Popup] Failed to send test: {result.get('error')}")
                            except Exception as e:
                                _logger.error(f" [QR Popup] Error sending test from stored data: {e}")
                elif popup.original_campaign_id and not popup.original_wizard_id:
                    # Campaign popup - trigger campaign resend
                    _logger.info(f" [QR Popup] Triggering campaign resend for campaign {popup.original_campaign_id.id}")
                    try:
                        popup.original_campaign_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f" [QR Popup] Error triggering campaign resend: {e}")
                elif popup.original_wizard_id and not popup.original_campaign_id:
                    # Wizard popup - trigger wizard resend
                    _logger.info(f" [QR Popup] Triggering wizard resend for wizard {popup.original_wizard_id.id}")
                    try:
                        popup.original_wizard_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f" [QR Popup] Error triggering wizard resend: {e}")
                elif popup.original_campaign_id and popup.original_wizard_id:
                    # Both set (shouldn't happen) - prioritize campaign
                    _logger.warning(f" [QR Popup] Both campaign and wizard set on popup {popup.id}, using campaign")
                    try:
                        popup.original_campaign_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f" [QR Popup] Error triggering campaign resend: {e}")
                else:
                    _logger.warning(f" [QR Popup] No original_wizard_id, original_campaign_id, or original_test_wizard_id found on popup {popup.id}")
                
                # Close the popup after triggering send
                popup.with_context(skip_write=True).unlink()
                return True
            
            elif status_type == 'qr_code_mismatch':
                _logger.warning(f" [QR Popup] Phone mismatch detected")
                popup.write({'message': 'Phone mismatch! Please scan with the correct number.'})
                return self._generate_new_qr_code()
            
            elif status_type == 'auth_failure':
                _logger.error(f" [QR Popup] Authentication failed")
                popup.write({'message': 'Authentication failed. Please try again.'})
                return False
            
            elif status_type == 'disconnected':
                _logger.warning(f" [QR Popup] Disconnected")
                popup.write({'message': 'WhatsApp disconnected. Please reconnect.'})
                return False
            
            return False
            
        except Exception as e:
            _logger.error(f" [QR Popup] Error handling status event: {e}")
            return False

    def do_something(self, data):
        # working
        """Handle socket RPC calls for QR updates and status events"""
        try:
            _logger.info(f" [QR Popup] Socket RPC received: data={data}")
            
            # Extract type and data from the payload
            # Socket sends {type: 'status', data: {...}}
            event_type = None
            event_data = None
            
            if isinstance(data, dict):
                event_type = data.get('type')
                event_data = data.get('data', data)
                _logger.info(f" [QR Popup] Event type: {event_type}, Event data: {event_data}")
            
            # Handle status events (type='status')
            if event_type == 'status':
                _logger.info(f" [QR Popup] Handling status event with data: {event_data}")
                return self._handle_status_event(event_data if event_data else data)
            
            # Handle message events (incoming/outgoing WhatsApp messages)
            # if event_type == 'message':
            #     _logger.info(f" [QR Popup] Message event received")
            #     # Messages are already logged, just acknowledge
            #     return True
            
            # Handle chat events (chat list updates)
            # if event_type == 'chat':
            #     _logger.info(f" [QR Popup] Chat event received")
            #     # Chat events are informational, just acknowledge
            #     return True
            
            # Handle phone mismatch events
            if event_type == 'phone_mismatch':
                _logger.info(f" [QR Popup] Phone mismatch event received")
                return self._handle_phone_mismatch_event(event_data if event_data else data)
            
            # Handle QR code events (existing logic)
            # Extract QR code from data - handle nested structure
            qr_code = None
            if isinstance(data, dict):
                # Try multiple possible locations for the QR code
                if 'qrCode' in data:
                    qr_code = data['qrCode']
                    _logger.info(f" [QR Popup] Found QR code at data['qrCode']")
                elif 'data' in data and isinstance(data['data'], dict) and 'qrCode' in data['data']:
                    # Nested structure: data['data']['qrCode']
                    qr_code = data['data']['qrCode']
                    _logger.info(f" [QR Popup] Found QR code at data['data']['qrCode']")
                else:
                    # _logger.warning(f" [QR Popup] No QR code found in data structure: {data}")
                    return False
            elif hasattr(data, 'qrCode'):
                # Attribute-style access: data.qrCode
                qr_code = data.qrCode
                _logger.info(f" [QR Popup] Found QR code via attribute access")
            else:
                _logger.warning(f" [QR Popup] Unexpected data format: {data}")
                return False
            
            if not qr_code:
                _logger.warning(f" [QR Popup] QR code is empty")
                return False
            
            # Ensure base64 prefix
            if not qr_code.startswith('data:image'):
                qr_code = f"data:image/png;base64,{qr_code}"
            
            # Find the latest popup record
            popup = self.env['whatsapp.qr.popup'].search([], order='create_date desc', limit=1)
            if not popup:
                _logger.warning(f" [QR Popup] No popup found for socket update")
                return False
            
            # Increment counter (always, even for duplicates)
            current_count = popup.qr_update_count or 0
            new_count = current_count + 1
            
            # Update popup with new QR code
            update_vals = {
                'qr_code_image': qr_code,
                'qr_code_filename': 'whatsapp_qr_code.png',
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=popup.countdown_seconds),
                'is_expired': False,
                'qr_update_count': new_count,
                'last_qr_string': qr_code[:100],  # Store first 100 chars for deduplication
                'message': 'Please scan the updated QR code.'
            }
            
            # Write to popup
            popup.write(update_vals)
            
            _logger.info(f" [QR Popup] Updated popup ID {popup.id} with new QR code (update #{new_count})")
            return True
                
        except Exception as e:
            _logger.error(f" [QR Popup] Error in do_something: {e}")
            return False

    @api.depends('qr_code_image')
    def _compute_qr_code_image_bin(self):
        import re
        import base64
        for rec in self:
            data = rec.qr_code_image or ''
            # Strip data URL prefix if present
            if data.startswith('data:image'):
                try:
                    data = data.split(',', 1)[1]
                except Exception:
                    pass
            # Fix padding if required
            if data:
                pad = len(data) % 4
                if pad:
                    data = data + ('=' * (4 - pad))
            # Assign base64 text directly; Odoo Binary expects base64 string
            rec.qr_code_image_bin = data or False
    
    def action_continue(self):
        """Continue after QR scan and proceed with sending messages"""
        self.ensure_one()
        
        _logger.info(f" [QR Popup] Continue button clicked for popup ID: {self.id}")
        
        if not self.original_wizard_id:
            _logger.error(f" [QR Popup] Original wizard data not found for popup ID: {self.id}")
            raise UserError(_("Original wizard data not found."))
        
        _logger.info(f" [QR Popup] Waiting for socket status event")
        
        # Don't check API status - rely on socket events instead
        # After scanning QR, backend emits status events automatically
        # Socket listener will receive 'status' event with type 'ready' when authenticated
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Waiting for Authentication'),
                'message': _('Please scan the QR code with WhatsApp. The system will automatically send messages when connected.'),
                'type': 'info',
                'sticky': False,
            }
        }
    
    def action_refresh_qr(self):
        """Manually refresh QR code"""
        self.ensure_one()
        _logger.info(f" [QR Popup] Refresh QR button clicked for popup ID: {self.id}")
        return self._generate_new_qr_code()
    
    def action_close_popup(self):
        """Close popup without sending messages"""
        self.ensure_one()
        _logger.info(f" [QR Popup] Close popup button clicked for popup ID: {self.id}")
        return {
            'type': 'ir.actions.act_window_close'
        }
    
    def action_refresh_countdown(self):
        """Refresh countdown display"""
        self.ensure_one()
        _logger.info(f" [QR Popup] Refresh countdown button clicked for popup ID: {self.id}")
        # Trigger recomputation of countdown_display
        self._compute_countdown_display()
        _logger.info(f" [QR Popup] Countdown display updated: {self.countdown_display}")
        return {
            'type': 'ir.actions.client',
            'tag': 'reload'
        }
    
    def action_refresh_ui(self):
        """Manually refresh the popup UI"""
        self.ensure_one()
        _logger.info(f" [QR Popup] Refresh UI button clicked for popup ID: {self.id}")
        
        # Force recomputation of computed fields
        self._compute_qr_code_image_bin()
        self._compute_countdown_display()
        
        # Return action to reopen the popup with updated data
        return {
            'type': 'ir.actions.act_window',
            'name': 'WhatsApp Authentication Required',
            'res_model': 'whatsapp.qr.popup',
            'res_id': self.id,
            'view_mode': 'form',
            'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
            'target': 'new',
            'context': {
                'refresh_popup_after_update': False,
            }
        }
                                                                                                                            
    def _generate_new_qr_code(self):
        """Generate new QR code from API"""
        try:
            _logger.info(f" [QR Popup] Generating new QR code for popup ID: {self.id}")
            
            if not self.api_key or not self.phone_number:
                _logger.error(f" [QR Popup] Missing API key or phone number for QR generation")
                raise UserError(_("API key or phone number not found."))
            
            # Call API to get new QR code
            api_url = "http://localhost:3000/api/whatsapp/qr"
            headers = {
                'Content-Type': 'application/json',
                # 'x-api-key': self.api_key,
                # 'x-phone-number': self.phone_number
                'apiKey': self.api_key,
                'phoneNumber': self.phone_number
            }
            data = {
                'apiKey': self.api_key,
                'phoneNumber': self.phone_number
            }
            
            _logger.info(f" [QR Popup] Calling QR generation API: {api_url}")
            _logger.info(f" [QR Popup] Request headers: {headers}")
            _logger.info(f" [QR Popup] Request data: {data}")
            
            response = requests.post(api_url, headers=headers, json=data, timeout=60)
            
            _logger.info(f" [QR Popup] QR generation API response code: {response.status_code}")
            
            if response.status_code == 200:
                result = response.json()
                _logger.info(f" [QR Popup] QR generation API response: {result}")
                
                if result.get('success') and result.get('qrCode'):
                    qr_code_data = result['qrCode']
                    _logger.info(f" [QR Popup] QR code received, length: {len(qr_code_data) if qr_code_data else 0}")
                    
                    # Update current popup with new QR code
                    self.write({
                        'qr_code_image': qr_code_data,
                        'qr_code_filename': 'whatsapp_qr_code_new.png',
                        'qr_expires_at': fields.Datetime.now() + timedelta(seconds=self.countdown_seconds),
                        'is_expired': False,
                        'retry_count': 0,
                        'last_qr_string': qr_code_data[:100] if qr_code_data else '',  # Store first 100 chars for deduplication
                        'message': result.get('message', 'Please scan the new QR code with WhatsApp.')
                    })
                    
                    _logger.info(f" [QR Popup] New QR code generated for {self.from_number}")
                    
                    # Show notification
                    return {
                        'type': 'ir.actions.client',
                        'tag': 'display_notification',
                        'params': {
                            'title': _('New QR Code Generated'),
                            'message': _('Please scan the new QR code with the correct WhatsApp number.'),
                            'type': 'info',
                            'sticky': False,
                        }
                    }
                else:
                    error_msg = result.get('error', 'Unknown error')
                    _logger.error(f" [QR Popup] QR generation failed: {error_msg}")
                    raise UserError(_("Failed to generate QR code: %s") % error_msg)
            else:
                _logger.error(f" [QR Popup] QR generation API returned error code: {response.status_code}")
                raise UserError(_("API returned status %d") % response.status_code)
                
        except requests.exceptions.Timeout:
            self.retry_count += 1
            _logger.warning(f" [QR Popup] QR generation timeout, retry count: {self.retry_count}")
            
            if self.retry_count <= self.max_retries:
                delay = min(2 ** self.retry_count, 30)  # Exponential backoff, max 30s
                _logger.info(f" [QR Popup] Retrying in {delay} seconds... ({self.retry_count}/{self.max_retries})")
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('QR Generation Timeout'),
                        'message': _('Retrying in %d seconds... (%d/%d)') % (delay, self.retry_count, self.max_retries),
                        'type': 'warning',
                        'sticky': True,
                    }
                }
            else:
                _logger.error(f" [QR Popup] Maximum retries reached")
                raise UserError(_("Maximum retries reached. Please refresh the page."))
        except Exception as e:
            _logger.error(f" [QR Popup] Error generating new QR code: {e}")
            raise UserError(_("Failed to generate QR code: %s") % str(e))
    
    def _handle_phone_mismatch(self, expected_phone, actual_phone, new_qr_code=None):
        """Handle phone number mismatch event"""
        self.ensure_one()
        
        _logger.warning(f"Phone mismatch detected: Expected {expected_phone}, Got {actual_phone}")
        
        # Update message to show mismatch
        self.write({
            'message': f"Phone Number Mismatch!\nExpected: {expected_phone}\nScanned: {actual_phone}\nPlease scan with the correct number.",
            'is_expired': True
        })
        
        # Generate new QR code if not provided
        if new_qr_code:
            self.write({
                'qr_code_image': new_qr_code,
                'qr_code_filename': 'whatsapp_qr_code_mismatch.png',
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=self.countdown_seconds),
                'is_expired': False,
                'retry_count': 0,
                'last_qr_string': new_qr_code[:100] if new_qr_code else ''
            })
        else:
            # Generate new QR code
            return self._generate_new_qr_code()
        
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Phone Number Mismatch'),
                'message': _('Please scan with the correct phone number: %s') % expected_phone,
                'type': 'warning',
                'sticky': True,
            }
        }
    
    def _handle_qr_expiration(self):
        """Handle QR code expiration"""
        self.ensure_one()
        
        _logger.info(f"QR code expired for {self.from_number}")
        
        self.write({
            'is_expired': True,
            'message': 'QR code expired! Generating new one...'
        })
        
        # Generate new QR code
        return self._generate_new_qr_code()
    
    def _handle_connection_success(self):
        """Handle successful WhatsApp connection"""
        self.ensure_one()
        
        _logger.info(f"WhatsApp connected successfully for {self.from_number}")
        
        self.write({
            'is_expired': False,
            'message': 'WhatsApp connected successfully! You can now send messages.',
            'retry_count': 0
        })
        
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('WhatsApp Connected'),
                'message': _('WhatsApp connected successfully! You can now send messages.'),
                'type': 'success',
                'sticky': False,
            }
        }
    
   
