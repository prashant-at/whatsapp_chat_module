# -*- coding: utf-8 -*-

from odoo import api, fields, models


class WhatsAppMailingSubscription(models.Model):
    """Intermediate model between WhatsApp mailing list and WhatsApp mailing contact"""
    _name = 'whatsapp.mailing.subscription'
    _description = 'WhatsApp Mailing List Subscription'
    _table = 'whatsapp_mailing_subscription'
    _rec_name = 'contact_id'
    _order = 'list_id DESC, contact_id DESC'

    contact_id = fields.Many2one(
        'whatsapp.mailing.contact',
        string='Contact',
        ondelete='cascade',
        required=True
    )
    list_id = fields.Many2one(
        'whatsapp.mailing.list',
        string='WhatsApp Mailing List',
        ondelete='cascade',
        required=True
    )

    _sql_constraints = [
        ('unique_contact_list', 'unique (contact_id, list_id)',
         'A WhatsApp mailing contact cannot subscribe to the same mailing list multiple times.')
    ]

