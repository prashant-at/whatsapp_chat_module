# -*- coding: utf-8 -*-

from odoo import models, fields, api
import logging
import base64
import json
from datetime import datetime

_logger = logging.getLogger(__name__)


class WhatsAppMessage(models.Model):
    _name = 'whatsapp.message'
    _description = 'WhatsApp Message'
    _order = 'create_date desc'

    # Basic fields
    message_id = fields.Char('Message ID', required=True, help='External message ID from WhatsApp API')
    contact_id = fields.Many2one('whatsapp.contact', string='Contact', required=True)
    conversation_id = fields.Many2one('whatsapp.conversation', string='Conversation', required=True)
    
    # Message content
    message_type = fields.Selection([
        ('text', 'Text'),
        ('image', 'Image'),
        ('video', 'Video'),
        ('audio', 'Audio'),
        ('document', 'Document'),
        ('location', 'Location'),
        ('contact', 'Contact'),
        ('sticker', 'Sticker'),
    ], string='Message Type', default='text', required=True)
    
    content = fields.Text('Message Content', required=True)
    media_url = fields.Char('Media URL', help='URL for media attachments')
    media_filename = fields.Char('Media Filename')
    media_data = fields.Text('Media Data Base64', help='Base64 encoded media content')
    
    # Message direction and status
    direction = fields.Selection([
        ('inbound', 'Received'),
        ('outbound', 'Sent'),
    ], string='Direction', required=True)
    
    status = fields.Selection([
        ('pending', 'Pending'),
        ('sent', 'Sent'),
        ('delivered', 'Delivered'),
        ('read', 'Read'),
        ('failed', 'Failed'),
    ], string='Status', default='pending')
    
    # Timestamps
    msg_timestamp = fields.Datetime('Message Timestamp', required=True, default=fields.Datetime.now)
    delivered_time = fields.Datetime('Delivered Time')
    read_time = fields.Datetime('Read Time')
    
    # Conversation context
    quoted_message_id = fields.Char('Quoted Message ID', help='ID of message being replied to')
    reply_content = fields.Text('Reply Content', help='Preview of quoted message')
    context_object_id = fields.Char('Context Object ID', help='Reference to related Odoo record')
    
    # Odoo integration
    related_object = fields.Reference(
        selection='_get_related_models',
        string='Related Object',
        help='Related Odoo record this message is associated with'
    )
    
    # Additional fields
    caption = fields.Char('Caption', help='Caption for media messages')
    file_size = fields.Float('File Size (KB)', help='File size in kilobytes')
    mime_type = fields.Char('%MIME Type', help='MIME type of media files')
    
    @api.model
    def _get_related_models(self):
        """Get available models for reference field"""
        return [
            ('sale.order', 'Sale Order'),
            ('purchase.order', 'Purchase Order'),
            ('stock.picking', 'Stock Picking'),
            ('account.move', 'Invoice'),
            ('crm.lead', 'Lead'),
            ('project.project', 'Project'),
            ('project.task', 'Task'),
        ]

    @api.depends('contact_id', 'content', 'direction')
    def _compute_display_name(self):
        for record in self:
            direction_text = "→" if record.direction == 'outbound' else "←"
            record.display_name = f"{direction_text} {record.contact_id.name or 'Unknown'}: {record.content[:50]}..."

    display_name = fields.Char('Display Name', compute='_compute_display_name', store=True)

    @api.model
    def create_message(self, contact_id, content, message_type='text', direction='outbound', 
                      media_data=None, quoted_message_id=None, **kwargs):
        """Create message with proper conversation association"""
        contact = self.env['whatsapp.contact'].browse(contact_id)
        if not contact:
            return False
            
        # Get or create conversation
        conversation = self.env['whatsapp.conversation'].get_or_create_conversation(
            contact_id=contact_id
        )
        
        # Generate message ID
        message_id = f"msg_{self.env.user.id}_{int(datetime.now().timestamp() * 1000)}"
        
        # Prepare media data
        media_fields = {}
        if media_data and message_type != 'text':
            if isinstance(media_data, dict):
                media_fields = {
                    'media_url': media_data.get('url'),
                    'media_filename': media_data.get('filename'),
                    'media_data': media_data.get('data'),
                    'caption': media_data.get('caption'),
                    'file_size': media_data.get('file_size'),
                    'mime_type': media_data.get('mime_type'),
                }
        
        message_vals = {
            'message_id': message_id,
            'contact_id': contact_id,
            'conversation_id': conversation.id,
            'message_type': message_type,
            'content': content,
            'direction': direction,
            'status': 'sent' if direction == 'outbound' else 'delivered',
            'quoted_message_id': quoted_message_id,
            **media_fields,
            **kwargs
        }
        
        message = self.create(message_vals)
        
        # Update conversation's last message
        conversation.write({'last_message_id': message.id})
        
        # Update contact's unread count if inbound
        if direction == 'inbound':
            contact.write({'unread_count': contact.unread_count + 1})
        
        return message

    def send_message_data(self):
        """Prepare message data for sending via API"""
        data = {
            'message_id': self.message_id,
            'to': self.contact_id.phone_number,
            'message_type': self.message_type,
            'content': self.content,
        }
        
        if self.media_data or self.media_url:
            data['media'] = {
                'data': self.media_data,
                'url': self.media_url,
                'filename': self.media_filename,
                'caption': self.caption,
                'mime_type': self.mime_type,
            }
            
        if self.quoted_message_id:
            data['quote'] = {'message_id': self.quoted_message_id}
            
        return data

    def action_mark_as_read(self):
        """Mark message as read"""
        if self.direction == 'outbound' and not self.read_time:
            self.write({
                'status': 'read',
                'read_time': fields.Datetime.now()
            })

    def get_message_for_chat_ui(self):
        """Get message data formatted for chat UI"""
        return {
            'id': self.id,
            'message_id': self.message_id,
            'type': self.message_type,
            'content': self.content,
            'direction': self.direction,
            'status': self.status,
            'timestamp': self.msg_timestamp.isoformat(),
            'media_url': self.media_url,
            'media_filename': self.media_filename,
            'media_data': self.media_data,
            'caption': self.caption,
            'quoted_message_id': self.quoted_message_id,
            'contact_id': self.contact_id.id,
            'contact_name': self.contact_id.name,
        }

    @api.model
    def webhook_receive_message(self, webhook_data):
        """Process incoming webhook messages"""
        try:
            # Extract webhook data
            from_number = webhook_data.get('from')
            message_data = webhook_data.get('message', {})
            
            if not from_number or not message_data:
                return False
                
            # Find or create contact
            contact = self.env['whatsapp.contact'].search([
                ('phone_number', '=', from_number.replace('+', '').replace('-', '').replace(' ', ''))
            ], limit=1)
            
            if not contact:
                # Create contact from phone number
                contact = self.env['whatsapp.contact'].create({
                    'name': f"Contact +{from_number}",
                    'phone_number': from_number.replace('+', ''),
                    'is_whatsapp_user': True,
                })
            
            # Process message based on type
            message_type = message_data.get('type', 'text')
            content = message_data.get('text', {}).get('body', '')
            
            # Handle different message types
            media_fields = {}
            if message_type == 'image':
                media_fields = {
                    'media_url': message_data.get('image', {}).get('link'),
                    'caption': message_data.get('image', {}).get('caption'),
                    'media_filename': message_data.get('image', {}).get('filename'),
                }
            elif message_type in ['document', 'audio', 'video']:
                media_info = message_data.get(message_type, {})
                media_fields = {
                    'media_url': media_info.get('link'),
                    'caption': media_info.get('caption'),
                    'media_filename': media_info.get('filename'),
                    'mime_type': media_info.get('mime_type'),
                    'file_size': media_info.get('file_size'),
                }
            
            # Create message
            message = self.create_message(
                contact_id=contact.id,
                content=content,
                message_type=message_type,
                direction='inbound',
                quoted_message_id=message_data.get('quoted_message', {}).get('id'),
                **media_fields
            )
            
            # Log webhook data for debugging
            _logger.info(f"Received webhook message: {message_data}")
            
            return message
            
        except Exception as e:
            _logger.error(f"Error processing webhook message: {str(e)}")
            return False

    def action_resend_message(self):
        """Resend failed message"""
        if self.status == 'failed':
            # Update status to pending
            self.write({'status': 'pending'})
            # Trigger resend logic here
            return True
        return False
