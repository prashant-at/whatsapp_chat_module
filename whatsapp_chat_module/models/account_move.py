# -*- coding: utf-8 -*-

from odoo import models, api


class AccountMove(models.Model):
    _inherit = 'account.move'

    def _find_whatsapp_template(self):
        """Get the appropriate WhatsApp template for the current invoice/bill based on its state and type.

        :return: The correct WhatsApp template based on the current status
        :rtype: record of `whatsapp.template` or `None` if not found
        """
        self.ensure_one()
        
        # Search for templates matching the model
        templates = self.env['whatsapp.template'].search([
            ('model', '=', 'account.move')
        ])
        
        if not templates:
            return None
        
        # Check state and match template by name pattern
        if self.state == 'posted':
            # Posted invoice - look for "invoice", "posted", "sent"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['invoice', 'posted', 'sent', 'bill']):
                    return template
        elif self.state == 'draft':
            # Draft - look for "draft"
            for template in templates:
                name_lower = template.name.lower()
                if 'draft' in name_lower:
                    return template
        elif self.state == 'cancel':
            # Cancelled - look for "cancellation", "cancel"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['cancellation', 'cancel']):
                    return template
        
        # Fallback: return first template found
        return templates[0] if templates else None

