# -*- coding: utf-8 -*-

import datetime
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging
import requests
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

    @api.model
    def create_from_socket_event(self, vals):
        """Create QR popup from Socket.IO event"""
        try:
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
            
            # Return the popup ID for opening
            return popup.id
            
        except Exception as e:
            _logger.error(f"Error creating QR popup from socket event: {e}")
            raise UserError(_("Failed to create QR popup: %s") % str(e))

    def write(self, vals):
        """Override write method to handle QR updates"""
        # If updating QR code, reset expiration timer
        if 'qr_code_image' in vals:
            vals.update({
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                'countdown_seconds': 120,
                'is_expired': False,
            })
            
            # Remove qr_code_image_bin from vals to let computed field handle it
            if 'qr_code_image_bin' in vals:
                del vals['qr_code_image_bin']
        
        result = super().write(vals)
        
        # If this is a QR update, trigger UI refresh via notification
        if 'qr_code_image' in vals and self.env.context.get('refresh_popup_after_update'):
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

    def _handle_status_event(self, status_data):
        """Handle status events from socket"""
        try:
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
            
            if not status_type:
                _logger.warning(f"No status type found in status event data")
                return False
            
            time_threshold = datetime.datetime.now() - timedelta(minutes=2)
            time_threshold_str = fields.Datetime.to_string(time_threshold)
            # Find the latest QR popup
            popup = self.env['whatsapp.qr.popup'].search([
                ('create_date', '>=', time_threshold_str)
            ], order='create_date desc', limit=1)
          
            if not popup:
                _logger.warning(f"No QR popup found for status event")
                return False
            
            # Handle different status types
            if status_type == 'ready':
                _logger.info(f"WhatsApp connection ready, closing popup and sending messages")
                
                # Trigger message sending - check which type this popup is
                # Test messages take priority (check first)
                if (popup.original_test_wizard_id or popup.test_phone_to) and not popup.original_campaign_id:
                    # Test wizard popup - trigger test resend
                    if popup.original_test_wizard_id:
                        # Try to use test wizard if it still exists
                        try:
                            test_wizard = popup.original_test_wizard_id
                            if test_wizard.exists():
                                test_wizard.resend_test(popup=popup)
                            else:
                                # Test wizard was closed, use stored data
                                if popup.test_campaign_id and popup.test_phone_to:
                                    result = popup.test_campaign_id._send_to_recipient_via_api(
                                        popup.test_phone_to.strip(),
                                        'Test Recipient',
                                        popup.test_campaign_id.body,
                                        popup.test_campaign_id.attachment_ids
                                    )
                                    if not result.get('success'):
                                        _logger.error(f"Failed to send test message: {result.get('error')}")
                        except Exception as e:
                            _logger.error(f"Error triggering test resend: {e}")
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
                                    _logger.error(f"Fallback test send failed: {e2}")
                    else:
                        # Only stored test data available
                        if popup.test_campaign_id and popup.test_phone_to:
                            try:
                                result = popup.test_campaign_id._send_to_recipient_via_api(
                                    popup.test_phone_to.strip(),
                                    'Test Recipient',
                                    popup.test_campaign_id.body,
                                    popup.test_campaign_id.attachment_ids
                                )
                                if not result.get('success'):
                                    _logger.error(f"Failed to send test message: {result.get('error')}")
                            except Exception as e:
                                _logger.error(f"Error sending test from stored data: {e}")
                elif popup.original_campaign_id and not popup.original_wizard_id:
                    # Campaign popup - trigger campaign resend
                    try:
                        popup.original_campaign_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f"Error triggering campaign resend: {e}")
                elif popup.original_wizard_id and not popup.original_campaign_id:
                    # Wizard popup - trigger wizard resend
                    try:
                        popup.original_wizard_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f"Error triggering wizard resend: {e}")
                elif popup.original_campaign_id and popup.original_wizard_id:
                    # Both set (shouldn't happen) - prioritize campaign
                    _logger.warning(f"Both campaign and wizard set on popup {popup.id}, using campaign")
                    try:
                        popup.original_campaign_id.action_close_qr_popup(popup=popup)
                    except Exception as e:
                        _logger.error(f"Error triggering campaign resend: {e}")
                else:
                    _logger.warning(f"No original_wizard_id, original_campaign_id, or original_test_wizard_id found on popup {popup.id}")
                
                # Close the popup after triggering send
                popup.with_context(skip_write=True).unlink()
                return True
            return False
            
        except Exception as e:
            _logger.error(f"Error handling status event: {e}")
            return False

    def do_something(self, data):
        """Handle socket RPC calls for QR updates and status events"""
        try:
           
            event_type = None
            event_data = None
            
            if isinstance(data, dict):
                event_type = data.get('type')
                event_data = data.get('data', data)
            
            # Handle status events (type='status')
            if event_type == 'status':
                return self._handle_status_event(event_data if event_data else data)
            
            # Handle QR code events
            # Extract QR code from data - handle nested structure
            qr_code = None
            if isinstance(data, dict):
                # Try multiple possible locations for the QR code
                if 'qrCode' in data:
                    qr_code = data['qrCode']
                elif 'data' in data and isinstance(data['data'], dict) and 'qrCode' in data['data']:
                    # Nested structure: data['data']['qrCode']
                    qr_code = data['data']['qrCode']
                else:
                    return False
            elif hasattr(data, 'qrCode'):
                # Attribute-style access: data.qrCode
                qr_code = data.qrCode
            else:
                _logger.warning(f"Unexpected data format in socket RPC")
                return False
            
            if not qr_code:
                _logger.warning(f"QR code is empty in socket event")
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
            
            # Write to popup - UNUSED (commented out)
            # popup.write(update_vals)
            return True
                
        except Exception as e:
            _logger.error(f"Error in do_something: {e}")
            return False

    @api.depends('qr_code_image')
    def _compute_qr_code_image_bin(self):
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
    
   