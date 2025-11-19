# from odoo import models, fields, api


# class WhatsAppRequestResponse(models.Model):
#     _name = 'whatsapp.request.response'
#     _description = 'WhatsApp Request Response'

#     name = fields.Char(string='Name', required=True)
#     from_field = fields.Char(string='From', required=True)
#     connection_id = fields.Many2one('whatsapp.connection', string='Connection', required=True)
#     request_url = fields.Char(string='Request URL', required=True)
#     request_data = fields.Text(string='Request Data')
#     response_data = fields.Text(string='Response Data')
#     stage_id = fields.Many2one('whatsapp.stage', string='Stage', required=True, default=lambda self: self._get_default_stage())

#     @api.model
#     def _get_default_stage(self):
#         """Get default stage (Pass)"""
#         stage = self.env['whatsapp.stage'].search([('name', '=', 'Pass')], limit=1)
#         return stage.id if stage else False

#     @api.onchange('connection_id')
#     def _onchange_connection_id(self):
#         """Auto-populate from field when connection is selected"""
#         if self.connection_id:
#             self.from_field = self.connection_id.from_field

#     def _get_mail_thread_data(self, request_list):
#         """Implement mail thread data for WhatsApp request response"""
#         return {
#             'id': self.id,
#             'name': self.name,
#             'model': self._name,
#             'res_id': self.id,
#             'thread_type': 'document',
#         }


# class WhatsAppStage(models.Model):
#     _name = 'whatsapp.stage'
#     _description = 'WhatsApp Stage'

#     name = fields.Char(string='Stage Name', required=True)
#     sequence = fields.Integer(string='Sequence', default=10)

#     def _get_mail_thread_data(self, request_list):
#         """Implement mail thread data for WhatsApp stage"""
#         return {
#             'id': self.id,
#             'name': self.name,
#             'model': self._name,
#             'res_id': self.id,
#             'thread_type': 'document',
#         }
