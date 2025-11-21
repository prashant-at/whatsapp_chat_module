# -*- coding: utf-8 -*-

from odoo import fields, models, api, Command, _
from odoo.tools.misc import clean_context
import re
import logging

_logger = logging.getLogger(__name__)


class WhatsAppMailingContactImport(models.TransientModel):
    _name = 'whatsapp.mailing.contact.import'
    _description = 'WhatsApp Mailing Contact Import'

    whatsapp_list_ids = fields.Many2many('whatsapp.mailing.list', string='WhatsApp Lists')
    contact_list = fields.Text('Contact List', help='Contact list that will be imported, one contact per line. Format: "Name +1234567890" or just "+1234567890"')

    def _parse_phone_contact(self, line):
        """Parse a line to extract name and phone number
        Formats supported:
        - "Name +1234567890"
        - "+1234567890"
        - "Name +91 8156234543"
        """
        line = line.strip()
        if not line:
            return None, None
        
        # Try to match: "Name +phone" or "Name +phone with spaces"
        match = re.match(r'^(.+?)\s+(\+\d[\d\s]*)$', line)
        if match:
            name = match.group(1).strip().strip('"\'')
            phone = match.group(2).strip()
            return name, phone
        
        # Try to match: just phone number starting with +
        match = re.match(r'^(\+\d[\d\s]*)$', line)
        if match:
            phone = match.group(1).strip()
            return phone, phone  # Use phone as name if no name provided
        
        # If no + found, might be just digits - treat as phone
        if re.match(r'^[\d\s]+$', line):
            return line, line
        
        return None, None

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

    def action_import(self):
        """Import each line of "contact_list" as a new contact."""
        self.ensure_one()
        
        if not self.contact_list:
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'message': _('Please enter contact list.'),
                    'next': {'type': 'ir.actions.act_window_close'},
                    'sticky': False,
                    'type': 'warning',
                }
            }
        
        # Parse contacts from text
        lines = [line.strip() for line in self.contact_list.splitlines() if line.strip()]
        contacts = []
        for line in lines:
            name, phone = self._parse_phone_contact(line)
            if phone:
                phone = self._normalize_phone(phone)
                if phone:
                    contacts.append((name or phone, phone))
        
        if not contacts:
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'message': _('No valid phone numbers found. Format: "Name +1234567890" or "+1234567890"'),
                    'next': {'type': 'ir.actions.act_window_close'},
                    'sticky': False,
                    'type': 'warning',
                }
            }

        if len(contacts) > 5000:
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'message': _('You have too many contacts, please upload a file.'),
                    'type': 'warning',
                    'sticky': False,
                    'next': self.action_open_base_import(),
                }
            }

        all_phones = list({phone for _, phone in contacts})

        existing_contacts = self.env['whatsapp.mailing.contact'].search([
            ('mobile', 'in', all_phones),
        ])
        existing_contacts = {
            contact.mobile: contact
            for contact in existing_contacts
        }

        # Remove duplicated records, keep only the first non-empty name for each phone
        unique_contacts = {}
        for name, phone in contacts:
            if unique_contacts.get(phone, {}).get('name'):
                continue

            if phone in existing_contacts:
                # Add to lists if not already in them
                existing_contact = existing_contacts[phone]
                if self.whatsapp_list_ids:
                    existing_contact.list_ids |= self.whatsapp_list_ids
            else:
                unique_contacts[phone] = {
                    'name': name,
                    'subscription_ids': [
                        Command.create({'list_id': mailing_list_id.id})
                        for mailing_list_id in self.whatsapp_list_ids
                    ],
                }

        if not unique_contacts:
            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'message': _('No contacts were imported. All phone numbers are already in the selected lists.'),
                    'next': {'type': 'ir.actions.act_window_close'},
                    'sticky': False,
                    'type': 'warning',
                }
            }

        new_contacts = self.env['whatsapp.mailing.contact'].with_context(clean_context(self.env.context)).create([
            {
                'mobile': phone,
                **values,
            }
            for phone, values in unique_contacts.items()
        ])

        ignored = len(contacts) - len(unique_contacts)

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'message': (
                    _('%i Contacts have been imported.', len(unique_contacts))
                    + (_(' %i duplicates have been ignored.', ignored) if ignored else '')
                ),
                'type': 'success',
                'sticky': False,
                'next': {
                    'context': self.env.context,
                    'domain': [('id', 'in', new_contacts.ids)],
                    'name': _('New contacts imported'),
                    'res_model': 'whatsapp.mailing.contact',
                    'type': 'ir.actions.act_window',
                    'view_mode': 'list',
                    'views': [[False, 'list'], [False, 'form']],
                },
            }
        }

    def action_open_base_import(self):
        """Open the base import wizard to import WhatsApp mailing contacts with a file."""
        self.ensure_one()

        context = self.env.context.copy()
        if self.whatsapp_list_ids:
            context['default_list_ids'] = self.whatsapp_list_ids.ids
        return {
            'type': 'ir.actions.client',
            'tag': 'import',
            'name': _('Import WhatsApp Mailing Contacts'),
            'params': {
                'context': context,
                'model': 'whatsapp.mailing.contact',
            }
        }

    @api.model
    def get_import_templates(self):
        return [{
            'label': _('Import Template for WhatsApp Mailing List Contacts'),
            'template': '/whatsapp_chat_module/static/xls/whatsapp_mailing_contact.xls'
        }]

