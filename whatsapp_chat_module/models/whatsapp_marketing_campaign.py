# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging
import requests
import re
import json
import base64
import io
from bs4 import BeautifulSoup
from datetime import timedelta
import time
import random

_logger = logging.getLogger(__name__)


class WhatsAppMarketingCampaign(models.Model):
    _name = 'whatsapp.marketing.campaign'
    _description = 'WhatsApp Marketing Campaign'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'create_date DESC'
    _rec_name = 'name'

    name = fields.Char('Campaign Name', tracking=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('sending', 'Sending'),
        ('sent', 'Sent')
    ], string='Status', default='draft', tracking=True)
    
    mailing_model_id = fields.Many2one(
        'ir.model',
        string='Recipients Model',
        ondelete='cascade',
        domain=[
            ('is_mailing_enabled', '=', True),
            ('model', 'not in', ['mailing.list', 'mailing.contact'])
        ],
        default=lambda self: self.env['ir.model']._get_id('whatsapp.mailing.list'),
        help="Model of the recipients"
    )
    
    mailing_model_name = fields.Char(
        string='Recipients Model Name',
        related='mailing_model_id.model',
        readonly=True,
        store=True
    )
    
    mailing_model_real = fields.Char(
        string='Recipients Real Model',
        compute='_compute_mailing_model_real',
        store=False,
        help="Real model to use for recipients (mailing.contact if mailing.list, else the model itself)"
    )
    
    mailing_on_mailing_list = fields.Boolean(
        string='Based on Mailing Lists',
        compute='_compute_mailing_on_mailing_list',
        store=False
    )
    
    mailing_domain = fields.Char(
        string='Domain',
        help="Domain to filter recipients when not using mailing lists"
    )
    
    
    whatsapp_list_ids = fields.Many2many(
        'whatsapp.mailing.list',
        'whatsapp_campaign_whatsapp_list_rel',
        'campaign_id',
        'list_id',
        string='WhatsApp Mailing Lists',
        help="WhatsApp mailing lists to send the campaign to (only when Recipients Model is WhatsApp Mailing List)"
    )
    
    from_connection_id = fields.Many2one(
        'whatsapp.connection',
        string='From Connection',
        domain=lambda self: self._get_authorized_connection_domain(),
        help="WhatsApp connection to send messages from"
    )
    
    template_id = fields.Many2one(
        'whatsapp.template',
        string='Load Template',
        help="Select a template to load the campaign body"
    )
    
    body = fields.Html(
        'Campaign Body',
        help="Message content to send (plain text)"
    )
    
    attachment_ids = fields.Many2many(
        'ir.attachment',
        'whatsapp_campaign_attachment_rel',
        'campaign_id',
        'attachment_id',
        string='Attachments',
        help="Attachments to include in the WhatsApp message"
    )
    
    total_recipients = fields.Integer(
        'Total Recipients',
        compute='_compute_total_recipients',
        store=False,
        help="Total number of contacts with phone numbers in selected mailing lists"
    )
    
    sent_count = fields.Integer(
        'Sent',
        default=0,
        help="Number of messages sent successfully"
    )
    
    failed_count = fields.Integer(
        'Failed',
        default=0,
        help="Number of messages that failed to send"
    )
    
    pending_recipients = fields.Text(
        'Pending Recipients',
        help="JSON array of recipients waiting to be sent (stored as JSON string)"
    )
    
    current_recipient_index = fields.Integer(
        'Current Recipient Index',
        default=0,
        help="Index of the next recipient to send"
    )
    
    last_send_time = fields.Datetime(
        'Last Send Time',
        help="Time when last message was sent (for rate limiting)"
    )
    
    next_send_delay = fields.Float(
        'Next Send Delay (seconds)',
        help="Random delay in seconds before next message (60-120)"
    )
    
    waiting_for_qr = fields.Boolean(
        'Waiting for QR Scan',
        default=False,
        help="Campaign is paused waiting for user to scan QR code"
    )

    @api.model
    def _get_authorized_connection_domain(self):
        """Get domain for connections user is authorized to access"""
        user = self.env.user
        if user.has_group('whatsapp_chat_module.group_whatsapp_admin'):
            return []
        return [('authorized_person_ids', 'in', [user.id])]

    @api.model
    def default_get(self, fields_list):
        """Set default from_connection_id from user's default connection"""
        result = super().default_get(fields_list)
        
        if 'from_connection_id' in fields_list and not result.get('from_connection_id'):
            default_connection = self.env['whatsapp.connection'].get_default_connection()
            if default_connection:
                result['from_connection_id'] = default_connection.id
        
        return result

    @api.depends('mailing_model_id')
    def _compute_mailing_model_real(self):
        """Compute the real model to use for recipients"""
        for campaign in self:
            if campaign.mailing_model_id:
                if campaign.mailing_model_id.model == 'whatsapp.mailing.list':
                    campaign.mailing_model_real = 'whatsapp.mailing.contact'
                else:
                    campaign.mailing_model_real = campaign.mailing_model_id.model
            else:
                campaign.mailing_model_real = False

    @api.depends('mailing_model_id')
    def _compute_mailing_on_mailing_list(self):
        """Compute if campaign is based on mailing lists"""
        whatsapp_list_model_id = self.env['ir.model']._get('whatsapp.mailing.list')
        for campaign in self:
            campaign.mailing_on_mailing_list = (campaign.mailing_model_id == whatsapp_list_model_id) if whatsapp_list_model_id else False
    
    @api.depends('mailing_model_id')
    def _compute_use_whatsapp_lists(self):
        """Compute if campaign uses WhatsApp mailing lists"""
        whatsapp_list_model_id = self.env['ir.model']._get('whatsapp.mailing.list')
        for campaign in self:
            campaign.use_whatsapp_lists = (campaign.mailing_model_id == whatsapp_list_model_id) if whatsapp_list_model_id else False

    @api.depends('whatsapp_list_ids', 'mailing_model_id', 'mailing_domain', 'mailing_on_mailing_list')
    def _compute_total_recipients(self):
        """Count unique contacts with phone numbers"""
        for campaign in self:
            if not campaign.mailing_model_real:
                campaign.total_recipients = 0
                continue
            
            # Get records based on mailing lists or domain
            if campaign.mailing_on_mailing_list:
                if not campaign.whatsapp_list_ids:
                    campaign.total_recipients = 0
                    continue
                # Get all contacts from selected WhatsApp mailing lists
                records = self.env['whatsapp.mailing.contact'].search([
                    ('list_ids', 'in', campaign.whatsapp_list_ids.ids)
                ])
            else:
                # Use domain to get records
                if not campaign.mailing_domain:
                    campaign.total_recipients = 0
                    continue
                try:
                    from ast import literal_eval
                    domain = literal_eval(campaign.mailing_domain) if campaign.mailing_domain else []
                except:
                    domain = []
                records = self.env[campaign.mailing_model_real].search(domain)
            
            # Count records with phone numbers
            count = 0
            for record in records:
                phone = self._get_phone_from_record(record)
                if phone:
                    count += 1
            
            campaign.total_recipients = count

    def _get_phone_from_record(self, record):
        """Extract phone number from a record (contact, partner, etc.)"""
        # Try whatsapp.mailing.contact first
        if record._name == 'whatsapp.mailing.contact':
            if hasattr(record, 'mobile') and record.mobile:
                return record.mobile
    
        elif record._name == 'res.partner':
            return record.mobile or record.phone
        # Try other models with mobile/phone fields
        else:
            if hasattr(record, 'mobile') and record.mobile:
                return record.mobile
            elif hasattr(record, 'phone') and record.phone:
                return record.phone
            
        return None

    def _get_recipients(self):
        """Get all phone numbers from mailing lists or domain"""
        self.ensure_one()
        recipients = []
        
        if not self.mailing_model_real:
            return recipients
        
        # Get records based on mailing lists or domain
        if self.mailing_on_mailing_list:
            if not self.whatsapp_list_ids:
                return recipients
            # Get all contacts from selected WhatsApp mailing lists
            records = self.env['whatsapp.mailing.contact'].search([
                ('list_ids', 'in', self.whatsapp_list_ids.ids)
            ])
        else:
            # Use domain to get records
            if not self.mailing_domain:
                return recipients
            try:
                from ast import literal_eval
                domain = literal_eval(self.mailing_domain) if self.mailing_domain else []
            except:
                domain = []
            records = self.env[self.mailing_model_real].search(domain)
        
        for record in records:
            phone = self._get_phone_from_record(record)
            if phone:
                # Get name
                contact_name = 'Unknown'
                if hasattr(record, 'name') and record.name:
                    contact_name = record.name
                elif hasattr(record, 'partner_id') and record.partner_id and record.partner_id.name:
                    contact_name = record.partner_id.name
                
                recipients.append({
                    'phone': phone.strip(),
                    'name': contact_name
                })
        
        return recipients

    @api.onchange('mailing_model_id')
    def _onchange_mailing_model_id(self):
        """Clear mailing lists and domain when model changes"""
        if self.mailing_model_id:
            whatsapp_list_model_id = self.env['ir.model']._get('whatsapp.mailing.list')
            
            # Clear WhatsApp lists if switching away from whatsapp.mailing.list
            if whatsapp_list_model_id and self.mailing_model_id != whatsapp_list_model_id:
                self.whatsapp_list_ids = False
            # Clear domain if switching to any mailing list model
            if self.mailing_on_mailing_list:
                self.mailing_domain = False

    @api.onchange('template_id')
    def _onchange_template_id(self):
        """Auto-load body from selected template"""
        if self.template_id:
            # Load template body (plain text from HTML)
            if self.template_id.body_html:
                
                self.body = self.template_id.body_html
            else:
                self.body = ''
        else:
            # Clear body if template is deselected
            self.body = ''

    def action_test(self):
        """Open test wizard popup"""
        self.ensure_one()
        ctx = dict(self.env.context, default_campaign_id=self.id, dialog_size='medium')
        return {
            'name': _('Test Campaign'),
            'type': 'ir.actions.act_window',
            'view_mode': 'form',
            'res_model': 'whatsapp.marketing.campaign.test',
            'target': 'new',
            'context': ctx,
        }

    def action_send(self):
        """Send first message to check authentication, then queue rest for cron"""
        self.ensure_one()
        
        # Prevent duplicate sends
        if self.state == 'sending':
            raise UserError(_("Campaign is already being sent. Please wait for it to complete."))
        
        # Validate
        if not self.body:
            raise UserError(_("Please enter campaign body"))
        if not self.mailing_model_id:
            raise UserError(_("Please select a recipients model"))
        
        if self.mailing_on_mailing_list:
            if not self.whatsapp_list_ids:
                raise UserError(_("Please select WhatsApp mailing lists"))
        if not self.mailing_on_mailing_list and not self.mailing_domain:
            raise UserError(_("Please set a domain to filter recipients"))
        if not self.from_connection_id:
            raise UserError(_("Please select a connection"))
        
        # Check authorization
        if not self.from_connection_id._check_authorization():
            raise UserError(_("You are not authorized to use this connection."))
        
        # Ensure socket is connected (for QR handling if needed)
        self._ensure_socket_connected(context_name="Campaign")
        
        # Get all recipients
        recipients = self._get_recipients()
        if not recipients:
            raise UserError(_("No valid phone numbers found in selected mailing lists"))
        
        # STEP 1: Send first message synchronously to check if QR is needed
        first_recipient = recipients[0]
        first_result = self._send_to_recipient_via_api(
            first_recipient['phone'],
            first_recipient['name'],
            self.body,
            self.attachment_ids
        )
        
        # If QR popup needed, return it
        if first_result.get('qr_popup_needed'):
            # Store ALL recipients (including first one) - it wasn't sent yet!
            first_delay = random.uniform(60.0, 120.0)
            
            self.write({
                'state': 'sending',  # Mark as sending so it can't be sent again
                'pending_recipients': json.dumps(recipients),  # Store ALL recipients including first
                'current_recipient_index': 0,
                'sent_count': 0,  # No messages sent yet (QR needed)
                'failed_count': 0,
                'last_send_time': False,
                'next_send_delay': first_delay,
                'waiting_for_qr': True,  # Prevent cron from processing until QR is scanned
            })
            
            return {
                'type': 'ir.actions.act_window',
                'name': 'WhatsApp Authentication Required',
                'res_model': 'whatsapp.qr.popup',
                'res_id': first_result.get('qr_popup_id'),
                'view_mode': 'form',
                'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                'target': 'new',
            }
        
        # STEP 2: If first message sent successfully, queue remaining recipients for cron
        if first_result.get('success'):
            self.sent_count = 1
            remaining_recipients = recipients[1:] if len(recipients) > 1 else []
            first_delay = random.uniform(60.0, 120.0)
            
            if remaining_recipients:
                # Queue remaining recipients for cron processing
                self.write({
                    'state': 'sending',
                    'pending_recipients': json.dumps(remaining_recipients),
                    'current_recipient_index': 0,
                    'sent_count': 1,
                    'failed_count': 0,
                    'last_send_time': fields.Datetime.now(),  # Set time so cron waits for delay
                    'next_send_delay': first_delay,
                })
                
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('Campaign Started'),
                        'message': _('First message sent successfully. Remaining %d messages will be sent in the background with random delays (60-120 seconds).') % len(remaining_recipients),
                        'type': 'info',
                        'sticky': False,
                    }
                }
            else:
                # Only one recipient, already sent
                self.write({'state': 'sent'})
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('Campaign Sent'),
                        'message': _('Campaign sent successfully.'),
                        'type': 'success',
                    }
                }
        else:
            # First message failed
            self.failed_count = 1
            self.write({'state': 'draft'})
            raise UserError(_("Failed to send first message: %s") % first_result.get('error', 'Unknown error'))

    def _send_to_recipient_via_api(self, phone, contact_name, body, attachments, test_wizard_id=None, test_phone_to=None):
        """Send WhatsApp message via REST API - returns dict with success/qr_popup_needed
        
        Args:
            phone: Phone number to send to
            contact_name: Name of the contact
            body: Message body
            attachments: Attachments to send
            test_wizard_id: Optional ID of test wizard if this is a test send
            test_phone_to: Optional test phone number to store in QR popup (for resend if wizard is closed)
        """
        self.ensure_one()
        
        raw_phone = phone or ''
        compact = re.sub(r'\s+', ' ', raw_phone).strip()
        m = re.match(r'^(\+\d{1,3})\s*(.*)$', compact)
        if m:
            cc = m.group(1)
            rest = re.sub(r'\s+', '', m.group(2))
            phone = f"{cc} {rest}" if rest else cc
        else:
            phone = re.sub(r'\s+', '', raw_phone)
    
        _logger.info(f"Sending to {phone}")
        try:
            # Convert HTML body to plain text
            if body:
                soup = BeautifulSoup(body, 'html.parser')
                plain_text = soup.get_text(separator=' ')
                plain_text = re.sub(r' {3,}', ' ', plain_text)
                plain_text = plain_text.replace('&nbsp;', ' ')
                plain_text = plain_text.replace('&amp;', '&')
                plain_text = plain_text.replace('&lt;', '<')
                plain_text = plain_text.replace('&gt;', '>')
                plain_text = plain_text.replace('&quot;', '"')
            else:
                plain_text = ""
            
            # Prepare headers
            headers = {
                'x-api-key': self.from_connection_id.api_key,
                'x-phone-number': self.from_connection_id.from_field,
                'origin': self._get_origin(),
            }
            api_url = "http://localhost:4000"
            # backend_url = self.env['whatsapp.connection'].get_backend_api_url()
            api_url = api_url + "/api/message"
            print(f"API URL: {api_url}")
            has_attachments = bool(attachments)
            
            # Determine message type and file type handling based on backend requirements
            # Backend accepts: chat, image, video, document, audio, vcard, multi_vcard, location
            image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.webp', '.ico', '.heic'}
            video_extensions = {'.mp4', '.webm', '.ogv', '.avi', '.mov', '.wmv', '.mkv', '.flv', '.3gp'}
            audio_extensions = {'.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mid', '.midi'}
            document_extensions = {
                '.txt', '.csv', '.html', '.css', '.js', '.json', '.xml', '.md', '.yml', '.yaml', '.pdf', 
                '.zip', '.rar', '.7z', '.tar', '.gz', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', 
                '.odt', '.ods', '.odp', '.odg', '.py', '.java', '.c', '.cpp', '.sh', '.php', '.rb', '.sql', 
                '.ics', '.vcard', '.vcf', '.ttf', '.otf', '.woff', '.woff2', '.deb', '.rpm', '.apk', '.dmg', 
                '.pkg', '.bin', '.wasm'
            }
            
            message_type = 'chat'
            file_type = None
            
            if has_attachments:
                # Check first attachment to determine type
                attachment = attachments[0]
                filename = (attachment.name or 'attachment').lower()
                
                # Extract file extension
                if '.' in filename:
                    file_ext = '.' + filename.rsplit('.', 1)[1]
                else:
                    file_ext = None
                
                # Determine message type based on file extension
                if file_ext in image_extensions:
                    message_type = 'image'
                elif file_ext in video_extensions:
                    message_type = 'video'
                elif file_ext in audio_extensions:
                    message_type = 'audio'
                elif file_ext in document_extensions:
                    message_type = 'document'
                    # Extract fileType for documents (without the dot)
                    file_type = file_ext[1:].lower()  # Remove dot and lowercase
                else:
                    # Try to infer from mimetype
                    mimetype = (getattr(attachment, 'mimetype', '') or '').lower()
                    if any(img in mimetype for img in ['image', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']):
                        message_type = 'image'
                    elif any(vid in mimetype for vid in ['video', 'mp4', 'webm', 'avi', 'mov']):
                        message_type = 'video'
                    elif any(aud in mimetype for aud in ['audio', 'mp3', 'wav', 'ogg', 'm4a']):
                        message_type = 'audio'
                    else:
                        # Default to document with bin fileType
                        message_type = 'document'
                        file_type = 'bin'
            
            print("messageType",message_type)
            # Always use FormData for all message types
            form_data = {
                'byChatId': 'false',
                'to': phone,
                'messageType': message_type,
                'body': plain_text,
            }
            
            # Add fileType parameter only for documents
            if message_type == 'document' and file_type:
                form_data['fileType'] = file_type
            
            # Prepare files list - always include, even if empty
            files = []
            if has_attachments:
                for attachment in attachments:
                    file_data = b''
                    
                    try:
                        b64_value = attachment.sudo().datas or ''
                        if isinstance(b64_value, bytes):
                            b64_value = b64_value.decode('utf-8', errors='ignore')
                        if isinstance(b64_value, str) and b64_value.startswith('data:'):
                            b64_value = b64_value.split(',', 1)[1] if ',' in b64_value else b64_value
                        if isinstance(b64_value, str):
                            pad = len(b64_value) % 4
                            if pad:
                                b64_value = b64_value + ('=' * (4 - pad))
                            file_data = base64.b64decode(b64_value)
                    except Exception as e:
                        _logger.error(f"Error decoding attachment: {e}")
                        continue
                    
                    filename = (attachment.name or 'attachment').replace('/', '_').replace('\\', '_')
                    mimetype = getattr(attachment, 'mimetype', None) or 'application/octet-stream'
                    if filename.lower().endswith('.pdf'):
                        mimetype = 'application/pdf'
                    
                    if file_data and len(file_data) > 0:
                        files.append((f'files[{len(files)}]', (filename, io.BytesIO(file_data), mimetype)))
            
            # Always send with FormData - files will be empty list [] if no attachments
            response = requests.post(
                api_url,
                data=form_data,
                files=files if files else [],  # Empty list [] if no attachments
                headers=headers,
                timeout=120
            )
            
            # Handle response - 201 indicates QR code scanning is needed
            if response.status_code == 201:
                # 201 status means QR code scanning is required
                # QR code will be received via socket event with type 'qr_code' or 'status' with type 'qr_code'
                try:
                    response_data = response.json()
                    message = response_data.get('message', 'Please scan QR code to connect WhatsApp')
                except Exception as json_error:
                    message = 'Please scan QR code to connect WhatsApp'
                    _logger.warning(f"Could not parse response JSON for QR popup: {json_error}")
                
                # QR code will be updated via socket events - create popup with empty QR code initially
                qr_popup_vals = {
                    'qr_code_image': '',  # Will be updated via socket event
                    'qr_code_filename': 'whatsapp_qr_code.png',
                    'from_number': self.from_connection_id.from_field,
                    'from_name': self.from_connection_id.name,
                    'message': message,
                    'api_key': self.from_connection_id.api_key,
                    'phone_number': self.from_connection_id.from_field,
                    'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                    'countdown_seconds': 120,
                    'is_expired': False,
                }
                # Set appropriate original ID based on context
                if test_wizard_id:
                    qr_popup_vals['original_test_wizard_id'] = test_wizard_id
                    qr_popup_vals['test_phone_to'] = test_phone_to or phone
                    qr_popup_vals['test_campaign_id'] = self.id
                else:
                    qr_popup_vals['original_campaign_id'] = self.id
                
                qr_popup = self.env['whatsapp.qr.popup'].create(qr_popup_vals)
                
                return {
                    'qr_popup_needed': True,
                    'qr_popup_id': qr_popup.id,
                }
            
            # Handle 200 status (success)
            elif response.status_code == 200:
                try:
                    response_data = response.json()
                except Exception as json_error:
                    return {'success': False, 'error': f'Invalid JSON: {json_error}'}
                
                # Check success flag
                if response_data.get('success', False):
                    return {'success': True}
                else:
                    error_detail = response_data.get('error', response_data.get('message', 'Unknown error'))
                    if isinstance(error_detail, dict):
                        error_detail = error_detail.get('message', str(error_detail))
                    return {'success': False, 'error': error_detail}
            else:
                # Error response
                try:
                    error_response = response.json()
                    error_detail = error_response.get('error', error_response.get('message', 'Unknown error'))
                    if isinstance(error_detail, dict):
                        error_detail = error_detail.get('message', str(error_detail))
                except:
                    error_detail = response.text[:200] if response.text else "Unknown error"
                
                return {'success': False, 'error': error_detail}

        except Exception as e:
            _logger.exception(f"Error sending to {contact_name}: {e}")
            return {'success': False, 'error': str(e)}

    def action_close_qr_popup(self, popup=False):
        """Resume campaign after QR authentication - send first message, then queue rest for cron"""
        self.ensure_one()
        
        # After QR scan, we need to send the first message again (it wasn't sent before)
        recipients = json.loads(self.pending_recipients or '[]')
        
        if not recipients:
            # No recipients to send
            self.write({'state': 'sent'})
            return {}
        
        # Send first message now that WhatsApp is authenticated
        first_recipient = recipients[0]
        _logger.info(f"[Campaign {self.name}] Sending first message after QR scan to {first_recipient['phone']}")
        
        first_result = self._send_to_recipient_via_api(
            first_recipient['phone'],
            first_recipient['name'],
            self.body,
            self.attachment_ids
        )
        
        if first_result.get('qr_popup_needed'):
            # QR needed again (shouldn't happen, but handle it)
            _logger.warning(f"[Campaign {self.name}] QR needed again after scan")
            self.write({'waiting_for_qr': True})  # Set flag to prevent cron processing
            return {
                'type': 'ir.actions.act_window',
                'name': 'WhatsApp Authentication Required',
                'res_model': 'whatsapp.qr.popup',
                'res_id': first_result.get('qr_popup_id'),
                'view_mode': 'form',
                'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                'target': 'new',
            }
        
        if first_result.get('success'):
            # First message sent successfully, queue remaining for cron
            remaining_recipients = recipients[1:] if len(recipients) > 1 else []
            first_delay = random.uniform(60.0, 120.0)
            
            if remaining_recipients:
                self.write({
                    'state': 'sending',
                    'pending_recipients': json.dumps(remaining_recipients),
                    'sent_count': 1,  # First message now sent
                    'last_send_time': fields.Datetime.now(),
                    'next_send_delay': first_delay,
                    'waiting_for_qr': False,  # Clear flag - ready for cron
                })
                message = _('First message sent successfully. Remaining %d messages will be sent in the background.') % len(remaining_recipients)
                notif_type = 'info'
            else:
                # Only one recipient, already sent
                self.write({
                    'state': 'sent',
                    'sent_count': 1,
                    'pending_recipients': False,
                    'waiting_for_qr': False,  # Clear flag
                })
                message = _('Campaign sent successfully.')
                notif_type = 'success'
        else:
            # First message failed after QR scan
            self.failed_count = 1
            self.write({
                'state': 'draft',
                'pending_recipients': False,
                'waiting_for_qr': False,  # Clear flag
            })
            error_msg = first_result.get('error', 'Unknown error')
            _logger.error(f"[Campaign {self.name}] Failed to send first message after QR scan: {error_msg}")
            message = _('Failed to send first message after QR scan: %s') % error_msg
            notif_type = 'danger'
        
        popup_id = popup.id if popup else (
            self.env['whatsapp.qr.popup'].search([
                ('original_campaign_id', '=', self.id)
            ], limit=1).id or 0
        )
        
        # Send bus message
        payload = {
            'action': 'close',
            'popup_id': popup_id,
            'title': _('WhatsApp Campaign'),
            'message': message,
            'type': notif_type,
            'sticky': False,
            'success': self.sent_count > 0
        }
        
        dbname = self._cr.dbname
        popup_channel = f"{dbname}_qr_popup_{popup_id}"
        self.env['bus.bus']._sendone(
            popup_channel,
            'qr_popup_close',
            payload
        )
        
        current_user = self.env.user
        if current_user and current_user.partner_id:
            self.env['bus.bus']._sendone(
                current_user.partner_id,
                'qr_popup_close',
                payload
            )
        
        return {}

    def _get_origin(self):
        """Get origin from request headers"""
        origin = '127.0.0.1'
        try:
            from odoo import http
            request = http.request
            if request and hasattr(request, 'httprequest'):
                origin = request.httprequest.headers.get('Origin') or \
                         request.httprequest.headers.get('Host') or \
                         origin
        except:
            pass
        return origin

    def _ensure_socket_connected(self, connection=None, context_name="Campaign", max_wait=2):
        """Ensure socket is connected with the given connection's credentials
        
        Args:
            connection: WhatsApp connection to use (defaults to self.from_connection_id)
            context_name: Name for logging context (e.g., "Campaign", "Test", "Test Resend")
            max_wait: Maximum seconds to wait for socket confirmation (default: 2)
        
        Returns:
            bool: True if socket confirmed, False if timeout
        """
        if not connection:
            connection = self.from_connection_id
        
        if not connection:
            _logger.warning(f"[{context_name}] No connection provided, skipping socket check")
            return False
        
        # Get origin from request (for socket matching)
        origin = self._get_origin()
        
        # Trigger socket connection
        connection._trigger_socket_connection(origin)
        
        # Clear and wait for confirmation
        connection_sudo = connection.sudo()
        connection_sudo.socket_connection_ready = False
        connection_sudo.env.cr.commit()
        
        # Wait for socket connection
        check_interval = 0.1
        waited = 0
        
        socket_confirmed = False
        while waited < max_wait:
            fresh_env = connection_sudo.env(cr=connection_sudo.env.cr)
            fresh_record = fresh_env['whatsapp.connection'].browse(connection_sudo.id)
            fresh_record.invalidate_recordset(['socket_connection_ready'])
            
            if fresh_record.socket_connection_ready:
                socket_confirmed = True
                _logger.info(f"[{context_name}] Socket confirmed connected after {waited:.1f}s")
                break
            time.sleep(check_interval)
            waited += check_interval
        
        if not socket_confirmed:
            _logger.warning(f"[{context_name}] Socket not confirmed within {max_wait}s, proceeding anyway")
        
        return socket_confirmed

    @api.model
    def cron_send_campaign_messages(self):
        """Cron job to send campaign messages with random delays (60-120 seconds)
        
        This method processes one message per campaign per cron run.
        Runs every minute to send messages with random delays between 60-120 seconds.
        """
        campaigns = self.search([
            ('state', '=', 'sending'),
            ('pending_recipients', '!=', False),
            ('waiting_for_qr', '=', False),  # Skip campaigns waiting for QR scan
        ])
        
        for campaign in campaigns:
            try:
                # Parse pending recipients
                recipients = json.loads(campaign.pending_recipients or '[]')
                if not recipients:
                    # No more recipients, mark as sent
                    campaign.write({'state': 'sent'})
                    _logger.info(f"[Campaign {campaign.name}] Completed: {campaign.sent_count} sent, {campaign.failed_count} failed")
                    continue
                
                # Check if we need to wait (random delay between 60-120 seconds)
                if campaign.last_send_time:
                    time_since_last = (fields.Datetime.now() - campaign.last_send_time).total_seconds()
                    # Get the delay that was set for this campaign
                    next_delay = campaign.next_send_delay or random.uniform(60.0, 120.0)
                    
                    if time_since_last < next_delay:
                        # Not enough time has passed, skip this campaign for now
                        _logger.debug(f"[Campaign {campaign.name}] Waiting {next_delay - time_since_last:.1f}s more before next message")
                        continue
                else:
                    # First message - use the delay that was set when campaign was queued
                    next_delay = campaign.next_send_delay or random.uniform(60.0, 120.0)
                
                # Get next recipient
                recipient = recipients[0]
                
                _logger.info(f"[Campaign {campaign.name}] Sending to {recipient['phone']} ({recipient['name']})")
                
                # Send message
                result = campaign._send_to_recipient_via_api(
                    recipient['phone'],
                    recipient['name'],
                    campaign.body,
                    campaign.attachment_ids
                )
                
                # Handle QR popup if needed
                if result.get('qr_popup_needed'):
                    # Pause campaign - user needs to scan QR
                    _logger.warning(f"[Campaign {campaign.name}] QR code needed, pausing campaign. User must scan QR code first.")
                    campaign.write({'waiting_for_qr': True})  # Set flag so cron skips this campaign
                    continue
                
                # Update counts
                if result.get('success'):
                    campaign.sent_count += 1
                    _logger.info(f"[Campaign {campaign.name}] Successfully sent to {recipient['phone']}")
                else:
                    campaign.failed_count += 1
                    error_msg = result.get('error', 'Unknown error')
                    _logger.error(f"[Campaign {campaign.name}] Failed to send to {recipient['phone']}: {error_msg}")
                
                # Remove sent recipient from queue
                recipients.pop(0)
                
                # Generate delay for NEXT message (60-120 seconds)
                next_delay = random.uniform(60.0, 120.0)
                
                # Update campaign state
                campaign.write({
                    'pending_recipients': json.dumps(recipients) if recipients else False,
                    'current_recipient_index': campaign.current_recipient_index + 1,
                    'last_send_time': fields.Datetime.now(),
                    'next_send_delay': next_delay,  # Store delay for next message
                })
                
                _logger.info(f"[Campaign {campaign.name}] Progress: {campaign.sent_count} sent, {campaign.failed_count} failed, {len(recipients)} remaining. Next message in {next_delay:.1f}s")
                
                # If no more recipients, mark as sent
                if not recipients:
                    campaign.write({'state': 'sent'})
                    _logger.info(f"[Campaign {campaign.name}] Completed: {campaign.sent_count} sent, {campaign.failed_count} failed")
                    
            except Exception as e:
                _logger.exception(f"[Campaign {campaign.name}] Error in cron: {e}")
                # Continue with next campaign
                continue


class WhatsAppMarketingCampaignTest(models.TransientModel):
    _name = 'whatsapp.marketing.campaign.test'
    _description = 'WhatsApp Campaign Test Wizard'

    phone_to = fields.Char(
        string='Phone Number',
        help='Phone number to send test message to (e.g., +1234567890)',
        default=lambda self: self.env.user.partner_id.mobile or self.env.user.partner_id.phone or ''
    )
    campaign_id = fields.Many2one(
        'whatsapp.marketing.campaign',
        string='Campaign',
        ondelete='cascade'
    )

    @api.model
    def default_get(self, fields_list):
        """Set default phone number from user's profile"""
        result = super().default_get(fields_list)
        
        if 'phone_to' in fields_list and not result.get('phone_to'):
            user_phone = self.env.user.partner_id.mobile or self.env.user.partner_id.phone
            if user_phone:
                result['phone_to'] = user_phone
        
        return result

    def send_test(self):
        """Send test message to specified phone number"""
        self.ensure_one()
        
        if not self.campaign_id.body:
            raise UserError(_("Please enter campaign body in the campaign"))
        
        if not self.campaign_id.from_connection_id:
            raise UserError(_("Please select a connection in the campaign"))
        
        if not self.phone_to:
            raise UserError(_("Please enter a phone number"))
        
        # Ensure socket is connected before sending test
        self.campaign_id._ensure_socket_connected(
            connection=self.campaign_id.from_connection_id,
            context_name="Test"
        )
        
        # Send test message
        result = self.campaign_id._send_to_recipient_via_api(
            self.phone_to.strip(),
            'Test Recipient',
            self.campaign_id.body,
            self.campaign_id.attachment_ids,
            test_wizard_id=self.id,
            test_phone_to=self.phone_to.strip()
        )
        
        if result.get('qr_popup_needed'):
            return {
                'type': 'ir.actions.act_window',
                'name': 'WhatsApp Authentication Required',
                'res_model': 'whatsapp.qr.popup',
                'res_id': result.get('qr_popup_id'),
                'view_mode': 'form',
                'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                'target': 'new',
            }
        
        if result.get('success'):
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Test Sent'),
                    'message': _('Test message sent to %s') % self.phone_to,
                    'type': 'success',
                }
            }
        else:
            raise UserError(_("Failed to send test message: %s") % result.get('error', 'Unknown error'))

    def resend_test(self, popup=False):
        """Resend test message after QR authentication"""
        self.ensure_one()
        
        if not self.campaign_id.body:
            raise UserError(_("Please enter campaign body in the campaign"))
        
        if not self.campaign_id.from_connection_id:
            raise UserError(_("Please select a connection in the campaign"))
        
        if not self.phone_to:
            raise UserError(_("Please enter a phone number"))
        
        # Ensure socket is connected (in case connection changed after QR scan)
        self.campaign_id._ensure_socket_connected(
            connection=self.campaign_id.from_connection_id,
            context_name="Test Resend"
        )
        
        # Send test message again
        result = self.campaign_id._send_to_recipient_via_api(
            self.phone_to.strip(),
            'Test Recipient',
            self.campaign_id.body,
            self.campaign_id.attachment_ids,
            test_wizard_id=self.id,
            test_phone_to=self.phone_to.strip()
        )
        
     
        #     raise UserError(_("Failed to send test message: %s") % result.get('error', 'Unknown error'))
        if result.get('success'):
            # Send bus notification to close popup (like campaign does)
            popup_id = popup.id if popup else (
                self.env['whatsapp.qr.popup'].search([
                    ('original_test_wizard_id', '=', self.id)
                ], order='create_date desc', limit=1).id or 0
            )
            
            message = _("Test message sent to %s") % self.phone_to
            notif_type = "success"
            
            payload = {
                'action': 'close',
                'popup_id': popup_id,
                'title': _('WhatsApp Test'),
                'message': message,
                'type': notif_type,
                'sticky': False,
                'success': True
            }
            
            dbname = self._cr.dbname
            popup_channel = f"{dbname}_qr_popup_{popup_id}"
            self.env['bus.bus']._sendone(
                popup_channel,
                'qr_popup_close',
                payload
            )
            
            current_user = self.env.user
            if current_user and current_user.partner_id:
                self.env['bus.bus']._sendone(
                    current_user.partner_id,
                    'qr_popup_close',
                    payload
                )
            
            # Return notification action
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Test Sent'),
                    'message': message,
                    'type': 'success',
                }
            }
        else:
            raise UserError(_("Failed to send test message: %s") % result.get('error', 'Unknown error'))
