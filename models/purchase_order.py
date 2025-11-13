# -*- coding: utf-8 -*-

from odoo import models, api


class PurchaseOrder(models.Model):
    _inherit = 'purchase.order'

    def _find_whatsapp_template(self):
        """Get the appropriate WhatsApp template for the current purchase order based on its state.

        :return: The correct WhatsApp template based on the current status
        :rtype: record of `whatsapp.template` or `None` if not found
        """
        self.ensure_one()
        
        # Search for templates matching the model
        templates = self.env['whatsapp.template'].search([
            ('model', '=', 'purchase.order')
        ])
        
        if not templates:
            return None
        
        # Check state and match template by name pattern
        if self.state in ('purchase', 'done'):
            # Confirmed/RFQ - look for "purchase order", "po", "confirmed"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['purchase order', 'po', 'confirmed', 'rfq']):
                    return template
        elif self.state == 'draft':
            # Draft - look for "draft", "rfq"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['draft', 'rfq']):
                    return template
        elif self.state == 'cancel':
            # Cancelled - look for "cancellation", "cancel"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['cancellation', 'cancel']):
                    return template
        
        # Fallback: return first template found
        return templates[0] if templates else None

