import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal stub for Gio.Application / Gio.Notification
// ---------------------------------------------------------------------------

class MockNotification {
    title = '';
    body = '';
    priority = 0;
    defaultAction = '';
    buttons: { label: string; action: string }[] = [];

    set_title(t: string) { this.title = t; }
    set_body(b: string) { this.body = b; }
    set_priority(p: number) { this.priority = p; }
    set_default_action(a: string) { this.defaultAction = a; }
    add_button(label: string, action: string) { this.buttons.push({ label, action }); }
}

const mockSendNotification = vi.fn();

const mockApp = {
    send_notification: mockSendNotification,
} as any;

// Stub gi:// modules before importing the service
vi.mock('gi://Gio', () => ({
    default: {
        Notification: MockNotification,
        NotificationPriority: { HIGH: 1, URGENT: 2 },
    },
}));

vi.mock('../src/gettext.js', () => ({
    _: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are set up
// ---------------------------------------------------------------------------
const { NotificationService } = await import('../src/services/NotificationService.js');

// ---------------------------------------------------------------------------

describe('NotificationService', () => {
    let svc: InstanceType<typeof NotificationService>;

    beforeEach(() => {
        vi.clearAllMocks();
        svc = new NotificationService(mockApp);
    });

    it('sends a notification for a new failed message', () => {
        svc.processFailedMessages(['async:1']);
        expect(mockSendNotification).toHaveBeenCalledOnce();
        expect(mockSendNotification.mock.calls[0][0]).toBe('failed-msg-async:1');
    });

    it('does NOT send a duplicate notification for the same message', () => {
        svc.processFailedMessages(['async:1']);
        svc.processFailedMessages(['async:1']);
        expect(mockSendNotification).toHaveBeenCalledOnce();
    });

    it('sends individual notifications for up to 5 new messages', () => {
        svc.processFailedMessages(['t:1', 't:2', 't:3', 't:4', 't:5']);
        expect(mockSendNotification).toHaveBeenCalledTimes(5);
        const ids = mockSendNotification.mock.calls.map((c: any[]) => c[0]);
        expect(ids).toContain('failed-msg-t:1');
        expect(ids).toContain('failed-msg-t:5');
    });

    it('sends a single critical notification when more than 5 new messages appear', () => {
        svc.processFailedMessages(['t:1', 't:2', 't:3', 't:4', 't:5', 't:6']);
        expect(mockSendNotification).toHaveBeenCalledOnce();
        expect(mockSendNotification.mock.calls[0][0]).toBe('failed-msg-critical');
    });

    it('suppresses repeated critical notifications within cooldown', () => {
        const ids = Array.from({ length: 6 }, (_, i) => `t:${i + 1}`);
        svc.processFailedMessages(ids);
        // Second wave of 6 new messages — still within cooldown
        const ids2 = Array.from({ length: 6 }, (_, i) => `t:${i + 100}`);
        svc.processFailedMessages(ids2);
        // Only the first critical notification should have been sent
        const criticalCalls = mockSendNotification.mock.calls.filter((c: any[]) => c[0] === 'failed-msg-critical');
        expect(criticalCalls).toHaveLength(1);
    });

    it('prunes IDs that are no longer failed so they can trigger a new notification later', () => {
        svc.processFailedMessages(['async:1']);
        expect(mockSendNotification).toHaveBeenCalledTimes(1);

        // Message disappears (retried / removed)
        svc.processFailedMessages([]);

        // Message reappears — should notify again
        svc.processFailedMessages(['async:1']);
        expect(mockSendNotification).toHaveBeenCalledTimes(2);
    });

    it('sends no notification when the list is empty', () => {
        svc.processFailedMessages([]);
        expect(mockSendNotification).not.toHaveBeenCalled();
    });
});
