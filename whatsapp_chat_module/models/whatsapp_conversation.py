# # -*- coding: utf-8 -*-

# from odoo import models, fields, api
# import logging

# _logger = logging.getLogger(__name__)


# class WhatsAppConversation(models.Model):
#     _name = 'whatsapp.conversation'
#     _description = 'WhatsApp Conversation'
#     _rec_name = 'display_name'
#     _order = 'last_activity desc'

#     # Basic fields
#     contact_id = fields.Many2one('whatsapp.contact', string='Contact', required=True)
#     conversation_id = fields.Char('Conversation ID', help='External conversation ID')
    
#     # Conversation info
#     display_name = fields.Char('Display Name', related='contact_id.display_name', store=True)
#     contact_name = fields.Char('Contact Name', related='contact_id.name', store=True)
#     contact_phone = fields.Char('Phone Number', related='contact_id.phone_number', store=True)
    
#     # Message tracking
#     message_ids = fields.One2many('whatsapp.message', 'conversation_id', string='Messages')
#     last_message_id = fields.Many2one('whatsapp.message', string='Last Message')
#     last_message_content = fields.Text('Last Message', related='last_message_id.content', store=True)
#     last_activity = fields.Datetime('Last Activity', related='last_message_id.msg_timestamp', store=True)
    
#     # Status
#     is_active = fields.Boolean('Active Conversation', default=True)
#     is_pinned = fields.Boolean('Pinned', default=False)
#     is_archived = fields.Boolean('Archived', default=False)
#     is_muted = fields.Boolean('Muted', default=False)
    
#     # Counts
#     message_count = fields.Integer('Total Messages', compute='_compute_message_count', store=True)
#     unread_count = fields.Integer('Unread Messages', compute='_compute_unread_count', store=True)
    
#     # Conversation metadata
#     last_read_message_id = fields.Many2one('whatsapp.message', string='Last Read message')
#     read_all_time = fields.Datetime('Last Read All Time')
    
#     # Business context
#     context_type = fields.Selection([
#         ('general', 'General Chat'),
#         ('support', 'Customer Support'),
#         ('sales', 'Sales Conversation'),
#         ('project', 'Project Discussion'),
#         ('quote', 'Quote Discussion'),
#         ('invoice', 'Invoice Follow-up'),
#     ], string='Context Type', default='general')
    
#     context_object_id = fields.Reference(
#         selection='_get_context_models',
#         string='Context Object',
#         help='Related Odoo object for business context'
#     )
    
#     # Tags
#     tag_ids = fields.Many2many('whatsapp.conversation.tag', string='Tags')
    
#     _sql_constraints = [
#         ('contact_unique', 'UNIQUE(contact_id)', 'Only one conversation per contact!'),
#     ]

#     @api.model
#     def _get_context_models(self):
#         """Get available context models"""
#         return [
#             ('sale.order', 'Sale Order'),
#             ('purchase.order', 'Purchase Order'),
#             ('stock.picking', 'Stock Picking'),
#             ('account.move', 'Invoice'),
#             ('crm.lead', 'Lead'),
#             ('project.project', 'Project'),
#             ('project.task', 'Task'),
#         ]

#     @api.depends('message_ids')
#     def _compute_message_count(self):
#         for record in self:
#             record.message_count = len(record.message_ids)

#     @api.depends('message_ids', 'last_read_message_id')
#     def _compute_unread_count(self):
#         for record in self:
#             if record.last_read_message_id:
#                 unread_messages = record.message_ids.filtered(
#                     lambda m: m.id > record.last_read_message_id.id and 
#                     m.direction == 'inbound'
#                 )
#             else:
#                 unread_messages = record.message_ids.filtered(
#                     lambda m: m.direction == 'inbound'
#                 )
            
#             record.unread_count = len(unread_messages)

#     @api.model
#     def get_or_create_conversation(self, contact_id):
#         """Get existing conversation or create new one for contact"""
#         conversation = self.search([('contact_id', '=', contact_id)], limit=1)
        
#         if not conversation:
#             # Get external conversation ID (this would come from WhatsApp API)
#             external_id = f"conv_{contact_id}_{self.env.user.id}"
            
#             conversation = self.create({
#                 'contact_id': contact_id,
#                 'conversation_id': external_id,
#                 'is_active': True,
#             })
            
#             _logger.info(f"Created new conversation for contact {contact_id}: {conversation.id}")
        
#         return conversation

#     def get_conversation_data(self):
#         """Get conversation data for JavaScript/API"""
#         return {
#             'id': self.id,
#             'conversation_id': self.conversation_id,
#             'contact_id': self.contact_id.id,
#             'contact_name': self.contact_name,
#             'contact_phone': self.contact_phone,
#             'display_name': self.display_name,
#             'message_count': self.message_count,
#             'unread_count': self.unread_count,
#             'last_message': self.last_message_content,
#             'last_activity': self.last_activity.isoformat() if self.last_activity else None,
#             'is_pinned': self.is_pinned,
#             'is_muted': self.is_muted,
#             'is_archived': self.is_archived,
#             'context_type': self.context_type,
#             'context_object_id': self.context_object_id.id if self.context_object_id else None,
#             'profile_picture': self.contact_id.get_profile_picture_url(),
#         }

#     def get_messages_for_chat(self, limit=50, offset=0):
#         """Get messages for chat display"""
#         messages = self.message_ids.sorted(lambda m: m.msg_timestamp)[offset:offset + limit]
#         return [msg.get_message_for_chat_ui() for msg in messages]

#     def action_create_message(self):
#         """Action to create new message in this conversation"""
#         return {
#             'type': 'ir.actions.act_window',
#             'name': f'New Message - {self.display_name}',
#             'res_model': 'whatsapp.message',
#             'view_mode': 'form',
#             'target': 'new',
#             'context': {
#                 'default_conversation_id': self.id,
#                 'default_contact_id': self.contact_id.id,
#                 'default_direction': 'outbound',
#             },
#         }

#     def action_mark_as_read(self):
#         """Mark conversation as read"""
#         if self.message_ids:
#             latest_message = self.message_ids.sorted(lambda m: m.msg_timestamp)[-1]
#             self.write({
#                 'last_read_message_id': latest_message.id,
#                 'read_all_time': fields.Datetime.now(),
#             })
            
#             # Update contact's unread count
#             self.contact_id.write({'unread_count': 0})

#     def action_pin_conversation(self):
#         """Pin/unpin conversation"""
#         self.write({'is_pinned': not self.is_pinned})

#     def action_mute_conversation(self):
#         """Mute/unmute conversation"""
#         self.write({'is_muted': not self.is_muted})

#     def action_archive_conversation(self):
#         """Archive conversation"""
#         self.write({'is_archived': True})

#     def action_unarchive_conversation(self):
#         """Unarchive conversation"""
#         self.write({'is_archived': False})

#     def set_conversation_context(self, context_type, context_object_id=None):
#         """Set business context for conversation"""
#         self.write({
#             'context_type': context_type,
#             'context_object_id': context_object_id,
#         })

#     def get_recent_conversations(self, limit=20):
#         """Get recent conversations sorted by activity"""
#         return self.search([
#             ('is_active', '=', True),
#             ('is_archived', '=', False)
#         ], limit=limit, order='pinned desc, last_activity desc').get_conversation_data()

#     def search_conversations(self, search_term):
#         """Search conversations by contact name or phone"""
#         domain = [
#             '|', '|',
#             ('contact_name', 'ilike', search_term),
#             ('contact_phone', 'ilike', search_term),
#             ('last_message_content', 'ilike', search_term)
#         ]
        
#         return self.search(domain).get_conversation_data()


# class WhatsAppConversationTag(models.Model):
#     _name = 'whatsapp.conversation.tag'
#     _description = 'WhatsApp Conversation Tag'

#     name = fields.Char('Tag Name', required=True)
#     color = fields.Integer('Color Index', default=0)
#     description = fields.Text('Description')
#     conversation_ids = fields.One2many('whatsapp.conversation', 'tag_ids', string='Conversations')

#     _sql_constraints = [
#         ('name_unique', 'UNIQUE(name)', 'Tag name must be unique!'),
#     ]
