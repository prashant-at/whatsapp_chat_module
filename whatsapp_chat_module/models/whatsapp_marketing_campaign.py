# -*- coding: utf-8 -*-

import html2text
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import logging
import requests
import re
import json
import base64
import io
from ast import literal_eval
import time
from odoo import http

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
    
    

    pending_requests = fields.Text(
        'Pending Requests',
        default='[]',
        help="JSON array of API requests that failed due to connection issues (status 201). Will be retried when connection is ready."
    )

    campaign_id = fields.Char(
        'Campaign ID',
        help="Campaign ID returned from the marketing API after sending"
    )
    
    recipient_status_ids = fields.One2many(
        'whatsapp.campaign.recipient.status',
        'campaign_id',
        string='Recipient Statuses',
        help="Status of each recipient in the campaign"
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
                    
                    domain = self._safe_eval_domain(campaign.mailing_domain)
                except Exception as e:
                    _logger.warning(f"Error evaluating domain for campaign {campaign.id}: {e}")
                    domain = []
                records = self.env[campaign.mailing_model_real].search(domain)
            
            # Count records with phone numbers
            count = 0
            for record in records:
                phone = self._get_phone_from_record(record)
                if phone:
                    count += 1
            
            campaign.total_recipients = count

    def _safe_eval_domain(self, domain_str):
        """Safely evaluate domain string to prevent code injection"""
        if not domain_str:
            return []
        
        try:
           
            domain = literal_eval(domain_str)
            
            # Validate domain format - must be a list
            if not isinstance(domain, list):
                raise ValueError("Domain must be a list")
            
            # Validate each item is a tuple/list of length 3 (field, operator, value)
            for item in domain:
                if not isinstance(item, (list, tuple)) or len(item) != 3:
                    raise ValueError("Invalid domain format: each item must be a tuple of length 3")
            
            return domain
        except (ValueError, SyntaxError) as e:
            _logger.warning(f"Invalid domain format: {e}")
            return []
    
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
            # Check partner_mobile/partner_phone (for hr.applicant)
            if hasattr(record, 'partner_mobile') and record.partner_mobile:
                return record.partner_mobile
            elif hasattr(record, 'partner_phone') and record.partner_phone:
                return record.partner_phone
                
            if hasattr(record,'partner_id') and record.partner_id:
                return record.partner_id.mobile
            
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
               
                domain = self._safe_eval_domain(self.mailing_domain)
            except Exception as e:
                _logger.warning(f"Error evaluating domain for campaign {self.id}: {e}")
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

    def _clean_phone_for_marketing_api(self, phone):
        """Clean phone number for marketing API: remove +, spaces, keep only digits
        Example: '+91 9157000128' -> '919157000128'
        
        Args:
            phone: Phone number string (may contain +, spaces)
        
        Returns:
            str: Cleaned phone number with only digits
        """
        if not phone:
            return ''
        # Remove all non-digit characters (+, spaces, etc.)
        return re.sub(r'\D', '', phone)
    
    def _determine_message_type(self, attachments=None):
        """Determine message type based on attachments (like sendWhatsapp in compose wizard)
        
        Marketing API accepts messageType: image, video, document, chat
        
        Args:
            attachments: List of attachment records (defaults to self.attachment_ids)
        
        Returns:
            tuple: (message_type, file_type) where file_type is only set for documents
        """
        if attachments is None:
            attachments = self.attachment_ids
        
        has_attachments = bool(attachments)
        
        if not has_attachments:
            return 'chat', None
        
        # File extension mappings (same as _send_to_recipient_via_api)
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
        
        # Check first attachment to determine type
        attachment = attachments[0]
        filename = (attachment.name or 'attachment').lower()
        
        # Extract file extension
        if '.' in filename:
            file_ext = '.' + filename.rsplit('.', 1)[1]
        else:
            file_ext = None
        
        # Determine message type based on file extension
        # Marketing API accepts: image, video, document, chat (audio files are sent as document)
        if file_ext in image_extensions:
            return 'image', None
        elif file_ext in video_extensions:
            return 'video', None
        elif file_ext in audio_extensions:
            # Audio files are sent as document type for marketing API
            file_type = file_ext[1:].lower() if file_ext else 'bin'
            return 'document', file_type
        elif file_ext in document_extensions:
            file_type = file_ext[1:].lower()  # Remove dot and lowercase
            return 'document', file_type
        else:
            # Try to infer from mimetype
            mimetype = (getattr(attachment, 'mimetype', '') or '').lower()
            if any(img in mimetype for img in ['image', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']):
                return 'image', None
            elif any(vid in mimetype for vid in ['video', 'mp4', 'webm', 'avi', 'mov']):
                return 'video', None
            elif any(aud in mimetype for aud in ['audio', 'mp3', 'wav', 'ogg', 'm4a']):
                # Audio files are sent as document type for marketing API
                return 'document', 'bin'
            else:
                # Default to document with bin fileType
                return 'document', 'bin'
    
    def _send_via_marketing_api(self, body, tos, message_type='chat'):
        """Call new /api/marketing endpoint with pending request support
        
        Args:
            body: Message body/content
            tos: List of recipient dicts with 'name' and 'phone' keys
            message_type: Type of message (default: 'chat')
        
        Returns:
            dict: {'success': bool, 'pending': bool, 'error': str, 'response': dict}
        """
        try:
            print("Sending via marketing API _send_via_marketing_api called")
            # Get backend URL and API key
            backend_url = self.from_connection_id.get_backend_api_url() or "http://localhost:4000"
            api_url = f"{backend_url}/api/marketing"
            api_key = self.from_connection_id.api_key
            phone_number = self.from_connection_id.from_field
            
            if not api_key:
                return {'success': False, 'error': 'API key not found'}
            
            # Clean phone number for header (remove +, spaces)
            cleaned_phone = self._clean_phone_for_marketing_api(phone_number)
            
            # Prepare form data
            form_data = {
                'messageType': message_type,
                'body': body.replace('\n',''),
            }
            
            # Clean phone numbers in tos and add recipients as tos[0], tos[1], etc.
            cleaned_tos = []
            for recipient in tos:
                cleaned_recipient = {
                    'name': recipient.get('name', ''),
                    'phone': self._clean_phone_for_marketing_api(recipient.get('phone', ''))
                }
                cleaned_tos.append(cleaned_recipient)
            
            for index, recipient in enumerate(cleaned_tos):
                form_data[f'tos[{index}]'] = json.dumps(recipient)
            
            # Prepare files (attachments) for media types: image, video, document
            # Marketing API accepts messageType: image, video, document, chat
            # files = []
            # if message_type in ['image', 'video', 'document'] and self.attachment_ids:
            #     import io
            #     for attachment in self.attachment_ids:
            #         try:
            #             # Decode attachment data from base64
            #             b64_value = attachment.sudo().datas or ''
            #             if b64_value:
            #                 # Handle string/bytes conversion
            #                 if isinstance(b64_value, bytes):
            #                     b64_value = b64_value.decode('utf-8', errors='ignore')
            #                 # Remove data URI prefix if present
            #                 if isinstance(b64_value, str) and b64_value.startswith('data:'):
            #                     b64_value = b64_value.split(',', 1)[1] if ',' in b64_value else b64_value
                            
            #                 # Fix base64 padding
            #                 if isinstance(b64_value, str):
            #                     pad = len(b64_value) % 4
            #                     if pad:
            #                         b64_value = b64_value + ('=' * (4 - pad))
                                
            #                     file_data = base64.b64decode(b64_value)
            #             else:
            #                 continue
            #         except Exception as e:
            #             _logger.error(f"Error decoding attachment {attachment.id} for marketing campaign: {e}")
            #             continue
                    
            #         # Sanitize filename
            #         raw_name = (attachment.name or 'attachment')
            #         filename = raw_name.replace('/', '_').replace('\\', '_')
            #         mimetype = getattr(attachment, 'mimetype', None) or 'application/octet-stream'
                    
            #         # Force PDF mimetype if filename ends with .pdf
            #         if filename.lower().endswith('.pdf'):
            #             mimetype = 'application/pdf'
                    
            #         # Add file
            #         if file_data and len(file_data) > 0:
            #             files.append((
            #                 f'files[{len(files)}]',
            #                 (filename, io.BytesIO(file_data), mimetype)
            #             ))
            # Build files dict for requests (multipart/form-data)
            files = {}

            if message_type in ['image', 'video', 'document'] and self.attachment_ids:
                for idx, attachment in enumerate(self.attachment_ids):

                    # Decode base64 to bytes
                    b64_value = attachment.datas or ''
                    if isinstance(b64_value, bytes):
                        b64_value = b64_value.decode('utf-8')

                    if b64_value.startswith("data:"):
                        b64_value = b64_value.split(",", 1)[1]

                    # Fix padding
                    pad = len(b64_value) % 4
                    if pad:
                        b64_value += "=" * (4 - pad)

                    file_bytes = base64.b64decode(b64_value)

                    filename = attachment.name.replace("/", "_").replace("\\", "_")
                    mimetype = attachment.mimetype or "application/octet-stream"

                    # Add to dict → REQUIRED for multipart
                    files[f"files[{idx}]"] = (filename, file_bytes, mimetype)

            # If no files, force multipart/form-data anyway
            if not files:
                files["empty"] = ("empty.txt", b"", "text/plain")
            
            # Make request with lowercase headers
            headers = {
                'x-api-key': api_key,
                'x-phone-number': phone_number,
                'origin': self._get_origin(),
            }
            print("request data", form_data, files, headers)
            response = requests.post(
                api_url,
                data=form_data,
                files=files if files else {},  # Always include files parameter (empty array if no attachments)
                headers=headers,
                timeout=30
            )
            
            # Status 201 - store in pending requests, wait for socket event
            if response.status_code == 201:
                pending_requests = json.loads(self.pending_requests or '[]')
                
                # Store file data as base64 for JSON serialization
                files_data = []
                if files:
                    for f in files:
                        field_name = f[0]  # e.g., 'files[0]'
                        file_tuple = f[1]  # (filename, BytesIO, mimetype)
                        
                        if isinstance(file_tuple, tuple) and len(file_tuple) >= 3:
                            filename = file_tuple[0]
                            file_io = file_tuple[1]
                            mimetype = file_tuple[2]
                            
                            # Read bytes from BytesIO
                            if hasattr(file_io, 'read'):
                                file_bytes = file_io.read()
                                if hasattr(file_io, 'seek'):
                                    file_io.seek(0)
                            else:
                                file_bytes = file_io if isinstance(file_io, bytes) else b''
                            
                            # Encode to base64 for JSON storage
                            file_b64 = base64.b64encode(file_bytes).decode('utf-8') if file_bytes else ''
                            files_data.append((field_name, filename, file_b64, mimetype))
                
                pending_requests.append({
                    'type': 'sendMarketing',
                    'data': {
                        'body': body,
                        'tos': cleaned_tos,  # Store cleaned tos (with cleaned phone numbers)
                        'message_type': message_type,
                        'files': files_data,  # Store base64-encoded files
                    },
                    'timestamp': fields.Datetime.now().isoformat(),
                })
                self.write({'pending_requests': json.dumps(pending_requests)})
                _logger.info(f"[Campaign {self.name}] Request stored in pending (status 201). Waiting for socket event.")
                return {'success': False, 'pending': True}
            
            # Status 200 - success
            if response.status_code == 200:
                try:
                    response_data = response.json()
                    return {'success': True, 'response': response_data}
                except Exception as json_error:
                    _logger.warning(f"[Campaign {self.name}] Could not parse response JSON: {json_error}")
                    return {'success': True, 'response': {}}
            else:
                error_msg = f"API returned status {response.status_code}"
                try:
                    error_data = response.json()
                    error_msg = error_data.get('message', error_msg)
                except:
                    pass
                return {'success': False, 'error': error_msg}
                
        except requests.exceptions.RequestException as e:
            _logger.exception(f"[Campaign {self.name}] Network error calling marketing API: {e}")
            return {'success': False, 'error': f'Network error: {str(e)}'}
        except Exception as e:
            _logger.exception(f"[Campaign {self.name}] Error calling marketing API: {e}")
            return {'success': False, 'error': str(e)}

    def _parse_and_save_status_records(self, response_data):
        """Parse API response and save/update recipient status records
        
        Args:
            response_data: API response dict with structure: {'data': {'items': [{'to': 'phone', 'ack': 'status_code'}]}}
            
        Returns:
            int: Number of status records created/updated
        """
        # Parse response - handle paginated structure: { "data": { "items": [...] } }
        recipients = []
        
        if isinstance(response_data, dict):
            if 'data' in response_data:
                data = response_data['data']
                if isinstance(data, dict) and 'items' in data:
                    recipients = data['items']
                elif isinstance(data, list):
                    recipients = data
            elif 'messages' in response_data:
                recipients = response_data['messages']
            elif 'recipients' in response_data:
                recipients = response_data['recipients']
        elif isinstance(response_data, list):
            recipients = response_data
        
        if not recipients:
            return 0
        
        # Get existing records indexed by phone number for efficient lookup
        existing_records = {rec.phone: rec for rec in self.recipient_status_ids if rec.phone}
        
        # Mapping: ack value -> status text
        ACK_STATUS_MAP = {
            '-1': 'Error',
            '0': 'Pending',
            '1': 'Sent',
            '2': 'Reached',
            '3': 'Seen',
            '4': 'Seen',
        }
        
        # Process recipients: update existing or create new
        updated_count = 0
        created_count = 0
        
        for item in recipients:
            # Extract phone from 'to' field (primary field in API response)
            phone = item.get('to', '') or item.get('phone', '') or item.get('phoneNumber', '')
            
            # Extract ack and map to status text
            ack = item.get('ack', '')
            if isinstance(ack, (int, float)):
                ack = str(int(ack))
            else:
                ack = str(ack) if ack else ''
            
            # Map ack to status text (default to 'pending' if unknown)
            status = ACK_STATUS_MAP.get(ack, 'pending')
            
            if phone:
                if phone in existing_records:
                    # Update existing record
                    existing_records[phone].write({'status': status})
                    updated_count += 1
                else:
                    # Create new record
                    self.env['whatsapp.campaign.recipient.status'].create({
                        'campaign_id': self.id,
                        'phone': phone,
                        'status': status,
                    })
                    created_count += 1
        
        return updated_count + created_count

    def _fetch_status_via_api(self):
        """Call /api/marketing-message endpoint with pending request support
        
        Returns:
            dict: {'success': bool, 'pending': bool, 'error': str, 'response': dict}
        """
        try:
            # Get backend URL and API key
            backend_url = self.from_connection_id.get_backend_api_url() or "http://localhost:4000"
            api_url = f"{backend_url}/api/marketing-message"
            api_key = self.from_connection_id.api_key
            phone_number = self.from_connection_id.from_field
            
            if not api_key:
                return {'success': False, 'error': 'API key not found'}
            
            # Prepare headers
            headers = {
                'x-api-key': api_key,
                'x-phone-number': phone_number,
                'origin': self._get_origin(),
            }
            
            # Make GET request with marketingId and hasPagination query parameters
            response = requests.get(
                api_url,
                params={
                    'marketingId': self.campaign_id,
                    'hasPagination': 'true'
                },
                headers=headers,
                timeout=30
            )
            
            # Status 201 - store in pending requests, wait for socket event
            if response.status_code == 201:
                pending_requests = json.loads(self.pending_requests or '[]')
                
                pending_requests.append({
                    'type': 'fetchStatus',
                    'data': {
                        'campaign_id': self.campaign_id,
                    },
                    'timestamp': fields.Datetime.now().isoformat(),
                })
                self.write({'pending_requests': json.dumps(pending_requests)})
                _logger.info(f"[Campaign {self.name}] Status fetch request stored in pending (status 201). Waiting for socket event.")
                return {'success': False, 'pending': True}
            
            # Status 200 - success
            if response.status_code == 200:
                try:
                    print("response", response.json())
                    response_data = response.json()
                    return {'success': True, 'response': response_data}
                except Exception as json_error:
                    _logger.warning(f"[Campaign {self.name}] Could not parse status response JSON: {json_error}")
                    return {'success': True, 'response': {}}
            else:
                error_msg = f"API returned status {response.status_code}"
                try:
                    error_data = response.json()
                    error_msg = error_data.get('message', error_msg)
                except:
                    pass
                return {'success': False, 'error': error_msg}
                
        except requests.exceptions.RequestException as e:
            _logger.exception(f"[Campaign {self.name}] Network error fetching status: {e}")
            return {'success': False, 'error': f'Network error: {str(e)}'}
        except Exception as e:
            _logger.exception(f"[Campaign {self.name}] Error fetching status: {e}")
            return {'success': False, 'error': str(e)}

    def action_send(self):
        """Send campaign via new marketing API - backend handles all sending"""
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
        print("recipients", recipients)
        if not recipients:
            raise UserError(_("No valid phone numbers found in selected mailing lists"))
        
        # Prepare recipients for API
        tos = []
        for recipient in recipients:
            tos.append({
                "name": recipient.get('name', ''),
                "phone": recipient['phone']
            })
        
        # Determine message type based on attachments (like sendWhatsapp)
        message_type, file_type = self._determine_message_type()
        
        textContent = html2text.html2text(self.body) if self.body else ""
        print("textContent", textContent)
        # Call new marketing API
        result = self._send_via_marketing_api(
            body=textContent,
            tos=tos,
            message_type=message_type
        )
        
        # Handle pending (status 201) - request stored, waiting for socket event
        if result.get('pending'):
                self.write({
                'state': 'sending',
                'sent_count': 0,
                    'failed_count': 0,
                })
                
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                    'title': _('Campaign Queued'),
                    'message': _('Campaign queued successfully. Waiting for connection to be ready. QR code will appear if authentication is needed.'),
                        'type': 'info',
                        'sticky': False,
                    }
                }
        
        # Handle success
        if result.get('success'):
            # Extract campaign_id from API response
            response_data = result.get('response', {})
            print("response_data", response_data)
            # api_campaign_id = response_data.get('campaignId') or response_data.get('id')
            api_campaign_id = response_data.get('data', {}).get('id') 
            
            self.write({
                'state': 'sent',
                'sent_count': len(recipients),
                'failed_count': 0,
                'campaign_id': api_campaign_id,
            })

            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Campaign Sent'),
                    'message': _('Campaign sent successfully to %d recipients.') % len(recipients),
                    'type': 'success',
                    'sticky': False,
                    }
                }
        else:
            # Failed
            error_msg = result.get('error', 'Unknown error')
            self.write({'state': 'draft'})
            raise UserError(_("Failed to send campaign: %s") % error_msg)

    def action_fetch_status(self):
        """Fetch recipient statuses from the marketing API"""
        self.ensure_one()
        
        if not self.campaign_id:
            raise UserError(_("No campaign ID available. Please send the campaign first."))
        
        if not self.from_connection_id:
            raise UserError(_("No connection configured for this campaign."))
        
        # Ensure socket is connected (for QR handling if needed)
        self._ensure_socket_connected(context_name="Fetch Status")
        
        # Call status API
        result = self._fetch_status_via_api()
        
        # Handle pending (status 201) - request stored, waiting for socket event
        if result.get('pending'):
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Status Fetch Queued'),
                    'message': _('Status fetch request queued. Waiting for connection to be ready. It will be retried automatically.'),
                    'type': 'info',
                    'sticky': False,
                }
            }
        
        # Handle success
        if result.get('success'):
            response_data = result.get('response', {})
            status_count = self._parse_and_save_status_records(response_data)
            
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('Status Fetched'),
                    'message': _('Retrieved status for %d recipients.') % status_count,
                    'type': 'success',
                    'sticky': False,
                }
            }
        else:
            # Failed
            error_msg = result.get('error', 'Unknown error')
            raise UserError(_("Failed to fetch status: %s") % error_msg)

    # def _send_to_recipient_via_api(self, phone, contact_name, body, attachments, test_wizard_id=None, test_phone_to=None):
    #     """Send WhatsApp message via REST API - returns dict with success/qr_popup_needed
        
    #     Args:
    #         phone: Phone number to send to
    #         contact_name: Name of the contact
    #         body: Message body
    #         attachments: Attachments to send
    #         test_wizard_id: Optional ID of test wizard if this is a test send
    #         test_phone_to: Optional test phone number to store in QR popup (for resend if wizard is closed)
    #     """
    #     self.ensure_one()
        
    #     raw_phone = phone or ''
    #     compact = re.sub(r'\s+', ' ', raw_phone).strip()
    #     m = re.match(r'^(\+\d{1,3})\s*(.*)$', compact)
    #     if m:
    #         cc = m.group(1)
    #         rest = re.sub(r'\s+', '', m.group(2))
    #         phone = f"{cc} {rest}" if rest else cc
    #     else:
    #         phone = re.sub(r'\s+', '', raw_phone)
    
    #     # Security: Don't log phone numbers in production
    #     _logger.debug(f"[Campaign] Sending message to recipient")
    #     try:
    #         # Convert HTML body to plain text
    #         if body:
    #             soup = BeautifulSoup(body, 'html.parser')
    #             plain_text = soup.get_text(separator=' ')
    #             plain_text = re.sub(r' {3,}', ' ', plain_text)
    #             plain_text = plain_text.replace('&nbsp;', ' ')
    #             plain_text = plain_text.replace('&amp;', '&')
    #             plain_text = plain_text.replace('&lt;', '<')
    #             plain_text = plain_text.replace('&gt;', '>')
    #             plain_text = plain_text.replace('&quot;', '"')
    #         else:
    #             plain_text = ""
            
    #         # Prepare headers
    #         headers = {
    #             'x-api-key': self.from_connection_id.api_key,
    #             'x-phone-number': self.from_connection_id.from_field,
    #             'origin': self._get_origin(),
    #         }
    #         api_url = "http://localhost:4000"
    #         # backend_url = self.env['whatsapp.connection'].get_backend_api_url()
    #         api_url = api_url + "/api/message"
    #         # Security: Don't log API URL which might contain sensitive information
    #         _logger.debug(f"[Campaign] Sending message via API")
    #         has_attachments = bool(attachments)
            
    #         # Determine message type and file type handling based on backend requirements
    #         # Backend accepts: chat, image, video, document, audio, vcard, multi_vcard, location
    #         image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.webp', '.ico', '.heic'}
    #         video_extensions = {'.mp4', '.webm', '.ogv', '.avi', '.mov', '.wmv', '.mkv', '.flv', '.3gp'}
    #         audio_extensions = {'.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mid', '.midi'}
    #         document_extensions = {
    #             '.txt', '.csv', '.html', '.css', '.js', '.json', '.xml', '.md', '.yml', '.yaml', '.pdf', 
    #             '.zip', '.rar', '.7z', '.tar', '.gz', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', 
    #             '.odt', '.ods', '.odp', '.odg', '.py', '.java', '.c', '.cpp', '.sh', '.php', '.rb', '.sql', 
    #             '.ics', '.vcard', '.vcf', '.ttf', '.otf', '.woff', '.woff2', '.deb', '.rpm', '.apk', '.dmg', 
    #             '.pkg', '.bin', '.wasm'
    #         }
            
    #         message_type = 'chat'
    #         file_type = None
            
    #         if has_attachments:
    #             # Check first attachment to determine type
    #             attachment = attachments[0]
    #             filename = (attachment.name or 'attachment').lower()
                
    #             # Extract file extension
    #             if '.' in filename:
    #                 file_ext = '.' + filename.rsplit('.', 1)[1]
    #             else:
    #                 file_ext = None
                
    #             # Determine message type based on file extension
    #             if file_ext in image_extensions:
    #                 message_type = 'image'
    #             elif file_ext in video_extensions:
    #                 message_type = 'video'
    #             elif file_ext in audio_extensions:
    #                 message_type = 'audio'
    #             elif file_ext in document_extensions:
    #                 message_type = 'document'
    #                 # Extract fileType for documents (without the dot)
    #                 file_type = file_ext[1:].lower()  # Remove dot and lowercase
    #             else:
    #                 # Try to infer from mimetype
    #                 mimetype = (getattr(attachment, 'mimetype', '') or '').lower()
    #                 if any(img in mimetype for img in ['image', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']):
    #                     message_type = 'image'
    #                 elif any(vid in mimetype for vid in ['video', 'mp4', 'webm', 'avi', 'mov']):
    #                     message_type = 'video'
    #                 elif any(aud in mimetype for aud in ['audio', 'mp3', 'wav', 'ogg', 'm4a']):
    #                     message_type = 'audio'
    #                 else:
    #                     # Default to document with bin fileType
    #                     message_type = 'document'
    #                     file_type = 'bin'
            
    #         # Debug: message type logged at debug level
    #         _logger.debug(f"[Campaign] Message type: {message_type}")
    #         # Always use FormData for all message types
    #         form_data = {
    #             'byChatId': 'false',
    #             'to': phone,
    #             'messageType': message_type,
    #             'body': plain_text,
    #         }
            
    #         # Add fileType parameter only for documents
    #         if message_type == 'document' and file_type:
    #             form_data['fileType'] = file_type
            
    #         # Prepare files list - always include, even if empty
    #         files = []
    #         if has_attachments:
    #             for attachment in attachments:
    #                 file_data = b''
                    
    #                 try:
    #                     b64_value = attachment.sudo().datas or ''
    #                     if isinstance(b64_value, bytes):
    #                         b64_value = b64_value.decode('utf-8', errors='ignore')
    #                     if isinstance(b64_value, str) and b64_value.startswith('data:'):
    #                         b64_value = b64_value.split(',', 1)[1] if ',' in b64_value else b64_value
    #                     if isinstance(b64_value, str):
    #                         pad = len(b64_value) % 4
    #                         if pad:
    #                             b64_value = b64_value + ('=' * (4 - pad))
    #                         file_data = base64.b64decode(b64_value)
    #                 except Exception as e:
    #                     _logger.error(f"Error decoding attachment: {e}")
    #                     continue
                    
    #                 filename = (attachment.name or 'attachment').replace('/', '_').replace('\\', '_')
    #                 mimetype = getattr(attachment, 'mimetype', None) or 'application/octet-stream'
    #                 if filename.lower().endswith('.pdf'):
    #                     mimetype = 'application/pdf'
                    
    #                 if file_data and len(file_data) > 0:
    #                     files.append((f'files[{len(files)}]', (filename, io.BytesIO(file_data), mimetype)))
            
    #         # Always send with FormData - files will be empty list [] if no attachments
    #         print("request data", form_data, files, headers)
    #         response = requests.post(
    #             api_url,
    #             data=form_data,
    #             files=files or {},  # Empty list [] if no attachments
    #             headers=headers,
    #             timeout=120
    #         )
            
    #         # Handle response - 201 indicates QR code scanning is needed
    #         if response.status_code == 201:
    #             # Store request in pending - QR will come via socket event
    #             pending_requests = json.loads(self.pending_requests or '[]')
                
    #             # Store files as base64-encoded strings for JSON serialization
    #             files_data = []
    #             if files:
    #                 for f in files:
    #                     filename = f[0]
    #                     file_obj = f[1]
    #                     if hasattr(file_obj, 'read'):
    #                         file_bytes = file_obj.read()
    #                         if hasattr(file_obj, 'seek'):
    #                             file_obj.seek(0)
    #                     else:
    #                         file_bytes = file_obj if isinstance(file_obj, bytes) else b''
    #                     # Encode to base64 for JSON storage
    #                     file_b64 = base64.b64encode(file_bytes).decode('utf-8') if file_bytes else ''
    #                     files_data.append((filename, file_b64))
                
    #             # Store request data for retry
    #             request_data = {
    #                 'type': 'sendMessage',
    #                 'data': {
    #                     'api_url': api_url,
    #                     'form_data': form_data,
    #                     'files': files_data,  # List of (filename, base64_string) tuples
    #                     'headers': headers,
    #                     'phone': phone,
    #                     'contact_name': contact_name,
    #                     'body': plain_text,
    #                     'attachments': [att.id for att in attachments] if attachments else [],
    #                     'test_wizard_id': test_wizard_id,
    #                     'test_phone_to': test_phone_to,
    #                 },
    #                 'timestamp': fields.Datetime.now().isoformat(),
    #             }
                
    #             pending_requests.append(request_data)
    #             self.write({'pending_requests': json.dumps(pending_requests)})
                
    #             _logger.info(f"[Campaign {self.name}] Request stored in pending (status 201). Waiting for socket event.")
                
    #             # For test messages, still return qr_popup_needed flag for UI feedback
    #             # But QR popup will be created from socket event
    #             if test_wizard_id:
    #                 return {
    #                     'qr_popup_needed': True,
    #                     'pending': True,
    #                 }
    #             else:
    #                 return {'pending': True}
            
    #         # Handle 200 status (success)
    #         elif response.status_code == 200:
    #             try:
    #                 response_data = response.json()
    #             except Exception as json_error:
    #                 return {'success': False, 'error': f'Invalid JSON: {json_error}'}
                
    #             # Check success flag
    #             if response_data.get('success', False):
    #                 return {'success': True}
    #             else:
    #                 error_detail = response_data.get('error', response_data.get('message', 'Unknown error'))
    #                 if isinstance(error_detail, dict):
    #                     error_detail = error_detail.get('message', str(error_detail))
    #                 return {'success': False, 'error': error_detail}
    #         else:
    #             # Error response
    #             try:
    #                 error_response = response.json()
    #                 error_detail = error_response.get('error', error_response.get('message', 'Unknown error'))
    #                 if isinstance(error_detail, dict):
    #                     error_detail = error_detail.get('message', str(error_detail))
    #             except:
    #                 error_detail = response.text[:200] if response.text else "Unknown error"
                
    #             return {'success': False, 'error': error_detail}

    #     except Exception as e:
    #         _logger.exception(f"Error sending to {contact_name}: {e}")
    #         return {'success': False, 'error': str(e)}

   

    def _get_origin(self):
        """Get origin from request headers"""
        origin = '127.0.0.1'
        try:
            
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
    def handle_status_socket_event(self, status_data, connection_id=None):
        """Handle status socket events (qr_code, ready, etc.) for all campaigns
        
        Args:
            status_data: Dict with status event data from socket
            connection_id: ID of connection (optional filter)
        
        Returns:
            dict: Action to open QR popup if QR event, True if ready event, False otherwise
        """
        if not isinstance(status_data, dict):
            _logger.warning(f"[Campaign] Invalid status_data format: {type(status_data)}")
            return False
        
        event_type = status_data.get('type') or status_data.get('status')
        
        if event_type == 'ready':
            return self._handle_ready_status_event(connection_id)
        
        return False

   
    @api.model
    def _handle_ready_status_event(self, connection_id=None):
        """Handle ready status event - retry all pending requests for ready connections.
        
        Only retries campaigns whose connection (from_connection_id) is ready.
        Uses database locking (FOR UPDATE SKIP LOCKED) to prevent SerializationFailure
        when multiple ready events are processed concurrently.
        
        Args:
            connection_id: ID of connection (optional filter). If None, finds all ready connections.
        
        Returns:
            bool: True if any requests were retried
        """
        try:
            # Step 1: Find all connections that are ready
            if connection_id:
                ready_connection_ids = [connection_id]
                _logger.info(f"[Ready Event] Using provided connection_id: {connection_id}")
            else:
                ready_connections = self.env['whatsapp.connection'].search([
                    ('socket_connection_ready', '=', True)
                ])
                if not ready_connections:
                    _logger.info("[Ready Event] No ready connections found, skipping campaign retry")
                    return False
                ready_connection_ids = ready_connections.ids
                _logger.info(f"[Ready Event] Found {len(ready_connection_ids)} ready connection(s): {ready_connection_ids}")
            
            # Step 2: Find campaigns with pending requests for ready connections
            # Use raw SQL with FOR UPDATE SKIP LOCKED to prevent concurrent updates
            self.env.cr.execute("""
                SELECT id, from_connection_id
                FROM whatsapp_marketing_campaign
                WHERE pending_requests IS NOT NULL
                  AND pending_requests != '[]'
                  AND pending_requests != ''
                  AND from_connection_id IN %s
                FOR UPDATE SKIP LOCKED
            """, (tuple(ready_connection_ids),))
            
            locked_rows = self.env.cr.fetchall()
            locked_campaign_ids = [row[0] for row in locked_rows]
            
            if not locked_campaign_ids:
                _logger.info("[Ready Event] No campaigns with pending requests found for ready connections")
                return False
            
            _logger.info(f"[Ready Event] Locked {len(locked_campaign_ids)} campaign(s) for retry: {locked_campaign_ids}")
            
            # Step 3: Process only the locked campaigns
            campaigns = self.browse(locked_campaign_ids)
            retried_count = 0
            processed_count = 0
            
            for campaign in campaigns:
                try:
                    pending_requests = json.loads(campaign.pending_requests or '[]')
                    if not pending_requests:
                        _logger.debug(f"[Ready Event] Campaign {campaign.name} (ID: {campaign.id}) has no pending requests, skipping")
                        continue
                    
                    _logger.info(f"[Ready Event] Campaign {campaign.name} (ID: {campaign.id}, Connection: {campaign.from_connection_id.id if campaign.from_connection_id else 'None'}): Retrying {len(pending_requests)} pending requests")
                    
                    # Retry each pending request
                    successful = 0
                    failed = 0
                    still_pending = []
                    
                    for idx, request in enumerate(pending_requests, 1):
                        request_type = request.get('type')
                        data = request.get('data', {})
                        
                        if request_type == 'sendMarketing':
                            result = campaign._send_via_marketing_api(
                                body=data.get('body', ''),
                                tos=data.get('tos', []),
                                message_type=data.get('message_type', 'chat')
                            )
                            
                            if result.get('success'):
                                # Extract and save campaign_id from response
                                response_data = result.get('response', {})
                                api_campaign_id = response_data.get('data', {}).get('id')
                                if api_campaign_id:
                                    campaign.write({'campaign_id': api_campaign_id})
                                
                                successful += 1
                                _logger.info(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} retried successfully")
                            elif result.get('pending'):
                                still_pending.append(request)
                                _logger.info(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} still pending (201)")
                            else:
                                failed += 1
                                _logger.warning(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} failed: {result.get('error')}")
                        
                        elif request_type == 'fetchStatus':
                            result = campaign._fetch_status_via_api()
                            
                            if result.get('success'):
                                response_data = result.get('response', {})
                                status_count = campaign._parse_and_save_status_records(response_data)
                                successful += 1
                                _logger.info(f"[Ready Event] Campaign {campaign.name}: Status fetch {idx}/{len(pending_requests)} retried successfully, retrieved {status_count} statuses")
                            elif result.get('pending'):
                                still_pending.append(request)
                                _logger.info(f"[Ready Event] Campaign {campaign.name}: Status fetch {idx}/{len(pending_requests)} still pending (201)")
                            else:
                                failed += 1
                                _logger.warning(f"[Ready Event] Campaign {campaign.name}: Status fetch {idx}/{len(pending_requests)} failed: {result.get('error')}")
                        
                        elif request_type == 'sendMessage':
                            # Retry single message send
                            try:
                                # Reconstruct files from base64
                                files_data = data.get('files', [])
                                files = []
                                if files_data:
                                    for file_tuple in files_data:
                                        if isinstance(file_tuple, (list, tuple)) and len(file_tuple) >= 2:
                                            filename = file_tuple[0]
                                            file_data = file_tuple[1]
                                            # Decode from base64 if it's a string
                                            if isinstance(file_data, str):
                                                try:
                                                    file_bytes = base64.b64decode(file_data)
                                                    files.append((filename, io.BytesIO(file_bytes)))
                                                except Exception as e:
                                                    _logger.warning(f"[Ready Event] Campaign {campaign.name}: Error decoding file {filename}: {e}")
                                                    continue
                                            elif isinstance(file_data, bytes):
                                                files.append((filename, io.BytesIO(file_data)))
                                            else:
                                                files.append((filename, file_data))
                                
                                response = requests.post(
                                    data.get('api_url'),
                                    data=data.get('form_data', {}),
                                    files=files if files else [],
                                    headers=data.get('headers', {}),
                                    timeout=120
                                )
                                
                                if response.status_code == 201:
                                    still_pending.append(request)
                                    _logger.info(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} still pending (201)")
                                elif response.status_code == 200:
                                    successful += 1
                                    _logger.info(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} retried successfully")
                                else:
                                    failed += 1
                                    _logger.warning(f"[Ready Event] Campaign {campaign.name}: Request {idx}/{len(pending_requests)} failed: status {response.status_code}")
                            except Exception as e:
                                failed += 1
                                _logger.exception(f"[Ready Event] Campaign {campaign.name}: Error retrying message request {idx}/{len(pending_requests)}: {e}")
                    
                    # Update pending requests (keep only those that are still pending)
                    campaign.write({
                        'pending_requests': json.dumps(still_pending),
                    })
                    
                    # Update campaign state and counts if all requests are processed
                    if not still_pending:  # All requests completed (successfully or failed)
                        # All pending requests have been processed
                        # Each request = 1 recipient
                        campaign.write({
                            'state': 'sent',
                            'sent_count': campaign.sent_count + successful,
                            'failed_count': campaign.failed_count + failed,
                        })
                        _logger.info(f"[Ready Event] Campaign {campaign.name}: All requests processed. State updated to 'sent'. Success: {successful}, Failed: {failed}")
                    else:
                        # Some requests are still pending, keep state as 'sending'
                        # Update counts for completed requests (each request = 1 recipient)
                        campaign.write({
                            'sent_count': campaign.sent_count + successful,
                            'failed_count': campaign.failed_count + failed,
                        })
                        _logger.info(f"[Ready Event] Campaign {campaign.name}: {len(still_pending)} requests still pending. State remains 'sending'. Success: {successful}, Failed: {failed}")
                    
                    
                    retried_count += len(pending_requests)
                    processed_count += 1
                    _logger.info(f"[Ready Event] Campaign {campaign.name}: Retried {len(pending_requests)} requests - {successful} success, {failed} failed, {len(still_pending)} still pending")
                    
                except Exception as e:
                    _logger.exception(f"[Ready Event] Error retrying pending requests for campaign {campaign.name} (ID: {campaign.id}): {e}")
            
            _logger.info(f"[Ready Event] Successfully processed {processed_count}/{len(locked_campaign_ids)} campaign(s), retried {retried_count} total requests")
            return retried_count > 0
            
        except Exception as e:
            _logger.exception(f"[Ready Event] Error handling ready status event: {e}")
            return False

   

class WhatsAppCampaignRecipientStatus(models.Model):
    _name = 'whatsapp.campaign.recipient.status'
    _description = 'WhatsApp Campaign Recipient Status'
    _order = 'id'

    campaign_id = fields.Many2one(
        'whatsapp.marketing.campaign',
        string='Campaign',
        ondelete='cascade'
    )
    phone = fields.Char(
        'Phone Number',
        help="Recipient phone number"
    )
    status = fields.Char(
        'Status',
        help="Delivery status from the API (Error, Pending, Sent, Reached, Seen)"
    )
    
    status_display = fields.Html(
        string='Status',
        compute='_compute_status_display',
        sanitize=False,
        help="Status displayed as colored tag"
    )
    
    @api.depends('status')
    def _compute_status_display(self):
        """Compute HTML tag for status display with exact custom colors"""
        STATUS_CONFIG = {
            'Error': ('Error', '#E53935','#ffffff'),
            'Pending': ('Pending', '#FB8C00','#ffffff'),
            'Sent': ('Sent', '#ffff00','#000000'),
            'Reached': ('Reached', '#1E88E5','#ffffff'),
            'Seen': ('Seen','#43A047','#ffffff'),
        }
        
        for record in self:
            status = record.status or ''
            config = STATUS_CONFIG.get(status) or STATUS_CONFIG.get(status.lower(), ('Pending', '#FB8C00'))
            text, color, text_color = config

            record.status_display = f'''
                <span style="background-color: {color}; color: {text_color}; padding: 3px 12px; border-radius: 100px; font-size: 12px; font-weight: 500; display: inline-block;">
                    {text}
                </span>
            '''
   

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
        text = html2text.html2text(self.campaign_id.body)
        message_type, file_type = self.campaign_id._determine_message_type()
        tos = [{'name': 'Test Recipient', 'phone': self.phone_to.strip()}]
        result = self.campaign_id._send_via_marketing_api(body=text, tos=tos, message_type=message_type)
        
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

    # def resend_test(self, popup=False):
    #     """Resend test message after QR authentication"""
    #     self.ensure_one()
        
    #     if not self.campaign_id.body:
    #         raise UserError(_("Please enter campaign body in the campaign"))
        
    #     if not self.campaign_id.from_connection_id:
    #         raise UserError(_("Please select a connection in the campaign"))
        
    #     if not self.phone_to:
    #         raise UserError(_("Please enter a phone number"))
        
    #     # Ensure socket is connected (in case connection changed after QR scan)
    #     self.campaign_id._ensure_socket_connected(
    #         connection=self.campaign_id.from_connection_id,
    #         context_name="Test Resend"
    #     )
        
    #     text = html2text.html2text(self.campaign_id.body)
    #     message_type, file_type = self.campaign_id._determine_message_type()
    #     tos = [{'name': 'Test Recipient', 'phone': self.phone_to.strip()}]
    #     result = self.campaign_id._send_via_marketing_api(body=text, tos=tos, message_type=message_type)
        
        
     
        #     raise UserError(_("Failed to send test message: %s") % result.get('error', 'Unknown error'))
        # if result.get('success'):
        #     # Send bus notification to close popup (like campaign does)
        #     popup_id = popup.id if popup else (
        #         self.env['whatsapp.qr.popup'].search([
        #             ('original_test_wizard_id', '=', self.id)
        #         ], order='create_date desc', limit=1).id or 0
        #     )
            
        #     message = _("Test message sent to %s") % self.phone_to
        #     notif_type = "success"
            
        #     payload = {
        #         'action': 'close',
        #         'popup_id': popup_id,
        #         'title': _('WhatsApp Test'),
        #         'message': message,
        #         'type': notif_type,
        #         'sticky': False,
        #         'success': True
        #     }
            
        #     dbname = self._cr.dbname
        #     popup_channel = f"{dbname}_qr_popup_{popup_id}"
        #     self.env['bus.bus']._sendone(
        #         popup_channel,
        #         'qr_popup_close',
        #         payload
        #     )
            
        #     current_user = self.env.user
        #     if current_user and current_user.partner_id:
        #         self.env['bus.bus']._sendone(
        #             current_user.partner_id,
        #             'qr_popup_close',
        #             payload
        #         )
            
        #     # Return notification action
        #     return {
        #         'type': 'ir.actions.client',
        #         'tag': 'display_notification',
        #         'params': {
        #             'title': _('Test Sent'),
        #             'message': message,
        #             'type': 'success',
        #         }
        #     }
        # else:
        #     raise UserError(_("Failed to send test message: %s") % result.get('error', 'Unknown error'))
