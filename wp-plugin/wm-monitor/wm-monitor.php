<?php
/**
 * Plugin Name:       Webmarketers Monitoring
 * Plugin URI:        https://webmarketers.ca
 * Description:       Contact form testing & site health endpoint for Webmarketers Monitoring dashboard. Works with Gravity Forms and Post SMTP.
 * Version:           1.0.0
 * Author:            WebMarketers
 * Author URI:        https://webmarketers.ca
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Text Domain:       wm-monitor
 */

defined( 'ABSPATH' ) || exit;

define( 'WM_MONITOR_VERSION', '1.0.0' );
define( 'WM_MONITOR_FILE',    __FILE__ );

// ── REST API ──────────────────────────────────────────────────────────────────
add_action( 'rest_api_init', 'wm_monitor_register_routes' );

function wm_monitor_register_routes() {
    register_rest_route( 'wm-monitor/v1', '/ping', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'wm_monitor_ping',
        'permission_callback' => 'wm_monitor_verify_key',
    ] );

    register_rest_route( 'wm-monitor/v1', '/test-form', [
        'methods'             => WP_REST_Server::CREATABLE,
        'callback'            => 'wm_monitor_test_form',
        'permission_callback' => 'wm_monitor_verify_key',
        'args'                => [
            'form_id'    => [ 'type' => 'integer', 'default' => 1 ],
            'test_email' => [ 'type' => 'string',  'default' => '' ],
        ],
    ] );
}

/**
 * Authenticate request using X-WM-Monitor-Key header.
 */
function wm_monitor_verify_key( WP_REST_Request $request ) {
    $provided = $request->get_header( 'X-WM-Monitor-Key' );
    $stored   = get_option( 'wm_monitor_secret_key', '' );

    if ( ! $provided || ! $stored ) {
        return new WP_Error( 'unauthorized', 'Missing or invalid monitor key.', [ 'status' => 401 ] );
    }

    if ( ! hash_equals( $stored, $provided ) ) {
        return new WP_Error( 'unauthorized', 'Invalid monitor key.', [ 'status' => 401 ] );
    }

    return true;
}

/**
 * GET /wp-json/wm-monitor/v1/ping
 * Returns site health info.
 */
function wm_monitor_ping( WP_REST_Request $request ) {
    return rest_ensure_response( [
        'status'        => 'ok',
        'version'       => WM_MONITOR_VERSION,
        'site'          => get_bloginfo( 'name' ),
        'wp_version'    => get_bloginfo( 'version' ),
        'gravity_forms' => class_exists( 'GFForms' ),
        'post_smtp'     => wm_monitor_has_post_smtp(),
        'timestamp'     => current_time( 'c' ),
    ] );
}

/**
 * POST /wp-json/wm-monitor/v1/test-form
 * Submits a Gravity Forms entry and checks Post SMTP email delivery.
 */
function wm_monitor_test_form( WP_REST_Request $request ) {
    // Gravity Forms required
    if ( ! class_exists( 'GFAPI' ) ) {
        return new WP_Error( 'no_gravity_forms', 'Gravity Forms is not installed or active.', [ 'status' => 400 ] );
    }

    $form_id    = absint( $request->get_param( 'form_id' ) ?: get_option( 'wm_monitor_form_id', 1 ) );
    $test_email = sanitize_email( $request->get_param( 'test_email' ) ?: get_option( 'wm_monitor_test_email', get_bloginfo( 'admin_email' ) ) );

    // Get the form
    $form = GFAPI::get_form( $form_id );
    if ( ! $form || ( isset( $form['is_active'] ) && ! $form['is_active'] ) ) {
        return new WP_Error( 'form_not_found', "Form ID {$form_id} not found or inactive.", [ 'status' => 404 ] );
    }

    // Build submission data from form fields
    $submission = wm_monitor_build_submission( $form, $test_email );

    // Capture time before submit so we can find the log entry after
    $before_time = current_time( 'mysql' );

    // Submit the form (bypass Gravity Forms notifications? No — we WANT them to fire so Post SMTP sends)
    $result = GFAPI::submit_form( $form_id, $submission );

    $form_submitted = ! is_wp_error( $result )
        && isset( $result['is_valid'] )
        && $result['is_valid'] === true;

    $entry_id = $form_submitted && isset( $result['entry_id'] ) ? $result['entry_id'] : null;

    $response = [
        'form_id'        => $form_id,
        'form_name'      => $form['title'],
        'form_submitted' => $form_submitted,
        'entry_id'       => $entry_id,
        'email_sent'     => false,
        'email_log'      => null,
        'errors'         => null,
        'post_smtp'      => wm_monitor_has_post_smtp(),
    ];

    // Capture validation errors if not submitted
    if ( ! $form_submitted ) {
        if ( is_wp_error( $result ) ) {
            $response['errors'] = $result->get_error_message();
        } elseif ( isset( $result['validation_messages'] ) ) {
            $response['errors'] = $result['validation_messages'];
        } elseif ( isset( $result['confirmation_message'] ) ) {
            // Some GF versions return confirmation on success even then is_valid might differ
            $response['form_submitted'] = true;
        }
    }

    // Check Post SMTP log (wait a moment for async sending)
    if ( $form_submitted && $response['post_smtp'] ) {
        sleep( 3 );
        $log_entry = wm_monitor_get_email_log( $test_email, $before_time );
        if ( $log_entry ) {
            $response['email_sent'] = true;
            $response['email_log'] = [
                'to'      => $log_entry['receiver'] ?? $log_entry['to_email'] ?? $test_email,
                'subject' => $log_entry['subject'] ?? '',
                'status'  => $log_entry['status'] ?? 'sent',
                'sent_at' => $log_entry['created'] ?? $log_entry['sent_at'] ?? $before_time,
            ];
        }
    } elseif ( $form_submitted && ! $response['post_smtp'] ) {
        // Post SMTP not installed; assume email sent if form submitted
        $response['email_sent']  = null; // unknown
        $response['email_log']   = null;
    }

    return rest_ensure_response( $response );
}

/**
 * Build form submission data compatible with GFAPI::submit_form().
 */
function wm_monitor_build_submission( array $form, string $test_email ): array {
    $data = [];

    foreach ( $form['fields'] as $field ) {
        $id = $field->id;

        switch ( $field->type ) {
            case 'email':
                $data[ "input_{$id}" ] = $test_email;
                break;

            case 'name':
                // Standard name field: first=_3, last=_6
                if ( $field->nameFormat === 'simple' ) {
                    $data[ "input_{$id}" ] = 'WM Monitor Test';
                } else {
                    $data[ "input_{$id}_3" ] = 'WM Monitor';
                    $data[ "input_{$id}_6" ] = 'Test';
                }
                break;

            case 'text':
                $data[ "input_{$id}" ] = 'WM Monitor automated test — please ignore';
                break;

            case 'textarea':
                $data[ "input_{$id}" ] = 'This is an automated contact form test from the WM Plus Monitoring dashboard. Please ignore this submission.';
                break;

            case 'phone':
                $data[ "input_{$id}" ] = '555-000-0000';
                break;

            case 'website':
                $data[ "input_{$id}" ] = 'https://webmarketers.ca';
                break;

            case 'select':
            case 'radio':
                // Pick the first available choice
                if ( ! empty( $field->choices ) ) {
                    $data[ "input_{$id}" ] = $field->choices[0]['value'];
                }
                break;

            case 'checkbox':
                if ( ! empty( $field->choices ) ) {
                    $data[ "input_{$id}_1" ] = $field->choices[0]['value'];
                }
                break;

            case 'consent':
                $data[ "input_{$id}_1" ] = '1';
                break;

            case 'number':
                $data[ "input_{$id}" ] = '1';
                break;

            // Skip: hidden, html, section, page, captcha
            default:
                break;
        }
    }

    return $data;
}

/**
 * Check if Post SMTP plugin is active and has the email log table.
 */
function wm_monitor_has_post_smtp(): bool {
    global $wpdb;
    // Check for Post SMTP's mail log table
    $tables = [ 'postman_sent_mail', 'postsmtp_log' ];
    foreach ( $tables as $table ) {
        $full = $wpdb->prefix . $table;
        if ( $wpdb->get_var( "SHOW TABLES LIKE '{$full}'" ) === $full ) {
            return true;
        }
    }
    return false;
}

/**
 * Query the Post SMTP email log for a recent sent email to $test_email.
 */
function wm_monitor_get_email_log( string $test_email, string $after_time ): ?array {
    global $wpdb;

    // Try different possible table names used by Post SMTP variants
    $possible_tables = [
        $wpdb->prefix . 'postman_sent_mail',
        $wpdb->prefix . 'postsmtp_log',
    ];

    foreach ( $possible_tables as $table ) {
        if ( $wpdb->get_var( "SHOW TABLES LIKE '{$table}'" ) !== $table ) {
            continue;
        }

        // Get column names to handle differences between plugin versions
        $columns = $wpdb->get_col( "DESCRIBE {$table}", 0 );

        $email_col = in_array( 'receiver', $columns, true ) ? 'receiver' : ( in_array( 'to_email', $columns, true ) ? 'to_email' : null );
        $time_col  = in_array( 'created', $columns, true ) ? 'created' : ( in_array( 'sent_at', $columns, true ) ? 'sent_at' : null );

        if ( ! $email_col ) {
            continue;
        }

        $where_time = $time_col ? $wpdb->prepare( "AND {$time_col} >= %s", $after_time ) : '';

        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$table}
                 WHERE {$email_col} LIKE %s
                 {$where_time}
                 ORDER BY id DESC LIMIT 1",
                '%' . $wpdb->esc_like( $test_email ) . '%'
            ),
            ARRAY_A
        );

        if ( $row ) return $row;
    }

    return null;
}

// ── Admin Settings Page ───────────────────────────────────────────────────────
add_action( 'admin_menu', 'wm_monitor_admin_menu' );

function wm_monitor_admin_menu() {
    add_menu_page(
        'WM Monitor Settings',
        'WM Monitor',
        'manage_options',
        'wm-monitor',
        'wm_monitor_settings_page',
        'dashicons-visibility',
        80
    );
}

add_action( 'admin_init', 'wm_monitor_auto_generate_key' );

function wm_monitor_auto_generate_key() {
    if ( ! get_option( 'wm_monitor_secret_key' ) ) {
        update_option( 'wm_monitor_secret_key', wp_generate_password( 40, false ) );
    }
}

function wm_monitor_settings_page() {
    // Save handler
    if ( isset( $_POST['wm_monitor_save'] ) && check_admin_referer( 'wm_monitor_save_settings' ) ) {
        update_option( 'wm_monitor_secret_key', sanitize_text_field( wp_unslash( $_POST['secret_key'] ?? '' ) ) );
        update_option( 'wm_monitor_form_id',    absint( $_POST['form_id'] ?? 1 ) );
        update_option( 'wm_monitor_test_email', sanitize_email( $_POST['test_email'] ?? '' ) );
        echo '<div class="notice notice-success is-dismissible"><p><strong>WM Monitor settings saved!</strong></p></div>';
    }

    $secret_key = get_option( 'wm_monitor_secret_key', '' );
    $form_id    = get_option( 'wm_monitor_form_id', 1 );
    $test_email = get_option( 'wm_monitor_test_email', get_bloginfo( 'admin_email' ) );
    $site_url   = get_site_url();
    $api_base   = get_rest_url( null, 'wm-monitor/v1' );
    $has_gf     = class_exists( 'GFForms' );
    $has_smtp   = wm_monitor_has_post_smtp();

    ?>
    <div class="wrap" style="max-width:760px">
        <h1 style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="background:#931834;color:#fff;border-radius:6px;padding:4px 8px;font-size:14px">WM</span>
            Webmarketers Monitoring — Plugin Settings
        </h1>
        <p style="color:#666;margin-bottom:24px">
            Connect this WordPress site to the <strong>Webmarketers Monitoring dashboard</strong> for visual regression testing and automated contact form checks.
        </p>

        <!-- Status Card -->
        <div style="background:#f9f9f9;border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:24px">
            <h3 style="margin-top:0">Plugin Status</h3>
            <table style="border-collapse:collapse;width:100%">
                <tr>
                    <td style="padding:6px 0;width:200px;color:#555">🌐 Site URL</td>
                    <td><code><?php echo esc_html( $site_url ); ?></code></td>
                </tr>
                <tr>
                    <td style="padding:6px 0;color:#555">📡 API Base</td>
                    <td><code><?php echo esc_html( $api_base ); ?></code></td>
                </tr>
                <tr>
                    <td style="padding:6px 0;color:#555">📋 Gravity Forms</td>
                    <td><?php echo $has_gf ? '<span style="color:#0a0;font-weight:600">✅ Installed</span>' : '<span style="color:#c00">❌ Not found — required for form testing</span>'; ?></td>
                </tr>
                <tr>
                    <td style="padding:6px 0;color:#555">📧 Post SMTP</td>
                    <td><?php echo $has_smtp ? '<span style="color:#0a0;font-weight:600">✅ Installed</span>' : '<span style="color:#888">⚠️ Not found — email delivery verification unavailable</span>'; ?></td>
                </tr>
            </table>
        </div>

        <form method="post">
            <?php wp_nonce_field( 'wm_monitor_save_settings' ); ?>

            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="secret_key">Secret Monitor Key</label></th>
                    <td>
                        <div style="display:flex;gap:8px;align-items:center">
                            <input type="text"
                                   name="secret_key"
                                   id="secret_key"
                                   value="<?php echo esc_attr( $secret_key ); ?>"
                                   class="regular-text"
                                   style="font-family:monospace;font-size:12px" />
                            <button type="button"
                                    class="button"
                                    onclick="
                                        var arr = new Uint8Array(30);
                                        crypto.getRandomValues(arr);
                                        document.getElementById('secret_key').value =
                                            Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
                                    ">
                                🔄 Regenerate
                            </button>
                            <button type="button"
                                    class="button"
                                    onclick="
                                        navigator.clipboard.writeText(document.getElementById('secret_key').value);
                                        this.textContent = '✅ Copied!';
                                        setTimeout(() => this.textContent = '📋 Copy', 2000);
                                    ">
                                📋 Copy
                            </button>
                        </div>
                        <p class="description">
                            Copy this key and paste it into the <strong>WM Monitor Key</strong> field when adding this site in the <strong>Webmarketers Monitoring dashboard</strong>.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="form_id">Gravity Form ID</label></th>
                    <td>
                        <input type="number"
                               name="form_id"
                               id="form_id"
                               value="<?php echo esc_attr( $form_id ); ?>"
                               class="small-text"
                               min="1" />
                        <p class="description">
                            The ID of the Gravity Form used for contact form testing (usually your main contact form).
                            <?php if ( $has_gf ) : ?>
                            You can find form IDs at <strong>Forms → All Forms</strong>.
                            <?php endif; ?>
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="test_email">Test Email Address</label></th>
                    <td>
                        <input type="email"
                               name="test_email"
                               id="test_email"
                               value="<?php echo esc_attr( $test_email ); ?>"
                               class="regular-text" />
                        <p class="description">
                            Email address used when submitting test form entries. Post SMTP will check if email was delivered to this address.
                        </p>
                    </td>
                </tr>
            </table>

            <?php submit_button( 'Save Settings', 'primary', 'wm_monitor_save' ); ?>
        </form>

        <!-- Quick Guide -->
        <div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:20px;margin-top:24px">
            <h3 style="margin-top:0">📖 Quick Setup Guide</h3>
            <ol style="line-height:2">
                <li>Copy the <strong>Secret Monitor Key</strong> above.</li>
                <li>In your <strong>WM Plus Monitoring dashboard</strong>, add this site.</li>
                <li>Paste the key in the <strong>WM Monitor Key</strong> field.</li>
                <li>Set the <strong>Gravity Form ID</strong> to your main contact form.</li>
                <li>Click <strong>Run Form Test</strong> to verify everything works.</li>
            </ol>
            <hr style="margin:16px 0"/>
            <h4 style="margin-top:0">API Endpoints</h4>
            <table style="border-collapse:collapse;font-size:13px;width:100%">
                <tr style="background:#f5f5f5">
                    <td style="padding:6px 10px;font-family:monospace">GET <?php echo esc_html( $api_base ); ?>/ping</td>
                    <td style="padding:6px 10px;color:#555">Check plugin health</td>
                </tr>
                <tr>
                    <td style="padding:6px 10px;font-family:monospace">POST <?php echo esc_html( $api_base ); ?>/test-form</td>
                    <td style="padding:6px 10px;color:#555">Submit test form + verify email</td>
                </tr>
            </table>
        </div>
    </div>
    <?php
}
