# -*- coding: utf-8 -*-

from odoo import models, fields, api
import logging

_logger = logging.getLogger(__name__)


class WhatsAppContact(models.Model):
    _name = 'whatsapp.contact'
    _description = 'WhatsApp Contact'
    _rec_name = 'display_name'

    name = fields.Char('Name', required=True)
    phone_number = fields.Char('Phone Number', required=True)
    display_name = fields.Char('Display Name', compute='_compute_display_name', store=True)
    profile_picture = fields.Text('Profile Picture Base64', help='Base64 encoded profile picture')
    is_whatsapp_user = fields.Boolean('WhatsApp User', default=True)
    last_seen = fields.Datetime('Last Seen')
    
    # Chat related fields
    conversation_ids = fields.One2many('whatsapp.conversation', 'contact_id', string='Conversations')
    last_message_id = fields.Many2one('whatsapp.message', string='Last Message')
    unread_count = fields.Integer('Unread Messages', default=0)
    
    # For Odoo integration
    partner_id = fields.Many2one('res.partner', string='Related Partner')
    
    _sql_constraints = [
        ('phone_number_unique', 'UNIQUE(phone_number)', 'Phone number must be unique!'),
    ]

    @api.depends('name', 'phone_number')
    def _compute_display_name(self):
        for record in self:
            if record.name and record.phone_number:
                record.display_name = f"{record.name} ({record.phone_number})"
            elif record.name:
                record.display_name = record.name
            else:
                record.display_name = record.phone_number or f"Contact {record.id}"

    @api.model
    def create_from_partner(self, partner_id):
        """Create WhatsApp contact from Odoo partner"""
        partner = self.env['res.partner'].browse(partner_id)
        if not partner or not partner.phone:
            return False
            
        # Extract clean phone number
        phone = ''.join(filter(str.isdigit, partner.phone))
        if len(phone) < 10:
            return False
            
        # Check if phone already exists
        existing = self.search([('phone_number', '=', phone)], limit=1)
        if existing:
            if not existing.partner_id:
                existing.partner_id = partner.id
            return existing
            
        return self.create({
            'name': partner.name,
            'phone_number': phone,
            'is_whatsapp_user': True,
            'partner_id': partner.id,
        })

    def action_send_message(self):
        """Open message composition for this contact"""
        action = self.env.ref('whatsapp_chat_module.action_whatsapp_compose_wizard')
        return action.read()[0]

    def get_profile_picture_url(self):
        """Get profile picture URL for JavaScript"""
        if self.profile_picture:
            return f"data:image/png;base64,{self.profile_picture}"
        return '/web/static/img/contacts.png'

    def get_contact_data(self):
        """Get contact data for JavaScript/API"""
        return {
            'id': self.id,
            'name': self.name,
            'phone_number': self.phone_number,
            'display_name': self.display_name,
            'profile_picture': self.get_profile_picture_url(),
            'is_whatsapp_user': self.is_whatsapp_user,
            'unread_count': self.unread_count,
            'last_seen': self.last_seen.isoformat() if self.last_seen else None,
            'partner_id': self.partner_id.id if self.partner_id else None,
        }
