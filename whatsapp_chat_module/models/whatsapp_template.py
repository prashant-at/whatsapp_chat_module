# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import logging

_logger = logging.getLogger(__name__)


class WhatsAppTemplate(models.Model):
    """WhatsApp Templates for sending messages"""
    _name = 'whatsapp.template'
    _description = 'WhatsApp Template'
    _inherit = ['mail.render.mixin']
    _order = 'user_id,name,id'
    

    # Basic fields
    name = fields.Char('Name', translate=True, help="Template name")
    description = fields.Text(
        'Template description', translate=True,
        help="This field is used for internal description of the template's usage.")
    
    # Model association
    model_id = fields.Many2one('ir.model', 'Applies to', ondelete='cascade',
    help="The type of document this template can be used with")
    model = fields.Char('Related Document Model', related='model_id.model',store=True)
    
    # User association
    user_id = fields.Many2one('res.users', string='User', domain="[('share', '=', False)]",
    help='The template belongs to this user. Leave empty for all users.')
    
    # Message content
    subject = fields.Char('Subject', translate=True, prefetch=True,
    help="Subject (placeholders may be used here, e.g., {{ object.name }})")
    body_html = fields.Html('Body', render_engine='qweb', render_options={'post_process': True},
    prefetch=True, translate=True, sanitize=False,
    help="Message body (placeholders may be used here, e.g., {{ object.name }})")
    
    # Attachments
    attachment_ids = fields.Many2many(
        'ir.attachment', 'whatsapp_template_attachment_rel',
        'whatsapp_template_id', 'attachment_id',
        string='Attachments',
        help="Attachments to include in the WhatsApp message")
    
    # Dynamic reports
    report_template_ids = fields.Many2many(
        'ir.actions.report', 'whatsapp_template_report_rel',
        'whatsapp_template_id', 'report_id',
        string='Dynamic Reports',
        help="Reports to generate and attach to the WhatsApp message")
    
    # Settings fields
    lang = fields.Char(
        'Language',
        help="Optional expression to determine the language of the template. If not set, uses the default language.")
    auto_delete = fields.Boolean(
        'Auto Delete',
        help="If checked, messages sent using this template will be automatically deleted after sending.")
    
    # Template category (similar to mail.template)
    template_category = fields.Selection(
        [('base_template', 'Base Template'),
         ('hidden_template', 'Hidden Template'),
         ('custom_template', 'Custom Template')],
        compute="_compute_template_category", search="_search_template_category",
        help="Template category for filtering")
    
    @api.model
    def default_get(self, fields):
        res = super(WhatsAppTemplate, self).default_get(fields)
        if res.get('model'):
            res['model_id'] = self.env['ir.model']._get(res.pop('model')).id
        return res
    
    @api.depends('user_id')
    def _compute_template_category(self):
        """Compute template category based on user_id"""
        for template in self:
            if not template.user_id:
                template.template_category = 'base_template'
            elif template.user_id.id == self.env.user.id:
                template.template_category = 'custom_template'
            else:
                template.template_category = 'hidden_template'
    
    def _search_template_category(self, operator, value):
        """Search template by category"""
        if operator == '=':
            if value == 'base_template':
                return [('user_id', '=', False)]
            elif value == 'custom_template':
                return [('user_id', '=', self.env.user.id)]
            elif value == 'hidden_template':
                return [('user_id', '!=', False), ('user_id', '!=', self.env.user.id)]
        return []
    
    def _render_template(self, template_field, model, res_ids, engine='qweb', options=None):
        """Render template field with given model and res_ids"""
        if not template_field:
            return {}
        
        if options is None:
            options = {}
        
        try:
            rendered = super(WhatsAppTemplate, self)._render_template(
                template_field, model, res_ids, engine=engine, options=options
            )
            return rendered
        except Exception as e:
            _logger.error(f"Error rendering WhatsApp template {self.name}: {str(e)}")
            # Return empty dict with res_ids as keys
            return {res_id: '' for res_id in res_ids}

