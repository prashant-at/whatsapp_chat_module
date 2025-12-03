# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging
from datetime import timedelta

_logger = logging.getLogger(__name__)


class WhatsAppQRPopup(models.TransientModel):
    _name = 'whatsapp.qr.popup'
    _description = 'WhatsApp QR Code Popup'

    # Minimal fields: just enough to display a one-off QR image and message
    qr_code_image = fields.Text('QR Code Data', readonly=True)
    # Binary used by the image widget (kept in sync with qr_code_image)
    qr_code_image_bin = fields.Binary('QR Code', compute='_compute_qr_code_image_bin', store=False, readonly=True)
    qr_code_filename = fields.Char('QR Code Filename', readonly=True)
    from_number = fields.Char('From Number', readonly=True)
    message = fields.Text('Message', readonly=True)

    # No extra state management (expiry / retries / campaigns); QR is purely temporary

    def do_something(self, data, payload=None):
        """Handle socket RPC calls for QR updates and status events.
        
        Supports both calling conventions:
          1) args: [{ type, data }]                → old style
          2) args: ['rpc', { type, data }]        → new style
        
        Args:
            data: dict payload *or* a source flag like 'rpc'
            payload: optional dict payload when a source flag is used
        """
        try:
            # Normalize to a single dict called event_wrapper
            if payload is None:
                # Old style: data is the actual payload dict
                if not isinstance(data, dict):
                    _logger.warning(f"[QR Popup] Unexpected data format: {type(data)} (no payload arg)")
                    return False
                event_wrapper = data
            else:
                # New style: first arg is a source flag, second is the payload dict
                if not isinstance(payload, dict):
                    _logger.warning(f"[QR Popup] Unexpected payload format: {type(payload)}")
                    return False
                event_wrapper = payload
            
            data = event_wrapper  # keep variable name for existing logic
            
            event_type = data.get('type')
            event_data = data.get('data', data)
            
            # Handle status events
            if event_type == 'status':
                status_type = event_data.get('type') if isinstance(event_data, dict) else None
                
                # Handle QR code status events: ALWAYS create a simple, one-off popup
                if status_type in ['qr_code', 'qr_code_mismatch']:
                    # Extract QR code from event_data
                    qr_code = None
                    data_section = event_data.get('data', {}) if isinstance(event_data, dict) else {}
                    if isinstance(data_section, dict):
                        qr_code = data_section.get('qrCode') or data_section.get('qr_code')
                    if not qr_code:
                        # Fallbacks
                        qr_code = event_data.get('qrCode') if isinstance(event_data, dict) else None
                        if not qr_code and isinstance(data, dict):
                            inner = data.get('data', {})
                            if isinstance(inner, dict):
                                qr_code = inner.get('qrCode') or inner.get('qr_code')
                    
                    if not qr_code:
                        _logger.warning(f"[QR Popup] QR status event received but no qrCode found in payload: event_data={event_data}, data={data}")
                        return False
                    
                    # Ensure base64 prefix
                    if not qr_code.startswith('data:image'):
                        qr_code = f"data:image/png;base64,{qr_code}"
                    
                    # Simple popup: just show QR and message, no campaign/wizard linking or expiry tracking
                    message = event_data.get('message') if isinstance(event_data, dict) else None
                    if not message and isinstance(data, dict):
                        message = data.get('message')
                    if not message:
                        message = 'Please scan the QR code to connect WhatsApp.'
                    
                    # Extract phone number from event data
                    phone_number = event_data.get('phoneNumber')
                    
                    qr_popup_vals = {
                        'qr_code_image': qr_code,
                        'qr_code_filename': 'whatsapp_qr_code.png',
                        'message': message,
                        'from_number': phone_number,  # Show which number to scan with
                    }
                    
                    qr_popup = self.env['whatsapp.qr.popup'].create(qr_popup_vals)
                    _logger.info(f"[QR Popup] Simple QR popup created from status event: {qr_popup.id}")
                    
                    view_id = self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id
                    return {
                        'type': 'ir.actions.act_window',
                        'name': 'WhatsApp Authentication Required',
                        'res_model': 'whatsapp.qr.popup',
                        'res_id': qr_popup.id,
                        'view_mode': 'form',
                        'views': [(view_id, 'form')],
                        'view_id': view_id,
                        'target': 'new',
                        'context': {},
                    }
                
                # Handle ready status event - retry pending requests
                elif status_type == 'ready':
                    # Extract credentials from event data to identify which connection is ready
                    api_key = None
                    phone_number = None
                    
                    if isinstance(event_data, dict):
                        api_key = event_data.get('apiKey') or event_data.get('api_key')
                        phone_number = event_data.get('phoneNumber') or event_data.get('phone_number')


                    # Fallback: check in data dict
                    if not api_key or not phone_number:
                        if isinstance(data, dict):
                            inner_data = data.get('data', {})
                            if isinstance(inner_data, dict):
                                api_key = api_key or inner_data.get('apiKey') or inner_data.get('api_key')
                                phone_number = phone_number or inner_data.get('phoneNumber') or inner_data.get('phone_number')
                    
                    # Find the connection matching these credentials
                    connection = None
                    if api_key and phone_number:
                        connection = self.env['whatsapp.connection'].search([
                            ('api_key', '=', api_key),
                            ('from_field', '=', phone_number)
                        ], limit=1)
                        
                        if connection:
                            # Mark this specific connection as ready
                            connection.sudo().write({'socket_connection_ready': True})
                            self.env.cr.commit()
                            # Security: Don't log API key, even partially
                            _logger.info(f"[Ready Event] Connection {connection.id} ({connection.name}) is ready")
                        else:
                            _logger.warning(f"[Ready Event] No connection found matching api_key and phone_number")
                    else:
                        _logger.warning(f"[Ready Event] Missing credentials in ready event: api_key={bool(api_key)}, phone_number={bool(phone_number)}")
                    
                    # Retry pending requests for this specific connection
                    connection_id = connection.id if connection else None
                    campaigns = self.env['whatsapp.marketing.campaign']
                    campaigns._handle_ready_status_event(connection_id=connection_id)
                    self._handle_ready_for_compose(connection_id=connection_id)
                    return True
                
                # Other status types are not handled here
                return False
            
            # Handle direct QR code events (legacy format)
            qr_code = None
            if 'qrCode' in data:
                qr_code = data['qrCode']
            elif 'data' in data and isinstance(data['data'], dict) and 'qrCode' in data['data']:
                qr_code = data['data']['qrCode']
            elif hasattr(data, 'qrCode'):
                qr_code = data.qrCode
            
            if qr_code:
                if not qr_code.startswith('data:image'):
                    qr_code = f"data:image/png;base64,{qr_code}"
                
                # Legacy path: previously updated the latest popup in place.
                # With the simplified flow we rely on the status event path above
                # to open a fresh popup when needed, so we do nothing here.
                return False
            
            return False
                
        except Exception as e:
            _logger.exception(f"Error in do_something: {e}")
            return False

    @api.model
    def _handle_ready_for_compose(self, connection_id=None):
        """Handle ready status event for compose wizard pending requests.
        
        Only retries wizards whose connection matches the ready connection.
        Uses database locking (FOR UPDATE SKIP LOCKED) to prevent SerializationFailure
        when multiple ready events are processed concurrently.
        
        Args:
            connection_id: ID of the connection that is ready (optional filter)
        
        Returns:
            int: Number of wizards successfully processed
        """
        try:
            # Step 1: Find the ready connection(s)
            if connection_id:
                ready_connection_ids = [connection_id]
                _logger.info(f"[Ready Event] Using provided connection_id: {connection_id}")
            else:
                ready_connections = self.env['whatsapp.connection'].search([
                    ('socket_connection_ready', '=', True)
                ])
                
                if not ready_connections:
                    _logger.info("[Ready Event] No ready connections found, skipping compose wizard retry")
                    return 0
                
                ready_connection_ids = ready_connections.ids
                _logger.info(f"[Ready Event] Found {len(ready_connection_ids)} ready connection(s): {ready_connection_ids}")
            
            # Step 2: Find wizards with pending requests for ready connections
            # Use raw SQL with FOR UPDATE SKIP LOCKED to prevent concurrent updates
            self.env.cr.execute("""
                SELECT id, from_number
                FROM whatsapp_chat_simple_wizard
                WHERE pending_requests IS NOT NULL
                  AND pending_requests != '[]'
                  AND pending_requests != ''
                  AND from_number IN %s
                FOR UPDATE SKIP LOCKED
            """, (tuple(ready_connection_ids),))
            
            locked_rows = self.env.cr.fetchall()
            locked_wizard_ids = [row[0] for row in locked_rows]
            
            if not locked_wizard_ids:
                _logger.info("[Ready Event] No compose wizards with pending requests found for ready connections")
                return 0
            
            _logger.info(f"[Ready Event] Locked {len(locked_wizard_ids)} compose wizard(s) for retry: {locked_wizard_ids}")
            
            # Step 3: Process only the locked wizards
            compose_wizards = self.env['whatsapp.chat.simple.wizard'].browse(locked_wizard_ids)
            processed_count = 0
            
            for wizard in compose_wizards:
                try:
                    _logger.info(f"[Ready Event] Retrying pending requests for compose wizard {wizard.id} (connection: {wizard.from_number.id if wizard.from_number else 'None'})")
                    wizard.action_retry_pending_requests()
                    processed_count += 1
                except Exception as e:
                    _logger.exception(f"[Ready Event] Error retrying pending requests for compose wizard {wizard.id}: {e}")
            
            _logger.info(f"[Ready Event] Successfully processed {processed_count}/{len(locked_wizard_ids)} compose wizard(s)")
            return processed_count
            
        except Exception as e:
            _logger.exception(f"[Ready Event] Error handling ready event for compose wizards: {e}")
            return 0

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
    
   