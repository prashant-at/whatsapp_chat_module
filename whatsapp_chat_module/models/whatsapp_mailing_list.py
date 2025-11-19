# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import UserError

class WhatsAppMailingList(models.Model):
    _name = 'whatsapp.mailing.list'
    _description = 'WhatsApp Mailing List'
    _inherit = ['mail.thread']
    _order = 'name'
    _mailing_enabled = True

    name = fields.Char('WhatsApp Mailing List')
    active = fields.Boolean(default=True)
    contact_count = fields.Integer(
        'Recipients',
        compute='_compute_contact_count'
    )
    
    contact_ids = fields.Many2many(
        'whatsapp.mailing.contact',
        'whatsapp_mailing_subscription',
        'list_id',
        'contact_id',
        string='Contacts',
        copy=False
    )
    subscription_ids = fields.One2many(
        'whatsapp.mailing.subscription',
        'list_id',
        string='Subscription Information',
        copy=True
    )
    
    campaign_ids = fields.Many2many(
        'whatsapp.marketing.campaign',
        'whatsapp_campaign_whatsapp_list_rel',
        'list_id',
        'campaign_id',
        string='Campaigns',
        copy=False
    )

    @api.depends('contact_ids')
    def _compute_contact_count(self):
        for mailing_list in self:
            mailing_list.contact_count = len(mailing_list.contact_ids)

    def write(self, vals):
        # Prevent archiving used mailing list
        if 'active' in vals and not vals.get('active'):
            campaigns = self.env['whatsapp.marketing.campaign'].search_count([
                ('state', '!=', 'sent'),
                ('whatsapp_list_ids', 'in', self.ids),
            ])
            if campaigns > 0:
                raise UserError(_("At least one of the mailing list you are trying to archive is used in an ongoing campaign."))
        return super().write(vals)

    def copy(self, default=None):
        self.ensure_one()
        default = dict(default or {}, name=_('%s (copy)', self.name))
        return super().copy(default)

    def action_open_import(self):
        """Open the WhatsApp mailing list contact import wizard."""
        action = self.env['ir.actions.actions']._for_xml_id('whatsapp_chat_module.action_whatsapp_mailing_contact_import')
        action['context'] = {
            **self.env.context,
            'default_whatsapp_list_ids': self.ids,
        }
        return action

    def action_send_campaign(self):
        """Open the campaign form view, with the current lists set as recipients."""
        action = self.env['ir.actions.actions']._for_xml_id('whatsapp_chat_module.action_whatsapp_marketing_campaign')
        action.update({
            'context': {
                **self.env.context,
                'default_whatsapp_list_ids': self.ids,
                'default_mailing_model_id': self.env['ir.model']._get_id('whatsapp.mailing.list'),
            },
            'target': 'current',
            'view_mode': 'form',
            'views': [(False, 'form')],
        })
        return action

    def action_view_contacts(self):
        """Open contacts filtered by this list"""
        action = self.env['ir.actions.actions']._for_xml_id('whatsapp_chat_module.action_whatsapp_mailing_contact')
        action['domain'] = [('list_ids', 'in', self.ids)]
        action['context'] = {'default_list_ids': self.ids}
        return action

