# -*- coding: utf-8 -*-

from odoo import http, fields
from odoo.http import request
import requests
import json
import logging
from datetime import timedelta

_logger = logging.getLogger(__name__)


class WhatsAppController(http.Controller):
    
    # Base URL for your Node.js service
    NODE_SERVICE_URL = 'http://localhost:3000'  # Update this to your Node.js service URL
    
    @http.route('/whatsapp/chat', type='http', auth='user', website=True)
    def whatsapp_chat_ui(self):
        """Render the WhatsApp Web UI"""
        return request.render('whatsapp_chat_module.whatsapp_web_template')
    
    @http.route('/whatsapp/api/chats', type='json', auth='user')
    def get_chats(self):
        """Get list of chats - using dummy data for now"""
        # Dummy chat data
        dummy_chats = [
            {
                'id': 1,
                'name': 'John Doe',
                'avatar': '/web/static/src/img/avatar.png',
                'lastMessage': 'Hey, how are you?',
                'lastMessageTime': '10:30 AM',
                'unreadCount': 2,
                'status': 'Online'
            },
            {
                'id': 2,
                'name': 'Jane Smith',
                'avatar': '/web/static/src/img/avatar.png',
                'lastMessage': 'Thanks for the update!',
                'lastMessageTime': '9:15 AM',
                'unreadCount': 0,
                'status': 'Last seen 5 minutes ago'
            },
            {
                'id': 3,
                'name': 'Mike Johnson',
                'avatar': '/web/static/src/img/avatar.png',
                'lastMessage': 'Can we schedule a meeting?',
                'lastMessageTime': 'Yesterday',
                'unreadCount': 1,
                'status': 'Last seen 1 hour ago'
            },
            {
                'id': 4,
                'name': 'Sarah Wilson',
                'avatar': '/web/static/src/img/avatar.png',
                'lastMessage': 'The project looks great!',
                'lastMessageTime': 'Yesterday',
                'unreadCount': 0,
                'status': 'Last seen 2 hours ago'
            },
            {
                'id': 5,
                'name': 'David Brown',
                'avatar': '/web/static/src/img/avatar.png',
                'lastMessage': 'I will send the files soon',
                'lastMessageTime': '2 days ago',
                'unreadCount': 0,
                'status': 'Last seen yesterday'
            }
        ]
        
        return {'chats': dummy_chats}
    
    @http.route('/whatsapp/api/messages/<int:chat_id>', type='json', auth='user')
    def get_messages(self, chat_id):
        """Get messages for a specific chat - using dummy data for now"""
        # Dummy messages data
        dummy_messages = {
            1: [  # John Doe
                {'id': 1, 'text': 'Hey, how are you?', 'fromMe': False, 'timestamp': '10:30 AM'},
                {'id': 2, 'text': 'I am doing great! How about you?', 'fromMe': True, 'timestamp': '10:32 AM'},
                {'id': 3, 'text': 'Good to hear! Are we still meeting tomorrow?', 'fromMe': False, 'timestamp': '10:35 AM'},
                {'id': 4, 'text': 'Yes, at 2 PM in the office', 'fromMe': True, 'timestamp': '10:36 AM'},
            ],
            2: [  # Jane Smith
                {'id': 5, 'text': 'Thanks for the update!', 'fromMe': False, 'timestamp': '9:15 AM'},
                {'id': 6, 'text': 'You are welcome! Let me know if you need anything else', 'fromMe': True, 'timestamp': '9:16 AM'},
            ],
            3: [  # Mike Johnson
                {'id': 7, 'text': 'Can we schedule a meeting?', 'fromMe': False, 'timestamp': 'Yesterday'},
                {'id': 8, 'text': 'Sure, what time works for you?', 'fromMe': True, 'timestamp': 'Yesterday'},
            ],
            4: [  # Sarah Wilson
                {'id': 9, 'text': 'The project looks great!', 'fromMe': False, 'timestamp': 'Yesterday'},
                {'id': 10, 'text': 'Thank you! I am glad you like it', 'fromMe': True, 'timestamp': 'Yesterday'},
            ],
            5: [  # David Brown
                {'id': 11, 'text': 'I will send the files soon', 'fromMe': False, 'timestamp': '2 days ago'},
                {'id': 12, 'text': 'Perfect, looking forward to it', 'fromMe': True, 'timestamp': '2 days ago'},
            ]
        }
        
        messages = dummy_messages.get(chat_id, [])
        return {'messages': messages}
    
    @http.route('/whatsapp/api/send', type='json', auth='user')
    def send_message(self, chat_id, message, message_type='text'):
        """Send a message - using dummy response for now"""
        # Simulate successful message sending
        return {'success': True, 'message_id': 999, 'timestamp': 'Just now'}
    
    @http.route('/whatsapp/api/upload', type='json', auth='user')
    def upload_file(self, chat_id, file_data, file_name, file_type):
        """Upload and send a file - using dummy response for now"""
        # Simulate successful file upload
        return {'success': True, 'message_id': 998, 'timestamp': 'Just now', 'file_name': file_name}
    
    @http.route('/whatsapp/api/status', type='json', auth='user')
    def get_connection_status(self):
        """Get WhatsApp connection status - using dummy response for now"""
        # Simulate connected status
        return {'status': 'connected', 'message': 'WhatsApp is connected and ready'}
    
    # New comprehensive API endpoints for full functionality
    
    @http.route('/whatsapp/check_connection_status', type='json', auth='user')
    def check_connection_status(self):
        """Check WhatsApp connection status"""
        try:
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                result = api_service.check_connection_status()
                return result
            else:
                return {'success': False, 'status': 'no_service', 'error': 'No WhatsApp service configured'}
        except Exception as e:
            return {'success': False, 'status': 'error', 'error': str(e)}
    
    @http.route('/whatsapp/get_conversations', type='json', auth='user')
    def get_conversations(self):
        """Get all conversations"""
        try:
            conversations = request.env['whatsapp.conversation'].get_recent_conversations()
            return conversations
        except Exception as e:
            return []
    
    @http.route('/whatsapp/get_contacts', type='json', auth='user')
    def get_contacts(self):
        """Get all contacts"""
        try:
            contacts = request.env['whatsapp.contact'].search([])
            return [contact.get_contact_data() for contact in contacts]
        except Exception as e:
            return []
    
    @http.route('/whatsapp/get_messages', type='json', auth='user')
    def get_messages(self, conversation_id, limit=50, offset=0):
        """Get messages for a conversation"""
        try:
            conversation = request.env['whatsapp.conversation'].browse(conversation_id)
            if conversation.exists():
                messages = conversation.get_messages_for_chat(limit, offset)
                return messages
            return []
        except Exception as e:
            return []
    
    @http.route('/whatsapp/send_message', type='json', auth='user')
    def send_message(self, conversation_id, content, type='text', media_data=None):
        """Send a message"""
        try:
            conversation = request.env['whatsapp.conversation'].browse(conversation_id)
            if not conversation.exists():
                return {'success': False, 'error': 'Conversation not found'}
            
            # Create message record
            message = request.env['whatsapp.message'].create_message(
                contact_id=conversation.contact_id.id,
                content=content,
                message_type=type,
                direction='outbound',
                media_data=media_data
            )
            
            # Send via API service
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service and api_service.is_authenticated:
                api_result = api_service.send_message(
                    conversation.contact_id.phone_number,
                    content,
                    type,
                    media_data
                )
                
                if api_result['success']:
                    message.write({
                        'message_id': api_result.get('message_id', message.message_id),
                        'status': 'sent'
                    })
                    return {'success': True, 'message_id': message.id}
                else:
                    message.write({'status': 'failed'})
                    return {'success': False, 'error': api_result.get('error')}
            else:
                # When no API service, just simulate success
                message.write({'status': 'sent'})
                return {'success': True, 'message_id': message.id}
                
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    @http.route('/whatsapp/authenticate_qr', type='json', auth='user')
    def authenticate_qr(self):
        """Generate QR code for authentication"""
        try:
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                return api_service.authenticate_with_qr()
            else:
                return {'success': False, 'error': 'No WhatsApp service configured'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    @http.route('/whatsapp/mark_conversation_read', type='json', auth='user')
    def mark_conversation_read(self, conversation_id):
        """Mark conversation as read"""
        try:
            conversation = request.env['whatsapp.conversation'].browse(conversation_id)
            if conversation.exists():
                conversation.action_mark_as_read()
                return {'success': True}
            return {'success': False, 'error': 'Conversation not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    @http.route('/whatsapp/search_conversations', type='json', auth='user')
    def search_conversations(self, search_term):
        """Search conversations"""
        try:
            conversations = request.env['whatsapp.conversation'].search_conversations(search_term)
            return conversations
        except Exception as e:
            return []
    
    @http.route('/whatsapp/get_or_create_conversation', type='json', auth='user')
    def get_or_create_conversation(self, contact_id):
        """Get or create conversation for contact"""
        try:
            conversation = request.env['whatsapp.conversation'].get_or_create_conversation(contact_id)
            return conversation.get_conversation_data()
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    @http.route('/whatsapp/webhook', type='http', auth='public', methods=['GET', 'POST'], csrf=False)
    def webhook(self):
        """WhatsApp webhook endpoint"""
        if request.httprequest.method == 'GET':
            # Webhook verification
            verify_token = request.httprequest.args.get('hub.verify_token')
            challenge = request.httprequest.args.get('hub.challenge')
            
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                verified_challenge = api_service.webhook_verify(verify_token, challenge)
                if verified_challenge:
                    return verified_challenge
            
            return "Verification failed"
        
        elif request.httprequest.method == 'POST':
            # Process webhook data
            webhook_data = request.httprequest.get_json()
            
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                result = api_service.process_webhook(webhook_data)
                if result.get('success'):
                    return "OK"
            
            return "Processing failed"
        
        return "Method not allowed"
    
    @http.route('/whatsapp/upload_media', type='json', auth='user')
    def upload_media(self, file_data, file_name, file_type):
        """Upload media file"""
        try:
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                # Decode base64 data if needed
                import base64
                media_bytes = base64.b64decode(file_data)
                
                result = api_service.upload_media(media_bytes, file_type)
                
                if result['success']:
                    return {'success': True, 'media_id': result['media_id']}
                else:
                    return {'success': False, 'error': result['error']}
            else:
                return {'success': False, 'error': 'No WhatsApp service configured'}
                
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    @http.route('/whatsapp/get_message_templates', type='json', auth='user')
    def get_message_templates(self):
        """Get available message templates"""
        try:
            api_service = request.env['whatsapp.api.service'].get_default_service()
            if api_service:
                # This would typically make an API call to get templates
                # For now, return dummy templates
                templates = [
                    {'name': 'hello_world', 'status': 'APPROVED', 'category': 'UTILITY'},
                    {'name': 'order_confirmation', 'status': 'APPROVED', 'category': 'UTILITY'},
                    {'name': 'payment_reminder', 'status': 'APPROVED', 'category': 'UTILITY'},
                ]
                return {'templates': templates}
            return {'templates': []}
        except Exception as e:
            return {'templates': []}
    
    # Dummy API endpoints for testing with realistic data
    
    @http.route('/whatsapp/api/connections/', type='json', auth='user')
    def get_connections(self):
        """Return WhatsApp connections filtered by authorization"""
        try:
            _logger.info("🔍 Loading authorized WhatsApp connections for user %s...", request.env.user.login)
            Connection = request.env['whatsapp.connection']

            # Filter connections by authorization
            domain = Connection._get_authorized_connection_domain()
            connections = Connection.search(domain)
            _logger.info("📊 Found %d authorized connections for user", len(connections))
            
            result = []
            for c in connections:
                conn_data = {
                    "id": c.id,
                    "name": c.name,
                    "phone_number": c.from_field,
                    "api_key": c.api_key,
                    # mark authenticated if api_key present
                    "is_authenticated": bool(c.api_key),
                    # use default flag as a coarse connection status for now
                    "connection_status": "connected" if c.is_default else "disconnected",
                    "is_default": bool(c.is_default),
                    "authorized_person_ids": c.authorized_person_ids.ids if c.authorized_person_ids else [],
                    "authorized_person_names": c.authorized_person_names or "No one",
                }
                result.append(conn_data)
                _logger.info("📱 Connection: %s (%s) - %s", c.name, c.from_field, "connected" if c.is_default else "disconnected")
            
            _logger.info("✅ Returning %d connections to frontend", len(result))
            return result
        except Exception as e:
            _logger.exception("❌ Failed to load WhatsApp connections: %s", e)
            # Preserve previous behavior on error
            return []
    
    # QR Management endpoints
    @http.route('/whatsapp/qr/create_popup', type='json', auth='user', methods=['POST'])
    def create_qr_popup(self, **kwargs):
        """Create QR popup record"""
        try:
            data = request.jsonrequest
            
            qr_popup = request.env['whatsapp.qr.popup'].create({
                'qr_code_image': data.get('qr_code_image', ''),
                'qr_code_filename': data.get('qr_code_filename', 'whatsapp_qr_code.png'),
                'from_number': data.get('from_number', ''),
                'from_name': data.get('from_name', ''),
                'message': data.get('message', 'Please scan QR code to connect WhatsApp'),
                'api_key': data.get('api_key', ''),
                'phone_number': data.get('phone_number', ''),
                'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                'countdown_seconds': 120,
                'is_expired': False,
                'retry_count': 0,
                'last_qr_string': data.get('qr_code_image', '')[:100] if data.get('qr_code_image') else ''
            })
            
            return {
                'success': True,
                'popup_id': qr_popup.id
            }
            
        except Exception as e:
            _logger.error(f"Error creating QR popup: {e}")
            return {
                'success': False,
                'error': str(e)
            }
    
    @http.route('/whatsapp/qr/update_popup', type='json', auth='user', methods=['POST'])
    def update_qr_popup(self, **kwargs):
        """Update QR popup record"""
        try:
            data = request.jsonrequest
            popup_id = data.get('popup_id')
            
            if not popup_id:
                return {'success': False, 'error': 'Popup ID required'}
            
            qr_popup = request.env['whatsapp.qr.popup'].browse(popup_id)
            if not qr_popup.exists():
                return {'success': False, 'error': 'Popup not found'}
            
            update_data = {}
            if 'qr_code_image' in data:
                update_data['qr_code_image'] = data['qr_code_image']
            if 'message' in data:
                update_data['message'] = data['message']
            if 'qr_expires_at' in data:
                update_data['qr_expires_at'] = data['qr_expires_at']
            if 'is_expired' in data:
                update_data['is_expired'] = data['is_expired']
            if 'retry_count' in data:
                update_data['retry_count'] = data['retry_count']
            
            qr_popup.write(update_data)
            
            return {'success': True}
            
        except Exception as e:
            _logger.error(f"Error updating QR popup: {e}")
            return {
                'success': False,
                'error': str(e)
            }
    
    @http.route('/whatsapp/qr/handle_phone_mismatch', type='json', auth='user', methods=['POST'])
    def handle_phone_mismatch(self, **kwargs):
        """Handle phone mismatch event"""
        try:
            data = request.jsonrequest
            popup_id = data.get('popup_id')
            expected_phone = data.get('expected_phone')
            actual_phone = data.get('actual_phone')
            new_qr_code = data.get('new_qr_code')
            
            if not popup_id:
                return {'success': False, 'error': 'Popup ID required'}
            
            qr_popup = request.env['whatsapp.qr.popup'].browse(popup_id)
            if not qr_popup.exists():
                return {'success': False, 'error': 'Popup not found'}
            
            # Handle phone mismatch
            result = qr_popup._handle_phone_mismatch(expected_phone, actual_phone, new_qr_code)
            
            return {
                'success': True,
                'result': result
            }
            
        except Exception as e:
            _logger.error(f"Error handling phone mismatch: {e}")
            return {
                'success': False,
                'error': str(e)
            }
    
    @http.route('/whatsapp/qr/handle_expiration', type='json', auth='user', methods=['POST'])
    def handle_qr_expiration(self, **kwargs):
        """Handle QR expiration event"""
        try:
            data = request.jsonrequest
            popup_id = data.get('popup_id')
            
            if not popup_id:
                return {'success': False, 'error': 'Popup ID required'}
            
            qr_popup = request.env['whatsapp.qr.popup'].browse(popup_id)
            if not qr_popup.exists():
                return {'success': False, 'error': 'Popup not found'}
            
            # Handle QR expiration
            result = qr_popup._handle_qr_expiration()
            
            return {
                'success': True,
                'result': result
            }
            
        except Exception as e:
            _logger.error(f"Error handling QR expiration: {e}")
            return {
                'success': False,
                'error': str(e)
            }
    
    @http.route('/whatsapp/api/conversations/', type='json', auth='user')
    def get_conversations(self, connection_id=None):
        """Get conversations for a specific WhatsApp connection from the database"""
        try:
            if not connection_id:
                return []
            
            # Get the connection to validate it exists
            connection = request.env['whatsapp.connection'].sudo().browse(connection_id)
            if not connection.exists():
                return []
            
            # Get conversations for this connection
            # Filter conversations by connection_id if that field exists, or by default connection
            domain = []
            if hasattr(request.env['whatsapp.conversation'], 'connection_id'):
                domain = [('connection_id', '=', connection_id)]
            elif connection.is_default:
                domain = [('connection_id', '=', None)]  # Default connection
            
            conversations = request.env['whatsapp.conversation'].sudo().search(domain, limit=50)
            
            result = []
            for conv in conversations:
                
                # Get the last message for this conversation
                last_message = request.env['whatsapp.message'].sudo().search([
                    ('conversation_id', '=', conv.id)
                ], order='timestamp DESC', limit=1)
                
                # Count unread messages (assuming there's a read field)
                unread_count = 0
                if hasattr(request.env['whatsapp.message'], 'is_read'):
                    unread_count = request.env['whatsapp.message'].sudo().search_count([
                        ('conversation_id', '=', conv.id),
                        ('is_read', '=', False),
                        ('direction', '=', 'inbound')
                    ])
                
                result.append({
                    "id": conv.id,
                    "conversation_id": f"conv_{conv.id}",
                    "contact_name": conv.contact_id.name if conv.contact_id else conv.partner_id.name if conv.partner_id else "Unknown Contact",
                    "contact_phone": conv.contact_id.phone_number if conv.contact_id else conv.partner_id.mobile if conv.partner_id else "",
                    "last_message_content": last_message.content if last_message else "No messages yet",
                    "last_message_type": last_message.message_type if last_message else "text",
                    "last_activity": last_message.timestamp.isoformat() if last_message else conv.write_date.isoformat(),
                    "unread_count": unread_count,
                    "is_pinned": False,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "online"
                })
            
            return result
            
        except Exception as e:
            _logger.exception("Failed to load conversations for connection %s: %s", connection_id, e)
            return []

    @http.route('/whatsapp/api/conversations_dummy/', type='json', auth='user')
    def get_conversations_dummy(self, connection_id=None):
        """Get conversations for a connection with dummy data"""
        dummy_conversations = {
            1: [  # Business Account 1
                {
                    "id": 1,
                    "conversation_id": "conv_1234567890_customer_001",
                    "contact_name": "John Doe",
                    "contact_phone": "+1111111111",
                    "last_message_content": "Hello, thanks for calling!",
                    "last_message_type": "text",
                    "last_activity": "2025-01-03T10:30:00Z",
                    "unread_count": 2,
                    "is_pinned": False,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "online"
                },
                {
                    "id": 2,
                    "conversation_id": "conv_1234567890_customer_002",
                    "contact_name": "Jane Smith",
                    "contact_phone": "+2222222222",
                    "last_message_content": "Thanks for the quick response!",
                    "last_message_type": "text",
                    "last_activity": "2025-01-03T09:45:00Z",
                    "unread_count": 0,
                    "is_pinned": True,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "last_seen_5_minutes_ago"
                },
                {
                    "id": 3,
                    "conversation_id": "conv_1234567890_customer_003",
                    "contact_name": "Mike Johnson",
                    "contact_phone": "+3333333333",
                    "last_message_content": "Can we schedule a meeting for tomorrow?",
                    "last_message_type": "text",
                    "last_activity": "2025-01-03T08:20:00Z",
                    "unread_count": 1,
                    "is_pinned": False,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "last_seen_1_hour_ago"
                }
            ],
            2: [  # Support Account
                {
                    "id": 11,
                    "conversation_id": "conv_support_customer_001",
                    "contact_name": "Sarah Wilson",
                    "contact_phone": "+4444444444",
                    "last_message_content": "I need help with my order",
                    "last_message_type": "text",
                    "last_activity": "2025-01-02T15:30:00Z",
                    "unread_count": 3,
                    "is_pinned": False,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "online"
                }
            ],
            3: [  # Sales Account
                {
                    "id": 21,
                    "conversation_id": "conv_sales_customer_001",
                    "contact_name": "David Brown",
                    "contact_phone": "+5555555555",
                    "last_message_content": "Interested in your premium package",
                    "last_message_type": "text",
                    "last_activity": "2025-01-03T11:15:00Z",
                    "unread_count": 0,
                    "is_pinned": True,
                    "is_muted": False,
                    "is_archived": False,
                    "profile_picture": "/web/static/src/img/avatar.png",
                    "contact_status": "last_seen_30_minutes_ago"
                }
            ]
        }
        
        return dummy_conversations.get(connection_id, [
            {
                "id": 99,
                "conversation_id": "conv_default",
                "contact_name": "Test Contact",
                "contact_phone": "+9999999999",
                "last_message_content": "Welcome! How can I help you?",
                "last_message_type": "text",
                "last_activity": "2025-01-03T12:00:00Z",
                "unread_count": 0,
                "is_pinned": False,
                "is_muted": False,
                "is_archived": False,
                "profile_picture": "/web/static/src/img/avatar.png",
                "contact_status": "online"
            }
        ])
    
    @http.route('/whatsapp/api/conversation_messages/', type='json', auth='user')
    def get_conversation_messages_dummy(self, connection_id=None, conversation_id=None):
        """Get messages for a specific conversation with dummy data"""
        dummy_messages = {
            1: [  # conversation 1 - John Doe
                {
                    "id": 1,
                    "message_id": "msg_1234567890_001",
                    "content": "Hi there! How can I help you today?",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T10:00:00Z",
                    "contact_id": "+1111111111",
                    "contact_name": "John Doe"
                },
                {
                    "id": 2,
                    "message_id": "msg_1234567890_002",
                    "content": "I have a question about your pricing",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T10:01:00Z",
                    "contact_id": "+1111111111",
                    "contact_name": "John Doe"
                },
                {
                    "id": 3,
                    "message_id": "msg_9876543210_001",
                    "content": "Hello! I'd be happy to help you with pricing information. Our basic plan starts at $29/month.",
                    "type": "text",
                    "direction": "outbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T10:02:00Z",
                    "contact_id": "+1111111111",
                    "contact_name": "John Doe"
                },
                {
                    "id": 4,
                    "message_id": "msg_1234567890_003",
                    "content": "That sounds reasonable. What features are included?",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T10:03:00Z",
                    "contact_id": "+1111111111",
                    "contact_name": "John Doe"
                },
                {
                    "id": 5,
                    "message_id": "msg_9876543210_002",
                    "content": "Our basic plan includes unlimited contacts, message templates, basic analytics, and email support.",
                    "type": "text",
                    "direction": "outbound",
                    "status": "sent",
                    "timestamp": "2025-01-03T10:04:00Z",
                    "contact_id": "+1111111111",
                    "contact_name": "John Doe"
                }
            ],
            2: [  # conversation 2 - Jane Smith
                {
                    "id": 10,
                    "message_id": "msg_1234567890_010",
                    "content": "Thank you for your quick response yesterday!",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T09:45:00Z",
                    "contact_id": "+2222222222",
                    "contact_name": "Jane Smith"
                },
                {
                    "id": 11,
                    "message_id": "msg_9876543210_010",
                    "content": "You're very welcome! Is there anything else I can help you with today?",
                    "type": "text",
                    "direction": "outbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T09:46:00Z",
                    "contact_id": "+2222222222",
                    "contact_name": "Jane Smith"
                }
            ],
            3: [  # conversation 3 - Mike Johnson
                {
                    "id": 20,
                    "message_id": "msg_1234567890_020",
                    "content": "Hi, I'm interested in scheduling a meeting",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T08:20:00Z",
                    "contact_id": "+3333333333",
                    "contact_name": "Mike Johnson"
                },
                {
                    "id": 21,
                    "message_id": "msg_9876543210_020",
                    "content": "Absolutely! What day works best for you?",
                    "type": "text",
                    "direction": "outbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T08:21:00Z",
                    "contact_id": "+3333333333",
                    "contact_name": "Mike Johnson"
                },
                {
                    "id": 22,
                    "message_id": "msg_1234567890_021",
                    "content": "Can we schedule a meeting for tomorrow?",
                    "type": "text",
                    "direction": "inbound",
                    "status": "delivered",
                    "timestamp": "2025-01-03T08:22:00Z",
                    "contact_id": "+3333333333",
                    "contact_name": "Mike Johnson"
                }
            ]
        }
        
        return dummy_messages.get(conversation_id, [
            {
                "id": 100,
                "message_id": "msg_default_001",
                "content": "Welcome! This is a new conversation.",
                "type": "text",
                "direction": "outbound",
                "status": "delivered",
                "timestamp": "2025-01-03T12:00:00Z",
                "contact_id": "+9999999999",
                "contact_name": "Test Contact"
            }
        ])

    @http.route('/whatsapp/create_lead_action', type='json', auth='user')
    def create_lead_action(self, **payload):
        """Return an action that opens the CRM lead form prefilled with WhatsApp data"""
        message_direction = payload.get('message_direction')
        if message_direction and message_direction != 'inbound':
            return {'error': 'Leads can only be created from inbound messages.'}

        contact_name = (payload.get('contact_name') or '').strip()
        contact_phone = (payload.get('contact_phone') or '').strip()
        message_content = (payload.get('message_content') or '').strip()
        message_id = payload.get('message_id')
        conversation_id = payload.get('conversation_id')
        timestamp = payload.get('timestamp')

        # Fallback values
        if message_content:
            lead_name = message_content.splitlines()[0]
        elif contact_name:
            lead_name = contact_name
        else:
            lead_name = "New WhatsApp Lead"
        lead_name = (lead_name or "New WhatsApp Lead")[:64]

        description_lines = []
        if message_content:
            description_lines.append(message_content)
        if timestamp:
            description_lines.append(f"Received at: {timestamp}")
        if conversation_id:
            description_lines.append(f"Conversation: {conversation_id}")
        if message_id:
            description_lines.append(f"Message ID: {message_id}")
        description = "\n".join(description_lines) if description_lines else False

        context = dict(request.env.context)
        context.update({
            'default_name': lead_name,
            'default_contact_name': contact_name or False,
            'default_partner_name': contact_name or False,
            'default_phone': contact_phone or False,
            'default_mobile': contact_phone or False,
            'default_description': description,
            'default_referred': 'WhatsApp',
        })

        # Include metadata so it can be stored on the lead if custom fields exist
        if message_id:
            context['default_x_whatsapp_message_id'] = message_id
        if conversation_id:
            context['default_x_whatsapp_conversation_id'] = conversation_id

        action = {
            'type': 'ir.actions.act_window',
            'name': 'New Lead',
            'res_model': 'crm.lead',
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
            'context': context,
        }
        return action
    
    @http.route('/whatsapp/api/send_message/', type='json', auth='user')
    def send_message_dummy(self, connection_id=None, conversation_id=None, content=None, type='text'):
        """Send message with dummy response"""
        try:
            # Simulate API call delay
            import time
            time.sleep(0.5)
            
            # Return success response with message ID
            return {
                "success": True,
                "message_id": f"msg_{connection_id}_{conversation_id}_{int(time.time())}",
                "status": "sent",
                "timestamp": "2025-01-03T12:00:00Z",
                "conversation_id": conversation_id,
                "delivery_status": "sent_to_server"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "error_code": "SEND_FAILED"
            }
    
    @http.route('/whatsapp/api/mark_read/', type='json', auth='user')
    def mark_read_dummy(self, connection_id=None, conversation_id=None):
        """Mark conversation as read with dummy response"""
        try:
            # Simulate marking as read
            return {
                "success": True,
                "conversation_id": conversation_id,
                "unread_count": 0,
                "last_read_message_id": 999,
                "read_timestamp": "2025-01-03T12:00:00Z"
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    @http.route('/whatsapp/api/connection_status/', type='json', auth='user')
    def connection_status_dummy(self, connection_id=None):
        """Get connection status with dummy data"""
        connection_statuses = {
            1: {"status": "connected", "message": "WhatsApp Business API is active"},
            2: {"status": "disconnected", "message": "Connection lost - re-authentication required"},
            3: {"status": "connected", "message": "WhatsApp Business API is active"},
        }
        
        status = connection_statuses.get(connection_id, {"status": "unknown", "message": "Connection status unknown"})
        
        return {
            "success": True,
            "connection_id": connection_id,
            **status,
            "last_check": "2025-01-03T12:00:00Z"
        }
