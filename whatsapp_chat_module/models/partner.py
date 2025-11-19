from odoo import models, fields, api

class ResPartner(models.Model):
    _inherit = 'res.partner'
    
    def _compute_display_name(self):
        """Override _compute_display_name to show mobile numbers only in WhatsApp Chat context"""
        # Call the original method first
        super()._compute_display_name()

        # Restrict to our module's explicit context only
        context = self.env.context or {}
        is_whatsapp_chat_context = (
            context.get('whatsapp_chat') is True or
            context.get('active_model') == 'whatsapp.chat.simple.wizard' or
            context.get('default_model') == 'whatsapp.chat.simple.wizard' or
            context.get('force_mobile_display') is True or
            context.get('show_mobile') is True
        )

        if not is_whatsapp_chat_context:
            return

        # Modify the display_name to include mobile numbers
        for partner in self:
            mobile = partner.mobile
            if mobile:
                partner.display_name = f"{partner.display_name} ({mobile})"
            else:
                partner.display_name = f"{partner.display_name} (No mobile)"
