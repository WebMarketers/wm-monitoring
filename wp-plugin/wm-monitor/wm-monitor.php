<?php
/**
 * Plugin Name:       Webmarketers Monitoring
 * Plugin URI:        https://webmarketers.ca
 * Description:       Passive form monitoring & active form testing for WM Plus Monitoring dashboard. Works with Gravity Forms and Contact Form 7.
 * Version:           2.0.0
 * Author:            WebMarketers
 * Author URI:        https://webmarketers.ca
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Text Domain:       wm-monitor
 */

defined( 'ABSPATH' ) || exit;

define( 'WM_MONITOR_VERSION', '2.0.0' );
define( 'WM_MONITOR_FILE',    __FILE__ );

// ── REST API Routes ───────────────────────────────────────────────────────────
add_action( 'rest_api_init', 'wm_monitor_register_routes' );

function wm_monitor_register_routes() {
    // Health / passive lead timestamp
    register_rest_route( 'wm-monitor/v1', '/ping', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'wm_monitor_ping',
        'permission_callback' => 'wm_monitor_verify_key',
    ] );

    register_rest_route( 'wm-monitor/v1', '/health', [
        'methods'             => WP_REST_Server::READABLE,
        'callback'            => 'wm_monitor_health',
        'permission_callback' => 'wm_monitor_verify_key',
    ] );

    // Active form test (GF or CF7)
    register_rest_route( 'wm-monitor/v1', '/test-form', [
        'methods'             => WP_REST_Server::CREATABLE,
        'callback'            => 'wm_monitor_test_form',
        'permission_callback' => 'wm_monitor_verify_key',
        'args'                => [
            'form_id'     => [ 'type' => 'integer', 'default' => 1 ],
            'form_type'   => [ 'type' => 'string',  'default' => 'auto' ], // auto | gf | cf7
            'silent_mode' => [ 'type' => 'boolean', 'default' => false ],
        ],
    ] );
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function wm_monitor_verify_key( WP_REST_Request $request ) {
    $provided = $request->get_header( 'X-WM-Monitor-Key' );
    $stored   = get_option( 'wm_monitor_secret_key', '' );

    if ( ! $provided || ! $stored || ! hash_equals( $stored, $provided ) ) {
        return new WP_Error( 'unauthorized', 'Missing or invalid monitor key.', [ 'status' => 401 ] );
    }
    return true;
}

// ── GET /ping ─────────────────────────────────────────────────────────────────
function wm_monitor_ping( WP_REST_Request $request ) {
    return rest_ensure_response( [
        'status'        => 'ok',
        'version'       => WM_MONITOR_VERSION,
        'site'          => get_bloginfo( 'name' ),
        'wp_version'    => get_bloginfo( 'version' ),
        'gravity_forms' => class_exists( 'GFForms' ),
        'contact_form_7' => class_exists( 'WPCF7' ),
        'post_smtp'     => wm_monitor_has_post_smtp(),
        'timestamp'     => current_time( 'c' ),
    ] );
}

// ── GET /health ───────────────────────────────────────────────────────────────
// Returns last REAL (non-test) form submission timestamp, plus form counts.
function wm_monitor_health( WP_REST_Request $request ) {
    $last_submission = get_option( 'wm_monitor_last_real_submission', '' );
    $submission_count_30d = (int) get_option( 'wm_monitor_submission_count_30d', 0 );

    return rest_ensure_response( [
        'status'                    => 'ok',
        'site'                      => get_bloginfo( 'name' ),
        'gravity_forms'             => class_exists( 'GFForms' ),
        'contact_form_7'            => class_exists( 'WPCF7' ),
        'last_successful_lead_at'   => $last_submission ?: null,
        'submission_count_30d'      => $submission_count_30d,
        'timestamp'                 => current_time( 'c' ),
    ] );
}

// ── POST /test-form ───────────────────────────────────────────────────────────
function wm_monitor_test_form( WP_REST_Request $request ) {
    $form_id     = absint( $request->get_param( 'form_id' ) ?: get_option( 'wm_monitor_form_id', 1 ) );
    $form_type   = sanitize_text_field( $request->get_param( 'form_type' ) ?: 'auto' );
    $silent_mode = (bool) $request->get_param( 'silent_mode' );

    // Auto-detect form type
    if ( $form_type === 'auto' ) {
        if ( class_exists( 'GFAPI' ) ) {
            $form_type = 'gf';
        } elseif ( class_exists( 'WPCF7' ) ) {
            $form_type = 'cf7';
        } else {
            return new WP_Error( 'no_form_plugin', 'Neither Gravity Forms nor Contact Form 7 is installed.', [ 'status' => 400 ] );
        }
    }

    // ── Set silent mode flag (suppresses owner email) ─────────────────────
    if ( $silent_mode ) {
        update_option( 'wm_monitor_silent_mode_active', true, false );
        add_filter( 'wp_mail', 'wm_monitor_suppress_test_email', 1 );
        add_filter( 'gform_disable_notification', '__return_true', 99 );
    }

    $response = [];

    try {
        if ( $form_type === 'gf' ) {
            $response = wm_monitor_submit_gravity_form( $form_id );
        } elseif ( $form_type === 'cf7' ) {
            $response = wm_monitor_submit_cf7( $form_id );
        }
    } finally {
        // Always clean up silent mode
        if ( $silent_mode ) {
            delete_option( 'wm_monitor_silent_mode_active' );
            remove_filter( 'wp_mail', 'wm_monitor_suppress_test_email', 1 );
            remove_filter( 'gform_disable_notification', '__return_true', 99 );
        }
    }

    $response['silent_mode']  = $silent_mode;
    $response['test_data']    = wm_monitor_get_test_data();
    $response['post_smtp']    = wm_monitor_has_post_smtp();

    return rest_ensure_response( $response );
}

// ── Suppress email during silent/test mode ────────────────────────────────────
function wm_monitor_suppress_test_email( $args ) {
    // Block all outgoing mail when in silent mode
    $args['to'] = 'devnull@wm-monitor.internal'; // route to a dead address
    return $args;
}

// ── Gravity Forms submission ──────────────────────────────────────────────────
function wm_monitor_submit_gravity_form( int $form_id ): array {
    if ( ! class_exists( 'GFAPI' ) ) {
        return [
            'form_type'      => 'gravity_forms',
            'form_submitted' => false,
            'email_sent'     => false,
            'errors'         => 'Gravity Forms not installed',
        ];
    }

    $form = GFAPI::get_form( $form_id );
    if ( ! $form || ( isset( $form['is_active'] ) && ! $form['is_active'] ) ) {
        return [
            'form_type'      => 'gravity_forms',
            'form_submitted' => false,
            'email_sent'     => false,
            'errors'         => "Form ID {$form_id} not found or inactive",
        ];
    }

    $submission   = wm_monitor_build_gf_submission( $form );
    $before_time  = current_time( 'mysql' );

    $result = GFAPI::submit_form( $form_id, $submission );

    $submitted = ! is_wp_error( $result )
        && isset( $result['is_valid'] )
        && $result['is_valid'] === true;

    $entry_id = $submitted && isset( $result['entry_id'] ) ? $result['entry_id'] : null;

    // Delete test entry so it doesn't clutter the client's GF entries
    if ( $entry_id ) {
        GFAPI::delete_entry( $entry_id );
    }

    $errors = null;
    if ( ! $submitted ) {
        if ( is_wp_error( $result ) ) {
            $errors = $result->get_error_message();
        } elseif ( isset( $result['validation_messages'] ) ) {
            $errors = $result['validation_messages'];
        }
    }

    // Check Post SMTP log
    $email_sent = false;
    $email_log  = null;
    if ( $submitted && wm_monitor_has_post_smtp() ) {
        sleep( 2 );
        $log_entry = wm_monitor_get_email_log( '', $before_time );
        if ( $log_entry ) {
            $email_sent = true;
            $email_log  = [
                'to'      => $log_entry['receiver'] ?? $log_entry['to_email'] ?? '',
                'subject' => $log_entry['subject'] ?? '',
                'status'  => $log_entry['status'] ?? 'sent',
                'sent_at' => $log_entry['created'] ?? $log_entry['sent_at'] ?? $before_time,
            ];
        }
    }

    return [
        'form_type'      => 'gravity_forms',
        'form_id'        => $form_id,
        'form_name'      => $form['title'],
        'form_submitted' => $submitted,
        'entry_id'       => null, // deleted
        'email_sent'     => $email_sent,
        'email_log'      => $email_log,
        'errors'         => $errors,
    ];
}

// ── Contact Form 7 submission ─────────────────────────────────────────────────
function wm_monitor_submit_cf7( int $form_id ): array {
    if ( ! class_exists( 'WPCF7_ContactForm' ) ) {
        return [
            'form_type'      => 'contact_form_7',
            'form_submitted' => false,
            'email_sent'     => false,
            'errors'         => 'Contact Form 7 not installed',
        ];
    }

    $cf7 = WPCF7_ContactForm::get_instance( $form_id );
    if ( ! $cf7 ) {
        return [
            'form_type'      => 'contact_form_7',
            'form_submitted' => false,
            'email_sent'     => false,
            'errors'         => "CF7 form ID {$form_id} not found",
        ];
    }

    $test_data = wm_monitor_get_test_data();

    // Build $_POST data that CF7 expects
    $_POST = array_merge( $_POST, [
        '_wpcf7'                  => $form_id,
        '_wpcf7_version'          => WPCF7_VERSION,
        '_wpcf7_locale'           => 'en_US',
        '_wpcf7_unit_tag'         => 'wpcf7-f' . $form_id . '-p1-o1',
        '_wpcf7_container_post'   => 0,
        'your-name'               => $test_data['full_name'],
        'your-first-name'         => $test_data['first_name'],
        'your-last-name'          => $test_data['last_name'],
        'your-email'              => $test_data['email'],
        'your-phone'              => $test_data['phone'],
        'your-subject'            => $test_data['subject'],
        'your-message'            => $test_data['message'],
        'first-name'              => $test_data['first_name'],
        'last-name'               => $test_data['last_name'],
        'email'                   => $test_data['email'],
        'phone'                   => $test_data['phone'],
        'message'                 => $test_data['message'],
        'name'                    => $test_data['full_name'],
    ] );

    // Suppress CF7 spam/honeypot checks during test
    add_filter( 'wpcf7_spam', '__return_false', 99 );

    $before_time = current_time( 'mysql' );
    $result      = $cf7->submit();

    remove_filter( 'wpcf7_spam', '__return_false', 99 );

    $submitted = isset( $result['status'] ) && in_array( $result['status'], [ 'mail_sent', 'mail_failed' ], true );
    $email_ok  = isset( $result['status'] ) && $result['status'] === 'mail_sent';

    $email_log = null;
    if ( $email_ok && wm_monitor_has_post_smtp() ) {
        sleep( 2 );
        $log_entry = wm_monitor_get_email_log( '', $before_time );
        if ( $log_entry ) {
            $email_log = [
                'to'      => $log_entry['receiver'] ?? $log_entry['to_email'] ?? '',
                'subject' => $log_entry['subject'] ?? '',
                'status'  => $log_entry['status'] ?? 'sent',
                'sent_at' => $log_entry['created'] ?? $log_entry['sent_at'] ?? $before_time,
            ];
        }
    }

    return [
        'form_type'      => 'contact_form_7',
        'form_id'        => $form_id,
        'form_name'      => $cf7->title(),
        'form_submitted' => $submitted,
        'email_sent'     => $email_ok,
        'email_log'      => $email_log,
        'errors'         => ! $submitted ? ( $result['message'] ?? 'Unknown CF7 error' ) : null,
        'cf7_status'     => $result['status'] ?? null,
    ];
}

// ── Standard test data ────────────────────────────────────────────────────────
function wm_monitor_get_test_data(): array {
    return [
        'first_name' => 'Jayson',
        'last_name'  => 'Yavuz',
        'full_name'  => 'Jayson Yavuz',
        'email'      => 'dev@teamwebmarketers.ca',
        'phone'      => '61354321321',
        'subject'    => 'WM Monitor — Automated Form Test',
        'message'    => 'This is a test form submission from WM Plus Monitoring. Please ignore.',
        'company'    => 'Webmarketers',
        'website'    => 'https://teamwebmarketers.ca',
    ];
}

// ── Build Gravity Forms submission array ──────────────────────────────────────
function wm_monitor_build_gf_submission( array $form ): array {
    $data      = [];
    $test      = wm_monitor_get_test_data();

    foreach ( $form['fields'] as $field ) {
        $id = $field->id;

        switch ( $field->type ) {
            case 'email':
                $data[ "input_{$id}" ] = $test['email'];
                $data[ "input_{$id}_2" ] = $test['email']; // For confirmation fields
                break;

            case 'name':
                if ( $field->nameFormat === 'simple' ) {
                    $data[ "input_{$id}" ] = $test['full_name'];
                } else {
                    $data[ "input_{$id}_3" ] = $test['first_name'];
                    $data[ "input_{$id}_6" ] = $test['last_name'];
                }
                break;

            case 'text':
                $label = strtolower( $field->label ?? '' );
                if ( str_contains( $label, 'first' ) ) {
                    $data[ "input_{$id}" ] = $test['first_name'];
                } elseif ( str_contains( $label, 'last' ) ) {
                    $data[ "input_{$id}" ] = $test['last_name'];
                } elseif ( str_contains( $label, 'company' ) || str_contains( $label, 'business' ) ) {
                    $data[ "input_{$id}" ] = $test['company'];
                } elseif ( str_contains( $label, 'subject' ) ) {
                    $data[ "input_{$id}" ] = $test['subject'];
                } else {
                    $data[ "input_{$id}" ] = $test['full_name'];
                }
                break;

            case 'textarea':
                $data[ "input_{$id}" ] = $test['message'];
                break;

            case 'phone':
                $data[ "input_{$id}" ] = $test['phone'];
                break;

            case 'website':
                $data[ "input_{$id}" ] = $test['website'];
                break;

            case 'select':
            case 'radio':
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

            // Skip: hidden, html, section, page, captcha, recaptcha
            default:
                break;
        }
    }

    return $data;
}

// ── Post SMTP helpers ─────────────────────────────────────────────────────────
function wm_monitor_has_post_smtp(): bool {
    global $wpdb;
    foreach ( [ 'postman_sent_mail', 'postsmtp_log', 'post_smtp_logs' ] as $table ) {
        $full = $wpdb->prefix . $table;
        if ( $wpdb->get_var( "SHOW TABLES LIKE '{$full}'" ) === $full ) {
            return true;
        }
    }
    return false;
}

function wm_monitor_get_email_log( string $to_email, string $after_time ): ?array {
    global $wpdb;
    $tables = [
        $wpdb->prefix . 'postman_sent_mail',
        $wpdb->prefix . 'postsmtp_log',
        $wpdb->prefix . 'post_smtp_logs',
    ];

    foreach ( $tables as $table ) {
        if ( $wpdb->get_var( "SHOW TABLES LIKE '{$table}'" ) !== $table ) continue;

        $columns   = $wpdb->get_col( "DESCRIBE {$table}", 0 );
        $email_col = in_array( 'receiver', $columns, true ) ? 'receiver' : ( in_array( 'to_email', $columns, true ) ? 'to_email' : null );
        $time_col  = in_array( 'created', $columns, true ) ? 'created' : ( in_array( 'sent_at', $columns, true ) ? 'sent_at' : null );

        if ( ! $email_col ) continue;

        $where_time = $time_col ? $wpdb->prepare( "AND {$time_col} >= %s", $after_time ) : '';
        $row = $wpdb->get_row(
            $wpdb->prepare(
                "SELECT * FROM {$table} WHERE {$email_col} LIKE %s {$where_time} ORDER BY id DESC LIMIT 1",
                '%' . $wpdb->esc_like( $to_email ) . '%'
            ),
            ARRAY_A
        );

        if ( $row ) return $row;
    }

    return null;
}

// ── Passive Monitoring: Hook into Gravity Forms submissions ───────────────────
add_action( 'gform_after_submission', 'wm_monitor_record_gf_submission', 10, 2 );

function wm_monitor_record_gf_submission( $entry, $form ) {
    // Skip if this is our own silent test
    if ( get_option( 'wm_monitor_silent_mode_active' ) ) {
        return;
    }

    // Record timestamp of last real submission
    update_option( 'wm_monitor_last_real_submission', current_time( 'c' ), false );

    // Update 30-day rolling count
    $count = (int) get_option( 'wm_monitor_submission_count_30d', 0 );
    update_option( 'wm_monitor_submission_count_30d', $count + 1, false );

    // Push webhook to WM Monitor server
    wm_monitor_push_webhook( [
        'event'        => 'form_submission',
        'form_type'    => 'gravity_forms',
        'form_id'      => $form['id'],
        'form_name'    => $form['title'],
        'submitted_at' => current_time( 'c' ),
        'site'         => get_site_url(),
        'is_test'      => false,
    ] );
}

// ── Passive Monitoring: Hook into Contact Form 7 submissions ──────────────────
add_action( 'wpcf7_mail_sent', 'wm_monitor_record_cf7_submission', 10, 1 );

function wm_monitor_record_cf7_submission( $contact_form ) {
    if ( get_option( 'wm_monitor_silent_mode_active' ) ) {
        return;
    }

    update_option( 'wm_monitor_last_real_submission', current_time( 'c' ), false );

    $count = (int) get_option( 'wm_monitor_submission_count_30d', 0 );
    update_option( 'wm_monitor_submission_count_30d', $count + 1, false );

    wm_monitor_push_webhook( [
        'event'        => 'form_submission',
        'form_type'    => 'contact_form_7',
        'form_id'      => $contact_form->id(),
        'form_name'    => $contact_form->title(),
        'submitted_at' => current_time( 'c' ),
        'site'         => get_site_url(),
        'is_test'      => false,
    ] );
}

// ── Push webhook to WM Monitor server ────────────────────────────────────────
function wm_monitor_push_webhook( array $payload ) {
    $webhook_url = get_option( 'wm_monitor_webhook_url', '' );
    $secret_key  = get_option( 'wm_monitor_secret_key', '' );

    if ( ! $webhook_url || ! $secret_key ) {
        return; // Not configured, skip silently
    }

    wp_remote_post( $webhook_url, [
        'timeout'     => 10,
        'blocking'    => false, // Fire-and-forget (non-blocking)
        'headers'     => [
            'Content-Type'      => 'application/json',
            'X-WM-Monitor-Key'  => $secret_key,
        ],
        'body'        => wp_json_encode( $payload ),
    ] );
}

// ── Admin Settings Page ───────────────────────────────────────────────────────
add_action( 'admin_menu', 'wm_monitor_admin_menu' );
add_action( 'admin_init', 'wm_monitor_auto_generate_key' );

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

function wm_monitor_auto_generate_key() {
    if ( ! get_option( 'wm_monitor_secret_key' ) ) {
        update_option( 'wm_monitor_secret_key', wp_generate_password( 40, false ) );
    }
}

function wm_monitor_settings_page() {
    if ( isset( $_POST['wm_monitor_save'] ) && check_admin_referer( 'wm_monitor_save_settings' ) ) {
        update_option( 'wm_monitor_secret_key',  sanitize_text_field( wp_unslash( $_POST['secret_key']   ?? '' ) ) );
        update_option( 'wm_monitor_form_id',     absint( $_POST['form_id']      ?? 1 ) );
        update_option( 'wm_monitor_webhook_url', esc_url_raw( wp_unslash( $_POST['webhook_url'] ?? '' ) ) );
        echo '<div class="notice notice-success is-dismissible"><p><strong>WM Monitor settings saved!</strong></p></div>';
    }

    $secret_key  = get_option( 'wm_monitor_secret_key', '' );
    $form_id     = get_option( 'wm_monitor_form_id', 1 );
    $webhook_url = get_option( 'wm_monitor_webhook_url', '' );
    $site_url    = get_site_url();
    $api_base    = get_rest_url( null, 'wm-monitor/v1' );
    $has_gf      = class_exists( 'GFForms' );
    $has_cf7     = class_exists( 'WPCF7' );
    $has_smtp    = wm_monitor_has_post_smtp();
    $last_sub    = get_option( 'wm_monitor_last_real_submission', '' );
    $sub_count   = get_option( 'wm_monitor_submission_count_30d', 0 );
    ?>
    <div class="wrap" style="max-width:800px">
        <h1 style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="background:#931834;color:#fff;border-radius:6px;padding:4px 10px;font-size:14px;font-weight:700">WM</span>
            Webmarketers Monitoring — Plugin Settings
        </h1>
        <p style="color:#666;margin-bottom:24px">
            Connect this site to the <strong>WM Plus Monitoring dashboard</strong> for passive form monitoring and automated form testing.
        </p>

        <!-- Status Card -->
        <div style="background:#f9f9f9;border:1px solid #ddd;border-radius:8px;padding:20px;margin-bottom:24px">
            <h3 style="margin-top:0">Plugin Status</h3>
            <table style="border-collapse:collapse;width:100%">
                <tr><td style="padding:6px 0;width:220px;color:#555">🌐 Site URL</td><td><code><?php echo esc_html( $site_url ); ?></code></td></tr>
                <tr><td style="padding:6px 0;color:#555">📡 API Base</td><td><code><?php echo esc_html( $api_base ); ?></code></td></tr>
                <tr><td style="padding:6px 0;color:#555">📋 Gravity Forms</td>
                    <td><?php echo $has_gf ? '<span style="color:#0a0;font-weight:600">✅ Installed</span>' : '<span style="color:#999">⚠️ Not found</span>'; ?></td></tr>
                <tr><td style="padding:6px 0;color:#555">📋 Contact Form 7</td>
                    <td><?php echo $has_cf7 ? '<span style="color:#0a0;font-weight:600">✅ Installed</span>' : '<span style="color:#999">⚠️ Not found</span>'; ?></td></tr>
                <tr><td style="padding:6px 0;color:#555">📧 Post SMTP</td>
                    <td><?php echo $has_smtp ? '<span style="color:#0a0;font-weight:600">✅ Installed</span>' : '<span style="color:#999">⚠️ Not installed — email delivery verification unavailable</span>'; ?></td></tr>
                <tr><td style="padding:6px 0;color:#555">📅 Last Real Submission</td>
                    <td><?php echo $last_sub ? '<strong>' . esc_html( $last_sub ) . '</strong>' : '<em style="color:#999">No submissions recorded yet</em>'; ?></td></tr>
                <tr><td style="padding:6px 0;color:#555">📊 Submissions (30d)</td>
                    <td><strong><?php echo (int) $sub_count; ?></strong></td></tr>
            </table>
        </div>

        <form method="post">
            <?php wp_nonce_field( 'wm_monitor_save_settings' ); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="secret_key">Secret Monitor Key</label></th>
                    <td>
                        <div style="display:flex;gap:8px;align-items:center">
                            <input type="text" name="secret_key" id="secret_key"
                                   value="<?php echo esc_attr( $secret_key ); ?>"
                                   class="regular-text" style="font-family:monospace;font-size:12px" />
                            <button type="button" class="button" onclick="
                                var arr = new Uint8Array(30);
                                crypto.getRandomValues(arr);
                                document.getElementById('secret_key').value = Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
                            ">🔄 Regenerate</button>
                            <button type="button" class="button" onclick="
                                navigator.clipboard.writeText(document.getElementById('secret_key').value);
                                this.textContent = '✅ Copied!';
                                setTimeout(() => this.textContent = '📋 Copy', 2000);
                            ">📋 Copy</button>
                        </div>
                        <p class="description">Copy and paste this key into the WM Plus Monitoring dashboard when adding this site.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="form_id">Primary Form ID</label></th>
                    <td>
                        <input type="number" name="form_id" id="form_id"
                               value="<?php echo esc_attr( $form_id ); ?>"
                               class="small-text" min="1" />
                        <p class="description">
                            The ID of the main contact form to use for testing. For Gravity Forms: find IDs at <strong>Forms → All Forms</strong>.
                            For CF7: find IDs at <strong>Contact → Contact Forms</strong>.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="webhook_url">Webhook URL</label></th>
                    <td>
                        <input type="url" name="webhook_url" id="webhook_url"
                               value="<?php echo esc_attr( $webhook_url ); ?>"
                               class="large-text"
                               placeholder="https://your-monitor-server.com/api/form-webhook" />
                        <p class="description">
                            The WM Monitor server URL that receives passive form submission events.
                            Format: <code>https://your-server/api/form-webhook</code>
                        </p>
                    </td>
                </tr>
            </table>

            <?php submit_button( 'Save Settings', 'primary', 'wm_monitor_save' ); ?>
        </form>

        <!-- Quick Guide -->
        <div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:20px;margin-top:24px">
            <h3 style="margin-top:0">📖 Quick Setup Guide</h3>
            <ol style="line-height:2.2">
                <li>Copy the <strong>Secret Monitor Key</strong> above.</li>
                <li>In your <strong>WM Plus Monitoring dashboard</strong>, add this site and paste the key.</li>
                <li>Set the <strong>Primary Form ID</strong> to your main contact form.</li>
                <li>Set the <strong>Webhook URL</strong> to your monitoring server's endpoint.</li>
                <li>Real form submissions will now be automatically tracked and reported.</li>
                <li>If no submission is received within a set threshold, the dashboard will trigger an automatic silent test.</li>
            </ol>
            <hr style="margin:16px 0"/>
            <h4 style="margin-top:0">API Endpoints</h4>
            <table style="border-collapse:collapse;font-size:13px;width:100%">
                <tr style="background:#f5f5f5"><td style="padding:6px 10px;font-family:monospace">GET <?php echo esc_html( $api_base ); ?>/ping</td><td style="padding:6px 10px;color:#555">Plugin status</td></tr>
                <tr><td style="padding:6px 10px;font-family:monospace">GET <?php echo esc_html( $api_base ); ?>/health</td><td style="padding:6px 10px;color:#555">Last real submission timestamp</td></tr>
                <tr style="background:#f5f5f5"><td style="padding:6px 10px;font-family:monospace">POST <?php echo esc_html( $api_base ); ?>/test-form</td><td style="padding:6px 10px;color:#555">Trigger silent automated test</td></tr>
            </table>
        </div>
    </div>
    <?php
}
