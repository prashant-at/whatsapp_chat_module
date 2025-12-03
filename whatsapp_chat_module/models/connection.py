from odoo import models, fields, api, _
from odoo.exceptions import ValidationError, UserError
import requests
import logging
from datetime import timedelta

_logger = logging.getLogger(__name__)


class WhatsAppConnection(models.Model):
    _name = 'whatsapp.connection'
    _description = 'WhatsApp Connection'

    name = fields.Char(string='Connection Name')
    from_field = fields.Char(string='From')
    api_key = fields.Char(string='API Key', password=True)
    authorized_person_ids = fields.Many2many('res.users', string='Authorized Persons', required=False,
                                            help="Users authorized to use this connection")
    authorized_person_names = fields.Char(string='Authorized Persons', compute='_compute_authorized_person_names', store=False)
    is_default = fields.Boolean(string='Default Connection', default=False, 
                               help="Set this connection as the default for WhatsApp messages")
    user_default_ids = fields.Many2many(
        'res.users',
        'whatsapp_connection_user_default_rel',
        'connection_id',
        'user_id',
        string='Users with this as default',
        compute='_compute_user_default_ids',
        store=True,
        help="Users who have this connection as their default"
    )
    socket_connection_ready = fields.Boolean(
        default=False,
        string="Socket Connected",
        help="Flag set by frontend when socket connection is established"
    )

    @api.model
    def get_backend_api_url(self):
        """Get backend API URL from system parameter or default"""
        return self.env['ir.config_parameter'].sudo().get_param(
            'whatsapp_chat_module.backend_api_url',
            'http://localhost:3000'
        )

    @api.constrains('is_default')
    def _check_default_connection(self):
        """Ensure only one default connection exists"""
        for record in self:
            if record.is_default:
                # Check if there's already another default connection
                existing_default = self.search([
                    ('is_default', '=', True),
                    ('id', '!=', record.id)
                ])
                if existing_default:
                    raise ValidationError(
                        f"Connection '{existing_default.name}' is already set as default. "
                        f"Only one default connection is allowed."
                    )

    @api.model
    def create(self, vals):
        """Handle default connection creation and authorization"""
        if vals.get('is_default'):
            # Unset other default connections
            self.search([('is_default', '=', True)]).write({'is_default': False})
        
        # If creator is not admin and authorized_person_ids not set, add creator to authorized_person_ids
        if not self.env.user.has_group('whatsapp_chat_module.group_whatsapp_admin'):
            if 'authorized_person_ids' not in vals or not vals.get('authorized_person_ids'):
                # Add creator to authorized_person_ids
                if 'authorized_person_ids' not in vals:
                    vals['authorized_person_ids'] = [(6, 0, [self.env.user.id])]
                elif isinstance(vals.get('authorized_person_ids'), list):
                    # Check if user is already in the list
                    user_ids = []
                    for item in vals['authorized_person_ids']:
                        if isinstance(item, (list, tuple)) and len(item) >= 3:
                            if item[0] == 6:  # (6, 0, [ids])
                                user_ids = item[2]
                            elif item[0] == 4:  # (4, id)
                                user_ids.append(item[1])
                    if self.env.user.id not in user_ids:
                        if vals['authorized_person_ids'] and isinstance(vals['authorized_person_ids'][0], (list, tuple)) and vals['authorized_person_ids'][0][0] == 6:
                            # Replace the list
                            user_ids.append(self.env.user.id)
                            vals['authorized_person_ids'] = [(6, 0, user_ids)]
                        else:
                            # Append to list
                            vals['authorized_person_ids'].append((4, self.env.user.id))
        
        return super().create(vals)

    def write(self, vals):
        """Handle default connection updates + clear invalid user defaults"""
        # Keep old authorized persons (before write)
        old_auth_map = {rec.id: rec.authorized_person_ids.ids for rec in self}
        res = super().write(vals)
        # --- 1. Handle global default toggle ---
        if vals.get('is_default'):
            # Unset other defaults (exclude records being written)
            self.search([
                ('is_default', '=', True),
                ('id', 'not in', self.ids)  # Handle recordset case
            ]).write({'is_default': False})
        # --- 2. Clear user defaults if they were removed from authorized_person_ids ---
        if 'authorized_person_ids' in vals:
            for connection in self:
                old_users = set(old_auth_map.get(connection.id, []))
                new_users = set(connection.authorized_person_ids.ids)
                # Users removed
                removed_users = old_users - new_users
                if removed_users:
                    users = self.env['res.users'].browse(list(removed_users))
                    # Clear their default connection if set to this
                    users.filtered(
                        lambda u: u.whatsapp_default_connection_id.id == connection.id
                    ).write({
                        'whatsapp_default_connection_id': False
                    })
        return res

    @api.model
    def get_default_connection(self):
        """Get the default connection that user is authorized for"""
        user = self.env.user
        
        # First, check if user has a specific default connection set
        if user.whatsapp_default_connection_id:
            user_default = user.whatsapp_default_connection_id
            # Verify user is authorized for this connection
            if user_default._check_authorization():
                return user_default
        
        # Get authorized connections domain
        domain = self._get_authorized_connection_domain()
        
        # Fallback to global default connection
        default_connection = self.search(domain + [('is_default', '=', True)], limit=1)
        if not default_connection:
            # Final fallback to first available authorized connection
            default_connection = self.search(domain, limit=1)
        return default_connection
    
    @api.model
    def _get_authorized_connection_domain(self):
        """Get domain for connections user is authorized to access"""
        user = self.env.user
        if user.has_group('whatsapp_chat_module.group_whatsapp_admin'):
            # Administrators can see all connections
            return []
        # Regular users can only see connections where they are authorized
        # Empty authorized_person_ids connections are only accessible to administrators
        return [('authorized_person_ids', 'in', [user.id])]
    
    def _check_authorization(self):
        """Check if current user is authorized for this connection"""
        self.ensure_one()
        if self.env.user.has_group('whatsapp_chat_module.group_whatsapp_admin'):
            return True  # Admins always authorized
        if not self.authorized_person_ids:
            return False  # Empty means only admins
        return self.env.user in self.authorized_person_ids
    
    @api.depends('authorized_person_ids')
    def _compute_authorized_person_names(self):
        """Compute comma-separated list of authorized person names"""
        for record in self:
            if record.authorized_person_ids:
                record.authorized_person_names = ', '.join(record.authorized_person_ids.mapped('name'))
            else:
                record.authorized_person_names = 'No one'

    def _compute_user_default_ids(self):
        """Find all users who have this connection as default"""
        for record in self:
            users = self.env['res.users'].search([
                ('whatsapp_default_connection_id', '=', record.id)
            ])
            record.user_default_ids = users

    @api.model
    def init_user_default_ids(self):
        """Initialize user_default_ids for all connections - useful after module upgrade"""
        all_connections = self.search([])
        if all_connections:
            all_connections._compute_user_default_ids()
            _logger.info(f"[Connection] Initialized user_default_ids for {len(all_connections)} connections")
        return True

    def set_as_default(self):
        """Set this connection as the default connection"""
        self.ensure_one()
        # Unset other default connections
        self.search([('is_default', '=', True)]).write({'is_default': False})
        # Set this one as default
        self.write({'is_default': True})
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'Default Connection Updated',
                'message': f'Connection "{self.name}" has been set as the default.',
                'type': 'success',
                'sticky': False,
            }
        }

    def _get_mail_thread_data(self, request_list):
        """Implement mail thread data for WhatsApp connections"""
        return {
            'id': self.id,
            'name': self.name,
            'model': self._name,
            'res_id': self.id,
            'thread_type': 'document',
        }

    def _compute_display_name(self):
        """Override _compute_display_name to show phone numbers and default status"""
        # Call the original method first
        super()._compute_display_name()

        # Modify the display_name to include phone numbers and default status
        for record in self:
            display_parts = [str(record.display_name or '')]
            
            if record.from_field:
                display_parts.append(f"({record.from_field})")
            else:
                display_parts.append("(No phone)")
                
            if record.is_default:
                display_parts.append("Default")
                
            record.display_name = " ".join(display_parts)

    def action_connect_whatsapp(self):
        """Connect WhatsApp by calling /api/whatsapp/qr endpoint and establish socket connection FIRST"""
        self.ensure_one()
        
        # Check authorization
        if not self._check_authorization():
            raise UserError(_("You are not authorized to use this connection."))
        
        if not self.api_key or not self.from_field:
            raise UserError(_("API Key and Phone Number are required for connection."))
        
       
        
        # Get origin from request (for socket matching)
        origin = '127.0.0.1'  # Default
        try:
            from odoo import http
            request = http.request
            if request and hasattr(request, 'httprequest'):
                origin = request.httprequest.headers.get('Origin') or \
                         request.httprequest.headers.get('Host') or \
                         origin
        except:
            pass
        
        # STEP 1: Trigger socket connection FIRST (before REST call)
        # This ensures socket is ready to receive QR updates
        _logger.info(f"[Connection] Step 1: Triggering socket connection for {self.name}")
        self._trigger_socket_connection(origin)
        
        # Clear ready flag and commit so frontend can set it
        self.socket_connection_ready = False
        self.env.cr.commit()
        
        # Wait for frontend confirmation that socket is connected (max 3 seconds)
        import time
        max_wait = 3
        check_interval = 0.1
        waited = 0
        
        _logger.info(f"[Connection] Waiting for socket connection confirmation...")
        
        # Use a fresh cursor to read the updated value
        socket_confirmed = False
        while waited < max_wait:
            # Create new env to bypass cache
            fresh_env = self.env(cr=self.env.cr)
            fresh_record = fresh_env['whatsapp.connection'].browse(self.id)
            fresh_record.invalidate_recordset(['socket_connection_ready'])
            
            if fresh_record.socket_connection_ready:
                socket_confirmed = True
                _logger.info(f"[Connection] Socket confirmed connected after {waited:.1f}s")
                break
            time.sleep(check_interval)
            waited += check_interval
        
        if not socket_confirmed:
            _logger.warning(f"[Connection] Socket not confirmed within {max_wait}s, proceeding anyway")
        
        # STEP 2: Make REST call (socket should be connected by now)
        api_url = self.get_backend_api_url() + "/api/qr-code"
        
        headers = {
            'x-api-key': self.api_key.strip(),
            'x-phone-number': self.from_field.strip(),
            'origin': origin,
            'Content-Type': 'application/json'
        }
        
        _logger.info(f"[Connection] Step 2: Making REST call for {self.name}")
        # Security: Don't log sensitive information like API keys, phone numbers, or full URLs
        # _logger.info(f"[Connection] API URL: {api_url}")  # Removed for security
        # _logger.info(f"[Connection] Phone: {self.from_field}")  # Removed for security
        
        try:
            response = requests.get(api_url, headers=headers)
            
            _logger.info(f"[Connection] API Response Status: {response.status_code}")
            
            result = response.json() if response.content else {}
            # Security: Don't log full response which might contain sensitive data
            _logger.debug(f"[Connection] API Response received (status: {response.status_code})")
            
            if response.status_code == 200:
                # Client is already connected
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('WhatsApp Connected'),
                        'message': _('WhatsApp is already connected for "%s".') % self.name,
                        'type': 'success',
                        'sticky': False,
                    }
                }
            
            elif response.status_code == 201:
                # QR code flow initiated - socket should be connecting/connected by now
                _logger.info(f"[Connection] Step 3: Creating QR popup (socket should be ready)")
                
              
                
                # Check if QR code is in response (initial QR from REST)
                qr_code = result.get('qrCode') or result.get('data', {}).get('qrCode') if isinstance(result.get('data'), dict) else None
                
                # Create QR popup record
                popup_vals = {
                    'from_number': self.from_field,
                    'from_name': self.name,
                    'api_key': self.api_key,
                    'phone_number': self.from_field,
                    'message': result.get('message', 'Please scan the QR code with WhatsApp to connect.'),
                    # 'qr_expires_at': fields.Datetime.now() + timedelta(seconds=120),
                    # 'countdown_seconds': 120,
                    # 'is_expired': False,
                }
                
                # # If QR code is in response, include it (initial QR from REST)
                # if qr_code:
                #     if not qr_code.startswith('data:image'):
                #         qr_code = f"data:image/png;base64,{qr_code}"
                #     popup_vals['qr_code_image'] = qr_code
                #     popup_vals['qr_code_filename'] = 'whatsapp_qr_code.png'
                #     popup_vals['last_qr_string'] = qr_code[:100]
                
                # popup = self.env['whatsapp.qr.popup'].create(popup_vals)
                # _logger.info(f"[Connection] Created QR popup ID: {popup.id}")
                # _logger.info(f"[Connection] Socket should be connected and ready to receive QR updates")
                
                # Return action to open popup
                return {
                    'type': 'ir.actions.act_window',
                    'name': _('WhatsApp Connection - Scan QR Code'),
                    'res_model': 'whatsapp.qr.popup',
                    # 'res_id': popup.id,
                    'view_mode': 'form',
                    'view_id': self.env.ref('whatsapp_chat_module.whatsapp_qr_popup_view').id,
                    'target': 'new',
                    'context': {
                        'connection_id': self.id,
                        'connection_name': self.name,
                    }
                }
            
            else:
                # Error response
                error_msg = result.get('message') or result.get('error') or _('Unknown error')
                raise UserError(_("Failed to connect WhatsApp: %s") % error_msg)
                
        except requests.exceptions.Timeout:
            _logger.error(f"[Connection] API timeout for: {self.name}")
            raise UserError(_("Connection timeout. Please try again."))
        except requests.exceptions.RequestException as e:
            _logger.error(f"[Connection] API error for {self.name}: {e}")
            raise UserError(_("Failed to connect to WhatsApp API: %s") % str(e))
        except Exception as e:
            _logger.error(f"[Connection] Unexpected error for {self.name}: {e}")
            raise UserError(_("Unexpected error: %s") % str(e))

    def _trigger_socket_connection(self, origin):
        """Send bus notification to trigger frontend socket connection BEFORE QR popup"""
        self.ensure_one()
        
        current_user = self.env.user
        if not current_user or not current_user.partner_id:
            _logger.warning(f"[Connection] No partner_id found for user: {current_user}")
            return
        
        # Prepare socket connection payload
        payload = {
            'action': 'connect_socket',
            'connection_id': self.id,
            'connection_name': self.name,
            'api_key': self.api_key,
            'phone_number': self.from_field,
            'origin': origin,
            'priority': 'high',  # High priority - connect before QR popup
        }
        
        # Send bus notification to user's partner channel
        # Frontend will receive this and connect/reconnect socket
        try:
            self.env['bus.bus']._sendone(
                current_user.partner_id,
                'whatsapp_connect_socket',
                payload
            )
            _logger.info(f"[Connection] Socket connection triggered for {self.name} (ID: {self.id})")
        except Exception as e:
            _logger.error(f"[Connection] Failed to send bus notification: {e}")
    
    def confirm_socket_connected(self):
        """Called by frontend when socket is connected - releases the wait lock"""
        self.ensure_one()
        if not self._check_authorization():
            raise UserError(_("You are not authorized to use this connection."))
        
        # Don't use sudo() - authorization already checked above
        # Force commit to make it visible immediately
        self.socket_connection_ready = True
        self.env.cr.commit()  # Commit immediately so Python can see it
        _logger.info(f"[Connection] Socket connection confirmed for {self.name} (ID: {self.id})")