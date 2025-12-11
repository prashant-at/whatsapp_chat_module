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
    
    # def _compute_authorized_whatsapp_connections(self):
    #     """Compute authorized connections for this user"""
    #     for user in self:
    #         if user.id:
    #             # Find connections where user is in authorized_person_ids
    #             connections = self.env['whatsapp.connection'].search([
    #                 ('authorized_person_ids', 'in', [user.id])
    #             ])
    #             user.authorized_whatsapp_connection_ids = connections
    #         else:
    #             user.authorized_whatsapp_connection_ids = False

    def _compute_authorized_whatsapp_connections(self):
        if not self:
            return
        
        # Single query: get all connections that have ANY of our users authorized
        all_connections = self.env['whatsapp.connection'].search([
            ('authorized_person_ids', 'in', self.ids)
        ])
        
        # Build mapping: user_id -> list of connections
        user_connections = {user_id: self.env['whatsapp.connection'] for user_id in self.ids}
        for connection in all_connections:
            for user_id in connection.authorized_person_ids.ids:
                if user_id in user_connections:
                    user_connections[user_id] |= connection
        
        for user in self:
            user.authorized_whatsapp_connection_ids = user_connections.get(user.id, self.env['whatsapp.connection'])

