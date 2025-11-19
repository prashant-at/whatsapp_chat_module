# -*- coding: utf-8 -*-

from odoo import models, api


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    def _find_whatsapp_template(self):
        """Get the appropriate WhatsApp template for the current stock picking based on its state.

        :return: The correct WhatsApp template based on the current status
        :rtype: record of `whatsapp.template` or `None` if not found
        """
        self.ensure_one()
        
        # Search for templates matching the model
        templates = self.env['whatsapp.template'].search([
            ('model', '=', 'stock.picking')
        ])
        
        if not templates:
            return None
        
        # Check state and match template by name pattern
        if self.state == 'done':
            # Done - look for "delivery", "done", "completed"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['delivery', 'done', 'completed', 'picking']):
                    return template
        elif self.state in ('draft', 'waiting', 'confirmed', 'assigned'):
            # In progress - look for "picking", "preparation"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['picking', 'preparation', 'prepared']):
                    return template
        elif self.state == 'cancel':
            # Cancelled - look for "cancellation", "cancel"
            for template in templates:
                name_lower = template.name.lower()
                if any(keyword in name_lower for keyword in ['cancellation', 'cancel']):
                    return template
        
        # Fallback: return first template found
        return templates[0] if templates else None

