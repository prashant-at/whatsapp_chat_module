# -*- coding: utf-8 -*-

from odoo import models, api


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    def _find_whatsapp_template(self):
        """Get the appropriate WhatsApp template for the current sales order based on its state.

        If the SO is confirmed, we return the WhatsApp template for the sale confirmation.
        Otherwise, we return the quotation WhatsApp template.

        :return: The correct WhatsApp template based on the current status
        :rtype: record of `whatsapp.template` or `None` if not found
        """
        self.ensure_one()
        
        # Search for templates matching the model
        templates = self.env['whatsapp.template'].search([
            ('model', '=', 'sale.order')
        ])
        
        if not templates:
            return None
        
        # Check state and match template by name pattern
        if self.state == 'sale':
            # Confirmed order - look for "confirmation", "sale order", "order confirmation"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['confirmation', 'sale order', 'order confirmation', 'confirmed']):
                    return template
        elif self.state in ('draft', 'sent'):
            # Quotation - look for "quotation", "quote"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['quotation', 'quote']):
                    return template
        elif self.state == 'cancel':
            # Cancelled - look for "cancellation", "cancel"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['cancellation', 'cancel']):
                    return template
        
        # Fallback: return first template found
        return templates[0] if templates else None

