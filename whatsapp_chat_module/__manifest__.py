{
    'name': "WhatsApp Chat Module",
    'summary': "Complete WhatsApp integration for your business - chat with customers, send marketing campaigns, and manage conversations all from Odoo",
    'description': """
WhatsApp Chat Module
===================

Connect your business with customers through WhatsApp directly from Odoo. Send messages, manage conversations, run marketing campaigns, and stay in touch with your contacts - all in one place.

What You Can Do:
----------------

* **Chat with Customers**
    - Send and receive WhatsApp messages instantly
    - View all your conversations in one place
    - Share photos, documents, and files
    - Use emojis to make conversations more engaging
    - See message history and chat with multiple contacts

* **Send Marketing Campaigns**
    - Create campaigns to reach many customers at once
    - Organize contacts into mailing lists
    - Schedule messages to be sent automatically
    - Track which messages were sent successfully
    - Import contacts from spreadsheets easily

* **Use Message Templates**
    - Save frequently used messages as templates
    - Personalize messages with customer names and details
    - Add attachments to templates
    - Reuse templates for faster messaging

* **Manage Contacts**
    - Organize WhatsApp contacts into lists
    - Import contacts from files
    - Group contacts for targeted campaigns
    - Keep track of who you've contacted

* **Connect Multiple WhatsApp Accounts**
    - Set up multiple WhatsApp numbers
    - Choose which number to use for each message
    - Control who can use each WhatsApp connection
    - See connection status at a glance

* **Work with Your Business Data**
    - Create sales leads from incoming WhatsApp messages
    - Link messages to your sales orders and invoices
    - See WhatsApp messages in your document history
    - Keep all customer communication in one place

* **Stay Secure**
    - Control who can send messages
    - Set different access levels for team members
    - Keep your WhatsApp connections secure
    - Manage permissions easily

* **Easy Setup**
    - Connect your WhatsApp by scanning a QR code
    - Simple setup process
    - Automatic connection management
    - Get started in minutes

Perfect for businesses that want to:
- Communicate with customers on WhatsApp
- Send promotional messages and updates
- Provide customer support via chat
- Keep all customer conversations organized
- Integrate WhatsApp with their existing business processes
    """,
    'author': "anansi llp",
    'website': "anansitech.in",
    'license': 'LGPL-3',
    'category': 'WhatsApp',
    'version': '1.0.0',
    'depends': ['base', 'web', 'mail', 'mass_mailing', 'sale', 'purchase', 'stock', 'account', 'crm'],
    'data': [
            'security/whatsapp_groups.xml',
            'security/ir.model.access.csv',
            'security/whatsapp_connection_security.xml',
            'data/mail_subtype_data.xml',
            'data/whatsapp_connection_data.xml',
            'data/whatsapp_config_parameters.xml',
            'views/connection_views.xml',
            'views/whatsapp_action.xml',
            'views/whatsapp_template_views.xml',
            'views/whatsapp_marketing_campaign_views.xml',
            'views/whatsapp_mailing_contact_views.xml',
            'views/whatsapp_mailing_list_views.xml',
            'views/whatsapp_mailing_contact_import_views.xml',
            'views/res_users_views.xml',
            'wizard/whatsapp_compose_views.xml',
            'wizard/whatsapp_qr_popup_views.xml',
            'views/whatsapp_buttons.xml',
            'views/menu_views.xml',
        ],
    "assets": {
    "web.assets_backend": [
        "whatsapp_chat_module/static/src/css/contacts_popup.css",
        "whatsapp_chat_module/static/lib/emoji-mart/emoji-mart-bundle.js",
        "whatsapp_chat_module/static/src/js/socket_service.js",
        "whatsapp_chat_module/static/src/js/socket_initializer.js",
        "whatsapp_chat_module/static/src/js/whatsapp_web_client_action.js",
        "whatsapp_chat_module/static/src/js/close_qr.js",
        "whatsapp_chat_module/static/src/xml/whatsapp_templates.xml",
    ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
    'external_dependencies': {
        'python': [
            'requests',
            'beautifulsoup4',
            'html2text',
        ],
    },
}
