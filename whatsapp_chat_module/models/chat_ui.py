from odoo import models, fields, api


class WhatsAppChatUI(models.TransientModel):
    _name = 'whatsapp.chat.ui'
    _description = 'WhatsApp Chat UI'

    selected_mobile_number = fields.Selection(selection='_get_mobile_numbers', string='Mobile No.', required=True)

    def _get_mobile_numbers(self):
        """Get mobile numbers from authorized connections"""
        domain = self.env['whatsapp.connection']._get_authorized_connection_domain()
        connections = self.env['whatsapp.connection'].search(domain)
        return [(conn.from_field, conn.from_field) for conn in connections]

    def name_get(self):
        """Override to hide record ID"""
        return [(record.id, 'WhatsApp Chat') for record in self]
