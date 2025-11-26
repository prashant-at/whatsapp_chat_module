# -*- coding: utf-8 -*-

from odoo import http, fields
from odoo.http import request
import requests
import json
import logging
from datetime import timedelta

_logger = logging.getLogger(__name__)


class WhatsAppController(http.Controller):
    
    # Base URL for your Node.js service
    # NODE_SERVICE_URL = 'http://localhost:3000'  # Update this to your Node.js service URL
    @classmethod
    def _get_backend_url(cls):
        """Get backend URL from system parameter"""
        return request.env['ir.config_parameter'].sudo().get_param(
            'whatsapp_chat_module.backend_api_url',
            'http://localhost:3000'
        )

    @http.route('/whatsapp/create_lead_action', type='json', auth='user' , csrf=True)
    def create_lead_action(self, **payload):
        """Return an action that opens the CRM lead form prefilled with WhatsApp data"""
        message_direction = payload.get('message_direction')
        if message_direction and message_direction != 'inbound':
            return {'error': 'Leads can only be created from inbound messages.'}

        contact_name = (payload.get('contact_name') or '').strip()
        contact_phone = (payload.get('contact_phone') or '').strip()
        message_content = (payload.get('message_content') or '').strip()
        message_id = payload.get('message_id')
        conversation_id = payload.get('conversation_id')
        timestamp = payload.get('timestamp')

        # Fallback values
        if message_content:
            lead_name = message_content.splitlines()[0]
        elif contact_name:
            lead_name = contact_name
        else:
            lead_name = "New WhatsApp Lead"
        lead_name = (lead_name or "New WhatsApp Lead")[:64]

        description_lines = []
        if message_content:
            description_lines.append(message_content)
        if timestamp:
            description_lines.append(f"Received at: {timestamp}")
        if conversation_id:
            description_lines.append(f"Conversation: {conversation_id}")
        if message_id:
            description_lines.append(f"Message ID: {message_id}")
        description = "\n".join(description_lines) if description_lines else False

        context = dict(request.env.context)
        context.update({
            'default_name': lead_name,
            'default_contact_name': contact_name or False,
            # 'default_partner_name': contact_name or False,
            # 'default_phone': contact_phone or False,
            'default_mobile': contact_phone or False,
            'default_description': description,
            'default_referred': 'WhatsApp',
        })

        # Include metadata so it can be stored on the lead if custom fields exist
        if message_id:
            context['default_x_whatsapp_message_id'] = message_id
        if conversation_id:
            context['default_x_whatsapp_conversation_id'] = conversation_id

        action = {
            'type': 'ir.actions.act_window',
            'name': 'New Lead',
            'res_model': 'crm.lead',
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
            'context': context,
        }
        return action