# -*- coding: utf-8 -*-

import time
import json
import re
import base64
import io
import logging
from datetime import timedelta
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import html2text
_logger = logging.getLogger(__name__)

class WhatsappCompose(models.TransientModel):
    _name = 'whatsapp.chat.simple.wizard'
    _description = 'WhatsApp Chat Message Composition Wizard'
    _log_access = True

    subject = fields.Char('Subject')
    body = fields.Html('Message Content')
    template_id = fields.Many2one(
        'whatsapp.template', 'Use template',
        domain="[('model', '=', model), '|', ('user_id','=', False), ('user_id', '=', uid)]"
    )
    attachment_ids = fields.Many2many(
        'ir.attachment', 'whatsapp_chat_compose_ir_attachments_rel',
        'wizard_id', 'attachment_id', string='Attachments',
        compute='_compute_attachment_ids', readonly=False, store=True)
    partner_ids = fields.Many2many(
        'res.partner', 'whatsapp_chat_compose_res_partner_rel',
        'wizard_id', 'partner_id', string='Recipients')
    from_number = fields.Many2one(
        'whatsapp.connection', 
        string='From Number', 
        domain=lambda self: self._wizard_authorized_connection_domain(),
        help="Select the WhatsApp connection to send messages from")
    
    @api.model
    def _wizard_authorized_connection_domain(self):
        """Domain for wizard field: admins see all; users see only authorized connections."""
        user = self.env.user
        if user.has_group('whatsapp_chat_module.group_whatsapp_admin'):
            return []
        return [('authorized_person_ids', 'in', [user.id])]
    qr_code_image = fields.Binary('QR Code', readonly=True)
    qr_code_filename = fields.Char('QR Code Filename', readonly=True)
    qr_popup_id = fields.Many2one('whatsapp.qr.popup', string='QR Popup', readonly=True)
    qr_update_count = fields.Integer('QR Updates Received', default=0, readonly=True)
    
    # def do_something(self, data):
    #     """Handle RPC calls from frontend socket service"""
    #     if data.type == 'qr_expired':
    #         self.qr_popup_id = data.data.qr_popup_id
    #     elif data.type == 'phone_mismatch':
    #         self.phone_mismatch = data.data.phone_mismatch
    #     elif data.type == 'incoming_message':
    #         self.incoming_message = data.data.incoming_message
    #     elif data.type == 'outgoing_message':
    #         self.outgoing_message = data.data.outgoing_message
    #     elif data.type == 'pending_message_sent':
    #         self.pending_message_sent = data.data.pending_message_sent
    #     return {'message': 'Success!'}
    
    # UNUSED: Computed field for partner display names - not used anywhere
    # @api.depends('partner_ids')
    # def _compute_partner_display_names(self):
    #     """Compute display names with mobile numbers"""
    #     for wizard in self:
    #         if wizard.partner_ids:
    #             display_names = []
    #             for partner in wizard.partner_ids:
    #                 if partner.mobile:
    #                     display_names.append(f"{partner.name} ({partner.mobile})")
    #                 else:
    #                     display_names.append(partner.name)
    #             wizard.partner_display_names = ', '.join(display_names)
    #         else:
    #             wizard.partner_display_names = ''
    # partner_display_names = fields.Char(
    #     string='Recipients with Numbers',
    #     compute='_compute_partner_display_names',
    #     store=True
    # )
    
    template_name = fields.Char('Template Name', default='hello_world')
    language_code = fields.Char('Language Code', default='en')
    model = fields.Char('Related Document Model', compute='_compute_model', store=True)
    res_ids = fields.Text('Related Document IDs', compute='_compute_res_ids', store=True)

    @api.model
    def default_get(self, fields_list):
        # Set context for mobile display
        self = self.with_context(whatsapp_chat=True, force_mobile_display=True, show_mobile=True)
        result = super().default_get(fields_list)
        active_model = self.env.context.get('active_model')
        active_id = self.env.context.get('active_id')
        
        if active_model and active_id:
            record = self.env[active_model].browse(active_id)
            result['partner_ids'] = [(6, 0, [record.partner_id.id])]
            result['model'] = active_model
            
            # Set default from number (use default connection or first available)
            default_connection = self.env['whatsapp.connection'].get_default_connection()
            if default_connection:
                result['from_number'] = default_connection.id
            
            # Find default WhatsApp template
            # First, try to use model-specific method (like email templates do)
            default_template = None
            if hasattr(record, '_find_whatsapp_template'):
                try:
                    default_template = record._find_whatsapp_template()
                except Exception as e:
                    _logger.warning(f"Error calling _find_whatsapp_template on {active_model}: {str(e)}")
            
            # Fallback: search for first template if model method didn't return one
            if not default_template:
                default_template = self.env['whatsapp.template'].search([
                    ('model', '=', active_model)
                ], order='id', limit=1)
            
            if default_template:
                result['template_id'] = default_template.id
                
                # Load template content into body and subject
                try:
                    # For WhatsApp templates, render content directly
                    record = self.env[active_model].browse(active_id)
                    
                    if default_template.body_html:
                        rendered_body = default_template._render_template(
                            default_template.body_html, active_model, [record.id],
                            engine='qweb', options={'preserve_comments': True})
                        result['body'] = rendered_body[record.id]
                    
                    if default_template.subject:
                        rendered_subject = default_template._render_template(
                            default_template.subject, active_model, [record.id],
                            engine='inline_template', options={'preserve_comments': True})
                        result['subject'] = rendered_subject[record.id]
                        
                except Exception as e:
                    # Fallback to raw template content
                    result['body'] = default_template.body_html or ''
                    result['subject'] = default_template.subject or ''
                
                # Set template_id to trigger attachment loading
                result['template_id'] = default_template.id
        
        return result

    @api.depends('model')
    def _compute_model(self):
        for wizard in self:
            wizard.model = self.env.context.get('active_model', '')

    @api.depends('res_ids')
    def _compute_res_ids(self):
        for wizard in self:
            wizard.res_ids = str(self.env.context.get('active_id', ''))

    @api.depends('template_id')
    def _compute_attachment_ids(self):
        for wizard in self:
            if wizard.template_id:
                active_model = wizard.model or wizard.env.context.get('active_model')
                active_id = wizard.env.context.get('active_id')
                
                if active_model and active_id:
                    try:
                        # For WhatsApp templates, generate attachments like WhatsApp templates
                        rendered_values = wizard._generate_template_for_composer(
                            [active_id], ('attachment_ids', 'attachments'))[active_id]
                        
                        attachment_ids = rendered_values.get('attachment_ids') or []
                        
                        # Create new attachments from rendered reports (like WhatsApp templates)
                        if rendered_values.get('attachments'):
                            new_attachments = wizard.env['ir.attachment'].create([
                                {'name': attach_fname,
                                 'datas': attach_datas,
                                 'res_model': 'whatsapp.chat.simple.wizard',
                                 'res_id': 0,
                                 'type': 'binary',
                                } for attach_fname, attach_datas in rendered_values.pop('attachments')
                            ])
                            attachment_ids += new_attachments.ids
                        
                        if attachment_ids:
                            wizard.attachment_ids = attachment_ids
                        else:
                            wizard.attachment_ids = False
                    except Exception as e:
                        # Fallback to direct attachments if rendering fails
                        wizard.attachment_ids = wizard.template_id.attachment_ids
                else:
                    # Fallback to direct attachments if no record context
                    wizard.attachment_ids = wizard.template_id.attachment_ids
            else:
                wizard.attachment_ids = False

    @api.onchange('template_id')
    def _onchange_template_id(self):
        """Load template content when template is selected"""
        # Set context for mobile display
        self = self.with_context(whatsapp_chat=True, force_mobile_display=True, show_mobile=True)
        if self.template_id:
            active_model = self.model or self.env.context.get('active_model')
            active_id = self.env.context.get('active_id')
            
            if active_model and active_id:
                record = self.env[active_model].browse(active_id)
                
                # Render template with current record context
                rendered_values = self._generate_template_for_composer(
                    [active_id], ('body', 'subject'))[active_id]
                
                # Update body and subject fields
                if rendered_values.get('body'):
                    self.body = rendered_values['body']
                if rendered_values.get('subject'):
                    self.subject = rendered_values['subject']
            else:
                # Fallback if no record context - load raw template content
                self.body = self.template_id.body_html or ''
                self.subject = self.template_id.subject or ''
        else:
            # Clear fields if no template selected
            self.body = ''
            self.subject = ''
        
        # Force attachment computation when template changes
        self._compute_attachment_ids()
        
        # Also trigger a manual refresh of the view
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'whatsapp.chat.simple.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
            'context': self.env.context,
        }

    def _generate_template_for_composer(self, res_ids, render_fields, find_or_create_partners=True):
        self.ensure_one()
        
        # Handle WhatsApp templates
        mapping = {
            'attachments': 'report_template_ids',
            'body': 'body_html',
            'partner_ids': 'partner_to',
        }
        template_fields = {mapping.get(fname, fname) for fname in render_fields}
        
        # For WhatsApp templates, render content directly
        template_values = {}
        for res_id in res_ids:
            record = self.env[self.model].browse(res_id)
            template_values[res_id] = {}
            
            # Render body content
            if 'body' in render_fields and self.template_id.body_html:
                try:
                    rendered_body = self.template_id._render_template(
                        self.template_id.body_html, self.model, [record.id],
                        engine='qweb', options={'preserve_comments': True})
                    template_values[res_id]['body'] = rendered_body[record.id]
                except Exception as e:
                    # Fallback to raw template content if rendering fails
                    template_values[res_id]['body'] = self.template_id.body_html
            
            # Render subject content
            if 'subject' in render_fields and self.template_id.subject:
                try:
                    rendered_subject = self.template_id._render_template(
                        self.template_id.subject, self.model, [record.id],
                        engine='inline_template', options={'preserve_comments': True})
                    template_values[res_id]['subject'] = rendered_subject[record.id]
                except Exception as e:
                    # Fallback to raw template content if rendering fails
                    template_values[res_id]['subject'] = self.template_id.subject
            
            # Handle attachments like WhatsApp templates
            if 'attachment_ids' in render_fields:
                template_values[res_id]['attachment_ids'] = self.template_id.attachment_ids.ids
            
            # Generate dynamic reports (like WhatsApp templates)
            if 'attachments' in render_fields and self.template_id.report_template_ids:
                try:
                    attachments = []
                    for report in self.template_id.report_template_ids:
                        # Generate content
                        if report.report_type in ['qweb-html', 'qweb-pdf']:
                            report_content, report_format = self.env['ir.actions.report']._render_qweb_pdf(report, [res_id])
                        else:
                            render_res = self.env['ir.actions.report']._render(report, [res_id])
                            if not render_res:
                                continue
                            report_content, report_format = render_res
                        
                        report_content = base64.b64encode(report_content)
                        
                        # Generate name
                        if report.print_report_name:
                            try:
                                from odoo.tools.safe_eval import safe_eval
                                report_name = safe_eval(
                                    report.print_report_name,
                                    {
                                        'object': record,
                                        'time': safe_eval.wrap_module(time),
                                    }
                                )
                            except Exception as e:
                                # Fallback to record name if available
                                if hasattr(record, 'name') and record.name:
                                    report_name = f"{record.name}.{report_format}"
                                else:
                                    report_name = f"{report.name}.{report_format}"
                        else:
                            # Use record name if available, otherwise report name
                            if hasattr(record, 'name') and record.name:
                                report_name = f"{record.name}.{report_format}"
                            else:
                                report_name = f"{report.name}.{report_format}"
                        
                        extension = "." + report_format
                        if not report_name.endswith(extension):
                            report_name += extension
                        
                        attachments.append((report_name, report_content))
                    
                    if attachments:
                        template_values[res_id]['attachments'] = attachments
                except Exception as e:
                    # Fallback if report generation fails
                    pass
        
        return template_values

    # @api.model
    # def open_qr_popup_from_socket(self, popup_id):
    #     """Open QR popup from socket event using direct Odoo action"""
    #     try:
    #         # Return the same action structure that works in action_send_whatsapp
    #         return {
    #             'type': 'ir.actions.act_window',
    #             'name': 'WhatsApp Authentication Required',
    #             'res_model': 'whatsapp.qr.popup',
    #             'res_id': popup_id,
    #             'view_mode': 'form',
    #             'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
    #             'target': 'new',
    #             'context': {
    #                 'active_model': self.env.context.get('active_model'),
    #                 'active_id': self.env.context.get('active_id'),
    #                 'active_ids': self.env.context.get('active_ids'),
    #             }
    #         }
    #     except Exception as e:
    #         _logger.error(f" [Compose Wizard] Error opening QR popup from socket: {e}")
    #         return {
    #             'type': 'ir.actions.client',
    #             'tag': 'display_notification',
    #             'params': {
    #                 'title': _('Error'),
    #                 'message': _('Failed to open QR popup: %s') % str(e),
    #                 'type': 'danger',
    #                 'sticky': True,
    #             }
    #         }

    # UNUSED: Empty callback method - not implemented or called anywhere
    # def whatsapp_service_callback(self, data):
    #     """Callback function for WhatsApp service"""
    #     pass

    def action_send_whatsapp(self):
        """Send WhatsApp messages via Socket.IO real-time communication"""
        self.ensure_one()
        
        if not self.partner_ids:
            raise UserError(_("Please select at least one recipient."))
        
        if not self.body:
            raise UserError(_("Please enter a message content."))
        
        if not self.from_number:
            raise UserError(_("Please select a 'From' number to send WhatsApp messages."))
        
        # Check authorization for the selected connection
        if not self.from_number._check_authorization():
            raise UserError(_("You are not authorized to use this connection."))
        
        # Get origin from request (for socket matching)
        origin = '127.0.0.1'  # Default
        try:
            from odoo import http
            request = http.request
            if request and hasattr(request, 'httprequest'):
                origin = request.httprequest.headers.get('Origin') or \
                         request.httprequest.headers.get('Host') or \
                         origin
        except:
            pass
        
        # STEP 1: Ensure socket is connected with selected connection's credentials
        # Trigger socket connection (same as Connect button)
        self.from_number._trigger_socket_connection(origin)
        
        # Clear and wait for confirmation (shorter timeout than Connect button)
        connection_sudo = self.from_number.sudo()
        connection_sudo.socket_connection_ready = False
        connection_sudo.env.cr.commit()
        
        # Wait for socket connection (max 2 seconds - shorter than Connect button)
        max_wait = 2
        check_interval = 0.1
        waited = 0
        socket_confirmed = False
        
        while waited < max_wait:
            fresh_env = connection_sudo.env(cr=connection_sudo.env.cr)
            fresh_record = fresh_env['whatsapp.connection'].browse(connection_sudo.id)
            fresh_record.invalidate_recordset(['socket_connection_ready'])
            
            if fresh_record.socket_connection_ready:
                socket_confirmed = True
                break
            time.sleep(check_interval)
            waited += check_interval
        
        # STEP 2: Send messages (socket should be ready for QR events)
        result = self._send_messages_via_socket(origin)
        
        # Check if QR popup is needed
        if result.get('qr_popup_needed'):
            qr_popup_id = result.get('qr_popup_id')
            if qr_popup_id:
                return {
                    'type': 'ir.actions.act_window',
                    'name': 'WhatsApp Authentication Required',
                    'res_model': 'whatsapp.qr.popup',
                    'res_id': qr_popup_id,
                    'view_mode': 'form',
                    'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                    'target': 'new',
                    'context': {
                        'active_model': self.env.context.get('active_model'),
                        'active_id': self.env.context.get('active_id'),
                        'active_ids': self.env.context.get('active_ids'),
                    }
                }
        
        # Log messages in chatter ONLY if messages were actually sent successfully
        if result.get('success_count', 0) > 0:
            self._log_in_chatter([partner.name for partner in self.partner_ids], [])
        
        # Show appropriate notification based on results
        if result['success_count'] > 0 and result['error_count'] == 0:
            # All messages sent successfully - send bus message to show notification and close dialog
            dbname = self._cr.dbname
            current_user = self.env.user
            
            message = _("Successfully sent %d messages!") % result['success_count']
            
            payload = {
                'action': 'close_compose_wizard',
                'wizard_id': self.id,
                'title': _('WhatsApp Messages Sent Successfully'),
                'message': message,
                'type': 'success',
                'sticky': False,
                'success': True
            }
            
            # Send to user's partner channel (always subscribed)
            if current_user and current_user.partner_id:
                self.env['bus.bus']._sendone(
                    current_user.partner_id,
                    'whatsapp_compose_close',
                    payload
                )
            
            # Bus handles notification and closing
            return {}
        elif result['success_count'] > 0 and result['error_count'] > 0:
            # Some messages sent, some failed
            notification = {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('WhatsApp Messages Partially Sent'),
                    'message': f"Sent to {result['success_count']} recipient(s). {result['error_count']} failed: {'; '.join(result['error_messages'])}",
                    'type': 'warning',
                    'sticky': True,
                }
            }
        else:
            # All messages failed
            # _logger.error(f"Failed to send messages. Errors: {'; '.join(result['error_messages'])}")
            notification = {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': _('WhatsApp Messages Failed'),
                    'message': f"Failed to send messages.",
                    'type': 'danger',
                    'sticky': True,
                }
            }
        return notification


    def _send_messages_via_socket(self, origin='127.0.0.1'):
        """Send messages via WhatsApp API to backend"""
        try:
            import requests
            
            success_count = 0
            error_messages = []
            
            for partner in self.partner_ids:
                if not partner.mobile:
                    error_messages.append(f"{partner.name}: No mobile number")
                    continue
                    
                try:
                    # Convert HTML to plain text for WhatsApp
                    plain_text = html2text.html2text(self.body) if self.body else ""
                    
                    # Determine attachments and message type
                    has_attachments = bool(self.attachment_ids)
                    message_type = 'document' if has_attachments else 'chat'

                    # Prepare headers (origin is passed as parameter from action_send_whatsapp)
                    headers = {
                        'x-api-key': self.from_number.api_key,
                        'x-phone-number': self.from_number.from_field,
                        'origin': origin,  # Use dynamic origin to match socket connection
                    }
                    
                    # Send to WhatsApp API
                    api_url = "http://localhost:3000/api/whatsapp/send"
                    # Normalize recipient phone: keep one space after country code, remove others
                    
                    raw_phone = (partner.mobile or '')
                    compact = re.sub(r'\s+', ' ', raw_phone).strip()
                    m = re.match(r'^(\+\d{1,3})\s*(.*)$', compact)
                    if m:
                        cc = m.group(1)
                        rest = re.sub(r'\s+', '', m.group(2))
                        normalized_to = f"{cc} {rest}" if rest else cc
                    else:
                        normalized_to = re.sub(r'\s+', '', raw_phone)
                    

                    if has_attachments:
                        # Build multipart form with files
                        files = []
                        for attachment in self.attachment_ids:
                            file_data = b''
                            try:
                                # Decode attachment.datas (base64 in database)
                                b64_value = attachment.sudo().datas or ''                                
                                if b64_value:
                                    # Handle string/bytes conversion
                                    if isinstance(b64_value, bytes):
                                        b64_value = b64_value.decode('utf-8', errors='ignore')                                    
                                    # Remove data URI prefix if present
                                    if isinstance(b64_value, str) and b64_value.startswith('data:'):
                                        b64_value = b64_value.split(',', 1)[1] if ',' in b64_value else b64_value
                                    
                                    # Fix base64 padding
                                    if isinstance(b64_value, str):
                                        pad = len(b64_value) % 4
                                        if pad:
                                            b64_value = b64_value + ('=' * (4 - pad))
                                        
                                        file_data = base64.b64decode(b64_value)
                                        
                            except Exception as e:
                                _logger.error(f"Error decoding attachment {attachment.id}: {e}")
                                continue
                            
                            # Sanitize filename: replace path separators with underscores
                            # Example: ASPL/2526/09/15039.pdf -> ASPL_2526_09_15039.pdf
                            raw_name = (attachment.name or 'attachment')
                            filename = raw_name.replace('/', '_').replace('\\', '_')
                            mimetype = getattr(attachment, 'mimetype', None) or 'application/octet-stream'
                            
                            # Force PDF mimetype if filename ends with .pdf
                            if filename.lower().endswith('.pdf'):
                                mimetype = 'application/pdf'

                            # Add file if we have actual data
                            if file_data and len(file_data) > 0:
                                files.append((
                                    'files',
                                    (filename, io.BytesIO(file_data), mimetype)
                                ))
                            

                        form_data = {
                            'to': normalized_to,
                            'messageType': message_type,
                            'body': plain_text,
                        }
                        
                        response = requests.post(
                            api_url,
                            data=form_data,
                            files=files,
                            headers=headers,
                            timeout=120
                        )
                    else:
                        # Simple JSON body for chat message
                        response = requests.post(
                            api_url,
                            json={
                                'to': normalized_to,
                                'messageType': message_type,
                                'body': plain_text,
                            },
                            headers=headers,
                            timeout=120
                        )
                    
                    
                    # Accept both 200 and 201 as success (201 = QR code required)
                    if response.status_code in [200, 201]:
                        # MAIN PATH ONLY: strictly parse JSON; treat invalid JSON as error
                        try:
                            response_data = response.json()
                        except Exception as json_error:
                            error_msg = f"{partner.name}: Invalid JSON from API - {json_error}"
                            error_messages.append(error_msg)
                            _logger.error(f"Invalid JSON response from API for {partner.name}: {json_error}")
                            continue

                        # If API signals a QR is required (201 status or qrCode in response), open popup and return immediately
                        # Check for QR code in response data (could be at top level or nested in 'data')
                        qr_code_in_response = response_data.get('qrCode') or (
                            response_data.get('data', {}).get('qrCode') if response_data.get('data') else None
                        )
                        
                        if qr_code_in_response:
                            qr_code_base64 = qr_code_in_response
                            
                            # Store context for later chatter logging
                            active_model = self.model or self.env.context.get('active_model')
                            active_id = self.env.context.get('active_id')
                            
                            qr_popup = self.env['whatsapp.qr.popup'].create({
                                'qr_code_image': qr_code_base64,
                                'qr_code_filename': 'whatsapp_qr_code.png',
                                'from_number': self.from_number.from_field,
                                'from_name': self.from_number.name,
                                'original_wizard_id': self.id,
                                'message': response_data.get('message', 'Please scan QR code to connect WhatsApp'),
                                'api_key': self.from_number.api_key,
                                'phone_number': self.from_number.from_field,
                                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),  # 2 minutes
                                'countdown_seconds': 120,
                                'is_expired': False,
                                'retry_count': 0,
                                'last_qr_string': qr_code_base64[:100] if qr_code_base64 else '',
                                # Store context for chatter logging
                                'original_context': json.dumps(self.env.context),
                                'active_model': active_model or '',
                                'active_id': active_id or 0,
                            })
                            self.qr_popup_id = qr_popup.id
                            self.write({'qr_popup_id': qr_popup.id})
                            
                            # Return early when QR is needed. After QR authentication,
                            # action_close_qr_popup() will call _send_messages_via_socket() again,
                            # processing ALL recipients from the beginning.
                            return {
                                'qr_popup_needed': True,
                                'qr_popup_id': qr_popup.id,
                                'success_count': 0,
                                'error_count': 0,
                                'error_messages': [],
                            }

                        
                        # No QR required: check success flag
                        if response_data.get('success', False):
                            success_count += 1
                        else:
                            # Extract error message from response
                            error_detail = response_data.get('error', response_data.get('message', 'Unknown error'))
                            if isinstance(error_detail, dict):
                                error_detail = error_detail.get('message', str(error_detail))
                            
                            error_msg = f"{partner.name}: {error_detail}"
                            error_messages.append(error_msg)
                            _logger.error(f"API returned success=false for {partner.name}: {error_detail}")
                    else:
                        # Try to extract error message from response
                        error_detail = "Unknown error"
                        try:
                            error_response = response.json()
                            error_detail = error_response.get('error', error_response.get('message', error_response.get('data', {}).get('message', 'Unknown error')))
                            if isinstance(error_detail, dict):
                                error_detail = error_detail.get('message', str(error_detail))
                        except:
                            # If response is not JSON, use the text
                            error_detail = response.text[:200] if response.text else "Unknown error"
                        
                        error_msg = f"{partner.name}: {error_detail}"
                        error_messages.append(error_msg)
                        _logger.error(f"Failed to send to {partner.name}: HTTP {response.status_code} - {error_detail}")
                        
                except Exception as e:
                    error_msg = f"{partner.name}: {str(e)}"
                    error_messages.append(error_msg)
                    _logger.exception(f"Error sending WhatsApp message to {partner.name}: {e}")
            
            # Log results
            if success_count > 0:
                _logger.info(f"Successfully sent {success_count} message(s) via WhatsApp API")
            
            if error_messages:
                _logger.warning(f"{len(error_messages)} message(s) failed: {', '.join(error_messages[:3])}{'...' if len(error_messages) > 3 else ''}")
            
            # Return results
            return {
                'success_count': success_count,
                'error_count': len(error_messages),
                'error_messages': error_messages
            }
                
        except Exception as e:
            _logger.exception(f"Error in WhatsApp API integration: {e}")
            raise UserError(_("Failed to send messages via WhatsApp API: %s") % str(e))
    
    def action_close_qr_popup(self, popup=False):
        self.ensure_one()

        result = self._send_messages_via_socket()

        # Log in chatter
        if result.get('success_count', 0) > 0:
            qr_popup = popup or self.env['whatsapp.qr.popup'].search([
                ('original_wizard_id', '=', self.id)
            ], order='create_date desc', limit=1)

            if qr_popup and qr_popup.original_context:
                try:
                    ctx = json.loads(qr_popup.original_context)
                    ctx.update({
                        'active_model': qr_popup.active_model,
                        'active_id': qr_popup.active_id,
                    })
                    self.with_context(**ctx)._log_in_chatter(
                        [p.name for p in self.partner_ids], []
                    )
                except Exception as e:
                    self._log_in_chatter([p.name for p in self.partner_ids], [])
            else:
                self._log_in_chatter([p.name for p in self.partner_ids], [])

        # Build message
        if result['success_count'] > 0:
            message = result['error_count'] > 0 \
                and _("%d sent, %d failed: %s") % (result['success_count'], result['error_count'], ', '.join(result['error_messages'])) \
                or _("Successfully sent %d messages!") % result['success_count']
            notif_type = "warning" if result['error_count'] > 0 else "success"
        else:
            message = _("Failed: %s") % ', '.join(result['error_messages'])
            notif_type = "danger"

        popup_id = popup.id if popup else (
            self.env['whatsapp.qr.popup'].search([
                ('original_wizard_id', '=', self.id)
            ], limit=1).id or 0
        )

        # Odoo 17+ requires string channels, not tuples
        payload = {
            'action': 'close',
            'popup_id': popup_id,
            'title': _('WhatsApp'),
            'message': message,
            'type': notif_type,
            'sticky': False,
            'success': result['success_count'] > 0
        }
        
        dbname = self._cr.dbname
        
        # Send to specific popup channel (string format for Odoo 17+)
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
        else:
            _logger.warning(f"No partner_id found for user {current_user.login if current_user else 'Unknown'}")
        return {}


    def _log_in_chatter(self, success_messages, error_messages):
        """Log WhatsApp messages in document chatter without sending emails"""
        active_model = self.model or self.env.context.get('active_model')
        active_id = self.env.context.get('active_id')
        
        if active_model and active_id:
            record = self.env[active_model].browse(active_id)
            
            # Prepare message content for chatter
            message_content = self.body if self.body else 'No message content'
            
            # Create dynamic subject
            if record and hasattr(record, 'name'):
                record_name = record.name if hasattr(record, 'name') else ''
                if record._name == 'sale.order':
                    email_subject = f"Sales Order - {record_name}"
                elif record._name == 'purchase.order':
                    email_subject = f"Purchase Order - {record_name}"
                elif record._name == 'account.move':
                    email_subject = f"Invoice - {record_name}"
                else:
                    email_subject = f"Message - {record_name}"
            else:
                email_subject = "WhatsApp Message"
            
            # Prepare attachment information for logging
            attachment_ids_for_log = []
            if self.attachment_ids:
                for attachment in self.attachment_ids:
                    # Use custom filename for chatter logging
                    custom_filename = attachment.name.replace('/', '_')
                    # Copy attachment to be linked with the log message
                    log_attachment = attachment.copy({
                        'res_model': active_model,
                        'res_id': active_id,
                        'name': f"WhatsApp Chat - {custom_filename}"
                    })
                    attachment_ids_for_log.append(log_attachment.id)
            
            # Convert HTML to plain text for safe chatter logging
            safe_body = html2text.html2text(message_content)

            record.message_post(
                body=safe_body,
                subject=email_subject,
                attachment_ids=attachment_ids_for_log,
                message_type='comment',
                subtype_xmlid='whatsapp_chat_module.mail_subtype_whatsapp_message',
            )