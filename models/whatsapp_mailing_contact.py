# -*- coding: utf-8 -*-

from odoo import models, fields, api, _
from odoo.exceptions import UserError
import re
import logging

_logger = logging.getLogger(__name__)


class WhatsAppMailingContact(models.Model):
    _name = 'whatsapp.mailing.contact'
    _description = 'WhatsApp Mailing Contact'
    _inherit = ['mail.thread']
    _order = 'name ASC, id DESC'

    name = fields.Char('Name', required=True)
    mobile = fields.Char('Mobile', required=True, help='Phone number (e.g., +91 9157000128)')
    display_name = fields.Char('Display Name', compute='_compute_display_name', store=True)
    
    list_ids = fields.Many2many(
        'whatsapp.mailing.list',
        'whatsapp_mailing_subscription',
        'contact_id',
        'list_id',
        string='WhatsApp Mailing Lists',
        copy=False
    )
    subscription_ids = fields.One2many(
        'whatsapp.mailing.subscription',
        'contact_id',
        string='Subscription Information'
    )
    
    partner_id = fields.Many2one('res.partner', string='Related Partner')
    country_id = fields.Many2one('res.country', string='Country')
    tag_ids = fields.Many2many('res.partner.category', string='Tags')

    _sql_constraints = [
        ('mobile_unique', 'UNIQUE(mobile)', 'Mobile number must be unique!'),
    ]

    @api.depends('name', 'mobile')
    def _compute_display_name(self):
        for record in self:
            if record.name and record.mobile:
                record.display_name = f"{record.name} ({record.mobile})"
            elif record.name:
                record.display_name = record.name
            else:
                record.display_name = record.mobile or f"Contact {record.id}"

    @api.model
    def _normalize_phone(self, phone):
        """Normalize phone number to format: +countrycode restofnumber"""
        if not phone:
            return ''
        
        # Remove extra spaces
        compact = re.sub(r'\s+', ' ', phone.strip())
        
        # Match country code pattern: +1 to +999 followed by space and rest
        m = re.match(r'^(\+\d{1,3})\s*(.*)$', compact)
        if m:
            cc = m.group(1)
            rest = re.sub(r'\s+', '', m.group(2))
            return f"{cc} {rest}" if rest else cc
        else:
            # No country code, just remove spaces
            return re.sub(r'\s+', '', compact)

    @api.model_create_multi
    def create(self, vals_list):
        """Normalize mobile numbers before creating"""
        for vals in vals_list:
            if 'mobile' in vals and vals['mobile']:
                vals['mobile'] = self._normalize_phone(vals['mobile'])
        return super().create(vals_list)

    def write(self, vals):
        """Normalize mobile number before writing"""
        if 'mobile' in vals and vals['mobile']:
            vals['mobile'] = self._normalize_phone(vals['mobile'])
        return super().write(vals)

    def action_import(self):
        """Open import wizard"""
        action = self.env['ir.actions.actions']._for_xml_id('whatsapp_chat_module.action_whatsapp_mailing_contact_import')
        context = self.env.context.copy()
        if context.get('from_whatsapp_list_ids'):
            action['context'] = {
                **context,
                'default_whatsapp_list_ids': context.get('from_whatsapp_list_ids'),
            }
        return action

