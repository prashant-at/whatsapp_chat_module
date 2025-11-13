# -*- coding: utf-8 -*-

from odoo import models, fields, api, http
import logging
import requests
import json
import base64
from datetime import datetime, timedelta

_logger = logging.getLogger(__name__)


class WhatsAppAPIService(models.Model):
    _name = 'whatsapp.api.service'
    _description = 'WhatsApp API Service'
    _inherit = ['mail.thread']

    name = fields.Char('Service Name', required=True)
    api_token = fields.Char('API Token', required=True)
    api_base_url = fields.Char('API Base URL', required=True, default='https://graph.facebook.com/v17.0')
    phone_number_id = fields.Char('Phone Number ID', required=True)
    business_account_id = fields.Char('Business Account ID', required=True)
    
    # Status tracking
    is_active = fields.Boolean('Active', default=True)
    is_authenticated = fields.Boolean('Authenticated', default=False)
    last_status_check = fields.Datetime('Last Status Check')
    status_message = fields.Text('Status Message')
    
    # QR Code for authentication
    qr_code_data = fields.Text('QR Code Data')
    qr_expires_at = fields.Datetime('QR Expires At')
    
    # Webhook settings
    webhook_url = fields.Char('Webhook URL')
    webhook_verify_token = fields.Char('Webhook Verify Token')
    webhook_endpoint = fields.Char('Webhook Endpoint', default='/web/whatsapp/webhook')
    
    def authenticate_with_qr(self):
        """Generate QR code for WhatsApp authentication"""
        try:
            url = f"{self.api_base_url}/{self.phone_number_id}"
            
            # For demo purposes, we'll generate a dummy QR
            qr_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
            
            self.write({
                'qr_code_data': qr_data,
                'qr_expires_at': fields.Datetime.now() + timedelta(minutes=5),
                'status_message': "QR code generated successfully",
            })
            
            return {
                'success': True,
                'qr_code': qr_data,
                'expires_at': self.qr_expires_at.isoformat(),
            }
            
        except Exception as e:
            _logger.error(f"Error generating QR code: {str(e)}")
            return {'success': False, 'error': str(e)}

    def check_connection_status(self):
        """Check WhatsApp Business API connection status"""
        try:
            url = f"{self.api_base_url}/{self.phone_number_id}"
            headers = {
                'Authorization': f'Bearer {self.api_token}',
            }
            
            response = requests.get(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                self.write({
                    'is_authenticated': True,
                    'last_status_check': fields.Datetime.now(),
                    'status_message': "Successfully connected to WhatsApp Business API",
                })
                return {'success': True, 'status': 'connected'}
            else:
                self.write({
                    'is_authenticated': False,
                    'status_message': f"Connection failed: {response.status_code}",
                })
                return {'success': False, 'status': 'disconnected', 'error': response.text}
                
        except Exception as e:
            _logger.error(f"Error checking connection status: {str(e)}")
            self.write({
                'is_authenticated': False,
                'status_message': f"Connection error: {str(e)}",
            })
            return {'success': False, 'status': 'error', 'error': str(e)}

    def send_message(self, to_phone, message_content, message_type='text', media_data=None):
        """Send message via WhatsApp Business API"""
        
        if not self.is_active:
            return {'success': False, 'error': 'Service not active'}
            
        try:
            url = f"{self.api_base_url}/{self.phone_number_id}/messages"
            
            headers = {
                'Authorization': f'Bearer {self.api_token}',
                'Content-Type': 'application/json',
            }
            
            # Prepare message payload
            payload = self._prepare_message_payload(to_phone, message_content, message_type, media_data)
            
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            
            if response.status_code == 200:
                response_data = response.json()
                
                # Log successful message send
                self._log_message_sent(to_phone, message_content, response_data)
                
                return {
                    'success': True,
                    'message_id': response_data.get('messages', [{}])[0].get('id'),
                    'response': response_data,
                }
            else:
                error_data = response.json() if response.json else {}
                return {
                    'success': False,
                    'error': f"API Error {response.status_code}: {error_data.get('error', {}).get('message', 'Unknown error')}",
                }
                
        except Exception as e:
            _logger.error(f"Error sending WhatsApp message: {str(e)}")
            return {'success': False, 'error': str(e)}

    def _prepare_message_payload(self, to_phone, message_content, message_type='text', media_data=None):
        """Prepare message payload for WhatsApp API"""
        
        payload = {
            'messaging_product': 'whatsapp',
            'to': to_phone,
            'type': message_type,
        }
        
        if message_type == 'text':
            payload['text'] = {
                'body': message_content
            }
        elif message_type == 'image' and media_data:
            payload['image'] = {
                'link': media_data.get('url'),
                'caption': media_data.get('caption', message_content),
            }
        elif message_type == 'template':
            payload['template'] = {
                'name': media_data.get('template_name'),
                'language': {'code': media_data.get('language_code', 'en_US')},
                'components': [{
                    'type': 'body',
                    'parameters': media_data.get('parameters', [])
                }]
            }
        
        return payload

    def _log_message_sent(self, to_phone, message_content, response_data):
        """Log sent message to request/response tracking"""
        try:
            log_record = self.env['whatsapp.request.response'].create({
                'request_url': 'messages/send',
                'request_method': 'POST',
                'request_data': json.dumps({
                    'to': to_phone,
                    'message': message_content,
                }),
                'response_status': '200',
                'response_data': json.dumps(response_data),
                'success': True,
                'timestamp': fields.Datetime.now(),
            })
            
            # Create message tracking in our message model
            contact = self.env['whatsapp.contact'].search([('phone_number', '=', to_phone)], limit=1)
            if contact:
                self.env['whatsapp.message'].create_message(
                    contact_id=contact.id,
                    content=message_content,
                    message_type='text',
                    direction='outbound',
                    status='sent'
                )
                
        except Exception as e:
            _logger.error(f"Error logging sent message: {str(e)}")

    def upload_media(self, media_file_data, media_type='image'):
        """Upload media file to WhatsApp Business API"""
        
        try:
            url_temp = f"{self.api_base_url}/{self.business_account_id}/media"
            
            headers = {
                'Authorization': f'Bearer {self.api_token}',
            }
            
            files = {
                'file': media_file_data,
                'type': media_type
            }
            
            response = requests.post(url_temp, headers=headers, files=files, timeout=30)
            
            if response.status_code == 200:
                response_data = response.json()
                return {
                    'success': True,
                    'media_id': response_data.get('id'),
                    'response': response_data,
                }
            else:
                return {
                    'success': False,
                    'error': f"Media upload failed: {response.status_code}",
                }
                
        except Exception as e:
            _logger.error(f"Error uploading media: {str(e)}")
            return {'success': False, 'error': str(e)}

    def get_message_template(self, template_name):
        """Get message template from WhatsApp Business API"""
        
        try:
            url = f"{self.api_base_url}/{self.business_account_id}/message_templates"
            
            headers = {
                'Authorization': f'Bearer {self.api_token}',
            }
            
            response = requests.get(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                templates = response.json().get('data', [])
                template = next((t for t in templates if t.get('name') == template_name), None)
                
                return {'success': True, 'template': template}
            else:
                return {'success': False, 'error': f"Template fetch failed: {response.status_code}"}
                
        except Exception as e:
            _logger.error(f"Error getting message template: {str(e)}")
            return {'success': False, 'error': str(e)}

    def webhook_verify(self, verify_token, challenge):
        """Verify webhook setup with WhatsApp"""
        
        if self.webhook_verify_token == verify_token:
            return challenge
        else:
            return False

    def process_webhook(self, webhook_data):
        """Process incoming webhook from WhatsApp"""
        
        try:
            entries = webhook_data.get('entry', [])
            
            for entry in entries:
                changes = entry.get('changes', [])
                
                for change in changes:
                    value = change.get('value', {})
                    
                    if 'messages' in value:
                        messages = value.get('messages', [])
                        
                        for message_data in messages:
                            self._process_incoming_message(message_data, value.get('contacts', [{}])[0])
                            
                            # Update message status
                            if 'statuses' in value:
                                statuses = value.get('statuses', [])
                                for status_data in statuses:
                                    self._process_message_status(status_data)
            
            return {'success': True}
            
        except Exception as e:
            _logger.error(f"Error processing webhook: {str(e)}")
            return {'success': False, 'error': str(e)}

    def _process_incoming_message(self, message_data, contact_data):
        """Process incoming message from webhook"""
        
        try:
            from_number = contact_data.get('wa_id')
            message_type = message_data.get('type')
            
            # Find or create contact
            contact = self.env['whatsapp.contact'].search([('phone_number', '=', from_number)], limit=1)
            
            if not contact:
                contact = self.env['whatsapp.contact'].create({
                    'name': contact_data.get('profile', {}).get('name', f"Contact {from_number}"),
                    'phone_number': from_number,
                    'is_whatsapp_user': True,
                })
            
            # Create conversation if needed
            conversation = self.env['whatsapp.conversation'].get_or_create_conversation(contact.id)
            
            # Process different message types
            content = ""
            if message_type == 'text':
                content = message_data.get('text', {}).get('body', '')
            elif message_type in ['image', 'document', 'audio', 'video']:
                media_data = message_data.get(message_type, {})
                content = f"[{message_type.upper()}] {media_data.get('caption', '')}"
            
            # Create message record
            if content:
                message = self.env['whatsapp.message'].create_message(
                    contact_id=contact.id,
                    content=content,
                    message_type=message_type,
                    direction='inbound',
                    msg_timestamp=datetime.fromtimestamp(message_data.get('timestamp')),
                )
                
                self.message_post(
                    body=f"Received WhatsApp message from {contact.name}: {content}"
                )
            
        except Exception as e:
            _logger.error(f"Error processing incoming message: {str(e)}")

    def _process_message_status(self, status_data):
        """Process message status updates"""
        
        try:
            message_id = status_data.get('id')
            status = status_data.get('status')
            
            # Find message by external ID
            message = self.env['whatsapp.message'].search([('message_id', '=', message_id)], limit=1)
            
            if message:
                message.write({
                    'status': status,
                    'delivered_time': fields.Datetime.now() if status in ['delivered', 'read'] else message.delivered_time,
                    'read_time': fields.Datetime.now() if status == 'read' else message.read_time,
                })
                
        except Exception as e:
            _logger.error(f"Error processing message status: {str(e)}")

    @api.model
    def get_default_service(self):
        """Get default WhatsApp service"""
        service = self.search([('is_active', '=', True)], limit=1)
        return service
