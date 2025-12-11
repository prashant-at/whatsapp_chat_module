# -*- coding: utf-8 -*-
from odoo import api, fields, models
import logging
import re

_logger = logging.getLogger(__name__)


class WhatsAppMailingSubscription(models.Model):
    """Intermediate model between WhatsApp mailing list and WhatsApp mailing contact"""
    _name = 'whatsapp.mailing.subscription'
    _description = 'WhatsApp Mailing List Subscription'
    _table = 'whatsapp_mailing_subscription'
    _rec_name = 'contact_id'
    _order = 'list_id DESC, contact_id DESC'
    _auto = True

    contact_id = fields.Many2one(
        'whatsapp.mailing.contact',
        string='Contact',
        ondelete='cascade',
        required=True,
        index=True,
    )
    list_id = fields.Many2one(
        'whatsapp.mailing.list',
        string='WhatsApp Mailing List',
        ondelete='cascade',
        required=True,
        index=True,
    )

    _sql_constraints = [
        ('unique_contact_list', 'unique (contact_id, list_id)',
         'A WhatsApp mailing contact cannot subscribe to the same mailing list multiple times.')
    ]

    # def init(self):
    #     """Override init to ensure table has id column"""
    #     super().init()
        
    #     # Check if table exists and if it has id column
    #     self.env.cr.execute("""
    #         SELECT column_name 
    #         FROM information_schema.columns 
    #         WHERE table_name = 'whatsapp_mailing_subscription' 
    #         AND column_name = 'id'
    #     """)
        
    #     has_id_column = self.env.cr.fetchone()
        
    #     if not has_id_column:
    #         _logger.info("Fixing whatsapp_mailing_subscription table: adding id column")
    #         try:
    #             # Drop existing primary key if it exists (might be composite on contact_id, list_id)
    #             self.env.cr.execute("""
    #                 SELECT constraint_name 
    #                 FROM information_schema.table_constraints 
    #                 WHERE table_name = 'whatsapp_mailing_subscription' 
    #                 AND constraint_type = 'PRIMARY KEY'
    #             """)
    #             pk_constraint = self.env.cr.fetchone()
    #             if pk_constraint:
    #                 constraint_name = pk_constraint[0]
    #                 # Validate constraint name to prevent SQL injection
    #                 # Constraint names should only contain alphanumeric characters and underscores
    #                 if not re.match(r'^[a-zA-Z0-9_]+$', constraint_name):
    #                     _logger.error(f"Invalid constraint name format: {constraint_name}")
    #                     raise ValueError(f"Invalid constraint name format: {constraint_name}")
    #                 # Use parameterized query for safety
    #                 self.env.cr.execute(
    #                     "ALTER TABLE whatsapp_mailing_subscription DROP CONSTRAINT %s",
    #                     (constraint_name,)
    #                 )
                
    #             # Add id column
    #             self.env.cr.execute("ALTER TABLE whatsapp_mailing_subscription ADD COLUMN id SERIAL")
                
    #             # Make id the primary key
    #             self.env.cr.execute("ALTER TABLE whatsapp_mailing_subscription ADD PRIMARY KEY (id)")
                
    #             # Ensure unique constraint exists
    #             self.env.cr.execute("""
    #                 SELECT constraint_name 
    #                 FROM information_schema.table_constraints 
    #                 WHERE table_name = 'whatsapp_mailing_subscription' 
    #                 AND constraint_name = 'unique_contact_list'
    #             """)
    #             if not self.env.cr.fetchone():
    #                 self.env.cr.execute("""
    #                     ALTER TABLE whatsapp_mailing_subscription 
    #                     ADD CONSTRAINT unique_contact_list UNIQUE (contact_id, list_id)
    #                 """)
                
    #             self.env.cr.commit()
    #             _logger.info("Successfully fixed whatsapp_mailing_subscription table")
    #         except Exception as e:
    #             _logger.error(f"Error fixing whatsapp_mailing_subscription table: {e}")
    #             self.env.cr.rollback()

