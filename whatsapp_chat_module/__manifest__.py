{
    'name': "WhatsApp Chat Module",
    'summary': "WhatsApp chat management with connection, request/response, and chatting screens",
    'description': """
        WhatsApp Chat Module
        - Connection screen for API configuration
        - Request/Response screen for API calls tracking
        - Chatting screen for active chats management
    """,
    'author': "Anansi Tech",
    'website': "Anansitech.in",
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
            'views/connection_views.xml',
            # 'views/request_response_views.xml',
            # 'views/whatsapp_message_views.xml',
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
            # 'views/whatsapp_web_template.xml',
            'views/menu_views.xml',
        ],
    "assets": {
    "web.assets_backend": [
        "whatsapp_chat_module/static/src/css/contacts_popup.css",
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
}
