import Gio from 'gi://Gio';
import { _ } from '../gettext.js';

/**
 * Threshold: if more than this many NEW failed messages appear in a single
 * polling cycle, we show one critical "system overload" notification instead
 * of individual ones.
 */
const CRITICAL_THRESHOLD = 5;

/**
 * How long (in seconds) to suppress repeated critical notifications.
 * Prevents spamming when the server stays broken across multiple poll cycles.
 */
const CRITICAL_COOLDOWN_SECONDS = 60;

/**
 * Manages GNOME system notifications for Respatch.
 *
 * Responsibilities:
 *  - Sends a notification for each newly-appeared failed message (deduplication
 *    via a persistent set of already-notified IDs).
 *  - When the number of new failures in one cycle exceeds {@link CRITICAL_THRESHOLD},
 *    collapses all individual notifications into a single critical one.
 *  - Suppresses repeated critical notifications via a cooldown timer.
 */
export class NotificationService {
    /** IDs of failed messages for which a notification has already been sent. */
    private readonly notifiedIds = new Set<string>();

    /** Timestamp (ms) of the last critical notification, or 0 if never sent. */
    private lastCriticalAt = 0;

    /** Timestamp (ms) until notifications are muted, 0 if not muted, -1 for forever. */
    private muteUntil = 0;

    constructor(private readonly app: Gio.Application) {}

    /**
     * Mutes notifications for a specific duration.
     * @param seconds Duration in seconds, or -1 for forever.
     */
    mute(seconds: number): void {
        if (seconds === -1) {
            this.muteUntil = -1;
        } else {
            this.muteUntil = Date.now() + seconds * 1000;
        }
    }

    private isMuted(): boolean {
        if (this.muteUntil === -1) return true;
        return Date.now() < this.muteUntil;
    }

    /**
     * Called after every successful poll of the failed-messages endpoint.
     *
     * @param currentIds  Stable keys of ALL currently-failed messages
     *                    (same format as `keyOf` in PollingSection, e.g. `"transport:42"`).
     */
    processFailedMessages(currentIds: string[]): void {
        const currentSet = new Set(currentIds);

        // Prune IDs that are no longer failed (message was retried / removed).
        for (const id of this.notifiedIds) {
            if (!currentSet.has(id)) {
                this.notifiedIds.delete(id);
            }
        }

        // Determine which IDs are genuinely new.
        const newIds = currentIds.filter(id => !this.notifiedIds.has(id));

        if (newIds.length === 0) return;

        if (!this.isMuted()) {
            if (newIds.length > CRITICAL_THRESHOLD) {
                this.sendCriticalNotification(newIds.length);
            } else {
                for (const id of newIds) {
                    this.sendFailedMessageNotification(id);
                }
            }
        }

        // Mark all new IDs as notified regardless of which path we took.
        for (const id of newIds) {
            this.notifiedIds.add(id);
        }
    }

    // -------------------------------------------------------------------------

    private sendFailedMessageNotification(id: string): void {
        const [transport] = id.split(':');
        const notification = new Gio.Notification();
        notification.set_title(_('Message failed'));
        notification.set_body(
            _('Transport "%s" contains a new failed message.').replace('%s', transport ?? id)
        );
        notification.set_priority(Gio.NotificationPriority.HIGH);
        notification.set_default_action('app.open-main');

        notification.add_button(_('Mute for 1 hour'), 'app.mute-1h');
        notification.add_button(_('Mute for 1 day'), 'app.mute-1d');
        notification.add_button(_('Turn off'), 'app.mute-off');

        // Use the message ID as notification ID so the same message never
        // produces more than one notification bubble.
        console.log(`Sending notification for failed message ${id}`);
        this.app.send_notification(`failed-msg-${id}`, notification);
    }

    private sendCriticalNotification(count: number): void {
        const now = Date.now();
        const cooldownMs = CRITICAL_COOLDOWN_SECONDS * 1000;

        if (now - this.lastCriticalAt < cooldownMs) {
            // Still within cooldown — do not spam.
            return;
        }

        this.lastCriticalAt = now;

        const notification = new Gio.Notification();
        notification.set_title(_('Critical system state'));
        notification.set_body(
            _('%d new failed messages detected. Check your transports status.')
                .replace('%d', String(count))
        );
        notification.set_priority(Gio.NotificationPriority.URGENT);
        notification.set_default_action('app.open-main');

        notification.add_button(_('Mute for 1 hour'), 'app.mute-1h');
        notification.add_button(_('Mute for 1 day'), 'app.mute-1d');
        notification.add_button(_('Turn off'), 'app.mute-off');

        this.app.send_notification('failed-msg-critical', notification);
    }
}
