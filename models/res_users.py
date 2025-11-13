from odoo import models, fields, api

class ResUsers(models.Model):
    _inherit = 'res.users'
    
    whatsapp_default_connection_id = fields.Many2one(
        'whatsapp.connection',
        string='Default WhatsApp Connection',
        help="Default WhatsApp connection for this user. Only connections where this user is authorized will be available.",
        domain="[('authorized_person_ids', 'in', [id])]"
    )
    
    authorized_whatsapp_connection_ids = fields.Many2many(
        'whatsapp.connection',
        compute='_compute_authorized_whatsapp_connections',
        string='Authorized Connections',
        help="Connections where this user is authorized",
        store=False
    )
    
    def _compute_authorized_whatsapp_connections(self):
        """Compute authorized connections for this user"""
        for user in self:
            if user.id:
                # Find connections where user is in authorized_person_ids
                connections = self.env['whatsapp.connection'].search([
                    ('authorized_person_ids', 'in', [user.id])
                ])
                user.authorized_whatsapp_connection_ids = connections
            else:
                user.authorized_whatsapp_connection_ids = False

