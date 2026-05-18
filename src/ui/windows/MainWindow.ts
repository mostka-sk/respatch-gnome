import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import { _ } from '../../gettext.js';
import { WindowManager } from '../../WindowManager.js';
import { ProjectStore } from '../../stores/ProjectStore.js';
import { ApiClient } from '../../services/ApiClient.js';
import { LoggerService } from '../../services/LoggerService.js';
import type { Project } from '../../models/Project.js';
import { TransportRow, TransportItem } from '../widgets/TransportRow.js';
import { FailedTransportRow, FailedTransportItem } from '../widgets/FailedTransportRow.js';
import { SettingsService } from '../../services/SettingsService.js';
import { BrowserService } from '../../services/BrowserService.js';
import { RecentMessageRow } from '../widgets/RecentMessageRow.js';
import { FailedMessageRow } from '../widgets/FailedMessageRow.js';
import { PollingSection } from '../widgets/PollingSection.js';
import { MessageActionHandler } from '../widgets/MessageActionHandler.js';
import { NotificationService } from '../../services/NotificationService.js';
import type {TransportInfo, TransportsResponse} from '../../models/Transport.js';
import type { RecentMessage, RecentMessagesResponse } from '../../models/RecentMessage.js';
import type { FailedMessage, FailedMessagesResponse } from '../../models/FailedMessage.js';

const POLL_INTERVAL_SECONDS = 10;

/**
 * Main application window. Acts as a thin orchestrator:
 *   - wires header buttons to {@link WindowManager},
 *   - keeps the server switcher in sync with {@link ProjectStore},
 *   - owns the refreshable {@link PollingSection}s (one per panel) and
 *     restarts them when the active project changes.
 *
 * All polling/diff/pause-button logic lives in {@link PollingSection};
 * MainWindow itself contains no GLib timers or row-bookkeeping anymore.
 */
export class MainWindow {
    private readonly window: Adw.ApplicationWindow;
    private readonly serverSwitcher: Gtk.DropDown;
    private readonly stringList: Gtk.StringList;
    private readonly toastOverlay: Adw.ToastOverlay;
    private projects: Project[] = [];

    private readonly browserService: BrowserService;
    private readonly failedTransportsSection: PollingSection<FailedTransportItem, TransportsResponse>;
    private readonly transportSection: PollingSection<TransportItem, TransportsResponse>;
    private readonly recentMessagesSection: PollingSection<RecentMessage, RecentMessagesResponse>;
    private readonly failedMessagesSection: PollingSection<FailedMessage, FailedMessagesResponse>;

    private daemonRunning = false;
    private readonly daemonWatchId: number;

    constructor(
        app: Adw.Application,
        uiDir: string,
        wm: WindowManager,
        private readonly store: ProjectStore,
        private readonly apiClient: ApiClient,
        private readonly logger: LoggerService,
        private readonly settingsService: SettingsService,
        private readonly notificationService: NotificationService
    ) {
        this.browserService = new BrowserService(settingsService, () => this.getActiveProject(), this.logger);
        const builder = new Gtk.Builder();
        builder.add_from_file(`${uiDir}/ui/main.ui`);

        this.window = builder.get_object('window') as Adw.ApplicationWindow;
        this.window.set_application(app);

        this.wireHeaderButtons(builder, wm);
        this.wireDashboardRow(builder);

        this.serverSwitcher = builder.get_object('server_switcher') as Gtk.DropDown;
        this.toastOverlay = builder.get_object('toast_overlay') as Adw.ToastOverlay;
        this.stringList = new Gtk.StringList();

        this.failedTransportsSection = this.createFailedTransportsSection(builder, uiDir);
        this.transportSection = this.createTransportSection(builder, uiDir);
        this.recentMessagesSection = this.createRecentMessagesSection(builder, uiDir);
        this.failedMessagesSection = this.createFailedMessagesSection(builder, uiDir);

        this.setupServerSwitcher();

        this.failedTransportsSection.start();
        this.transportSection.start();
        this.recentMessagesSection.start();
        this.failedMessagesSection.start();

        this.daemonWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            'sk.tito10047.respatch.Daemon',
            Gio.BusNameWatcherFlags.NONE,
            () => { 
                this.logger.info('Daemon is running. Disabling local notifications.');
                this.daemonRunning = true; 
            },
            () => { 
                this.logger.info('Daemon is NOT running. Enabling local notifications.');
                this.daemonRunning = false; 
            }
        );
    }

    present(): void {
        this.window.present();
    }

    // ----- Header / navigation -------------------------------------------------

    private wireHeaderButtons(builder: Gtk.Builder, wm: WindowManager): void {
        const settingsBtn = builder.get_object('settings_button') as Gtk.Button | null;
        settingsBtn?.connect('clicked', () => wm.showSettings(this.window));

        const manageServersBtn = builder.get_object('manage_servers_button') as Gtk.Button | null;
        manageServersBtn?.connect('clicked', () => wm.showManageServers(this.window));

        const aboutBtn = builder.get_object('about_button') as Gtk.Button | null;
        aboutBtn?.connect('clicked', () => wm.showAbout(this.window));
    }

    private wireDashboardRow(builder: Gtk.Builder): void {
        const dashboardRow = builder.get_object('dashboard_row') as Adw.ActionRow | null;
        dashboardRow?.connect('activated', () => {
            this.browserService.openUrl(this.browserService.getMessengerBaseUrl());
        });
    }

    // ----- Server switcher -----------------------------------------------------

    private setupServerSwitcher(): void {
        this.serverSwitcher.set_model(this.stringList);

        this.store.connect('notify::active-project', () => {
            this.syncSwitcher();
            this.failedTransportsSection.restart();
            this.transportSection.restart();
            this.recentMessagesSection.restart();
            this.failedMessagesSection.restart();
        });

        this.serverSwitcher.connect('notify::selected-item', () => {
            const pos = this.serverSwitcher.get_selected();
            if (pos !== Gtk.INVALID_LIST_POSITION && this.projects[pos]) {
                this.store.setActiveProject(this.projects[pos].id);
            }
        });

        this.syncSwitcher();
    }

    private syncSwitcher(): void {
        this.projects = this.store.getProjects();
        const names = this.projects.map(p => p.name);
        this.stringList.splice(0, this.stringList.get_n_items(), names);

        const activeId = this.store.active_project;
        if (activeId) {
            const index = this.projects.findIndex(p => p.id === activeId);
            if (index !== -1) {
                this.serverSwitcher.set_selected(index);
            }
        }
    }

    // ----- Polling sections ----------------------------------------------------

    /** Returns the currently active project, or `null` if none is selected. */
    private getActiveProject(): Project | null {
        const activeId = this.store.active_project;
        if (!activeId) return null;
        return this.store.getProjects().find(p => p.id === activeId) ?? null;
    }

    private createFailedTransportsSection(builder: Gtk.Builder, uiDir: string): PollingSection<FailedTransportItem, TransportsResponse> {
        const list = builder.get_object('failed_transport_list') as Gtk.ListBox;
        const container = builder.get_object('failed_transports_box') as Gtk.Widget;
        const pauseBtn = builder.get_object('failed_transport_pause_button') as Gtk.Button;

        return new PollingSection<FailedTransportItem, TransportsResponse>({
            name: 'FailedTransports',
            listBox: list,
            hideWhenEmpty: true,
            containerWidget: container,
            pauseButton: pauseBtn,
            toastOverlay: this.toastOverlay,
            intervalSeconds: POLL_INTERVAL_SECONDS,
            logger: this.logger,
            fetcher: async () => {
                const p = this.getActiveProject();
                if (!p) return {} as TransportsResponse;
                return this.apiClient.fetchTransports(p.url, p.token);
            },
            toItems: (response) =>
                Object.entries(response)
                    .filter(([, info]) => info.failure && (info.count ?? 0) > 0)
                    .map(([name, info]) => ({ transportName: name, count: info.count ?? 0 })),
            keyOf: (item) => item.transportName,
            createRow: (item) => new FailedTransportRow(
                item.transportName,
                uiDir,
                this.browserService,
            ),
        });
    }

    private createTransportSection(builder: Gtk.Builder, uiDir: string): PollingSection<TransportItem, TransportsResponse> {
        const list = builder.get_object('transport_list') as Gtk.ListBox;
        const pauseBtn = builder.get_object('transport_pause_button') as Gtk.Button;

        const transportRowMap = new Map<Gtk.ListBoxRow, TransportRow>();

        list.connect('row-activated', (_listBox, row) => {
            const transportRow = transportRowMap.get(row);
            if (transportRow) {
                this.browserService.openUrl(this.browserService.getTransportUrl(transportRow.transportName));
            }
        });

        return new PollingSection<TransportItem, TransportsResponse>({
            name: 'Transports',
            listBox: list,
            hideWhenEmpty: false,
            emptyPlaceholder: _('No transports'),
            pauseButton: pauseBtn,
            toastOverlay: this.toastOverlay,
            intervalSeconds: POLL_INTERVAL_SECONDS,
            logger: this.logger,
            fetcher: async () => {
                const p = this.getActiveProject();
                if (!p) return {} as TransportsResponse;
                const transports = await this.apiClient.fetchTransports(p.url, p.token);
                return Object.fromEntries(
                    Object.entries(transports).filter(([, info]) => !info.failure)
                ) as TransportsResponse;
            },
            toItems: (response) => Object.entries(response).map(([name, info]) => ({ name, info })),
            keyOf: (item) => item.name,
            createRow: (item) => {
                const tr = new TransportRow(item.name, uiDir, this.browserService);
                transportRowMap.set(tr.getWidget(), tr);
                return tr;
            },
        });
    }

    private createRecentMessagesSection(builder: Gtk.Builder, uiDir: string): PollingSection<RecentMessage, RecentMessagesResponse> {
        const list = builder.get_object('recent_messages_list') as Gtk.ListBox;
        const pauseBtn = builder.get_object('recent_messages_pause_button') as Gtk.Button;
        const overflowBtn = builder.get_object('recent_messages_overflow_button') as Gtk.Button;

        return new PollingSection<RecentMessage, RecentMessagesResponse>({
            name: 'RecentMessages',
            listBox: list,
            hideWhenEmpty: false,
            emptyPlaceholder: _('No messages'),
            pauseButton: pauseBtn,
            overflowButton: overflowBtn,
            onOverflowOpen: () => this.browserService.openUrl(this.browserService.getRecentMessagesUrl()),
            maxRows: 15,
            toastOverlay: this.toastOverlay,
            intervalSeconds: POLL_INTERVAL_SECONDS,
            logger: this.logger,
            fetcher: () => {
                const p = this.getActiveProject();
                if (!p) return Promise.resolve([] as RecentMessagesResponse);
                return this.apiClient.fetchRecentMessages(p.url, p.token);
            },
            toItems: (response) => response,
            keyOf: (msg) => String(msg.id),
            createRow: () => new RecentMessageRow(uiDir, this.browserService, (transport) => {
                // Future: open transport-detail window via WindowManager.
                this.logger.info(`Klik na transport: ${transport}`);
            }),
        });
    }

    private createFailedMessagesSection(builder: Gtk.Builder, uiDir: string): PollingSection<FailedMessage, FailedMessagesResponse> {
        const list = builder.get_object('failed_messages_list') as Gtk.ListBox;
        const container = builder.get_object('failed_messages_box') as Gtk.Widget;
        const overflowBtn = builder.get_object('failed_messages_overflow_button') as Gtk.Button;

        const actionHandler = new MessageActionHandler({
            apiClient: this.apiClient,
            logger: this.logger,
            toastOverlay: this.toastOverlay,
            getProject: () => this.getActiveProject(),
            onSuccess: ({ message }) => this.failedMessagesSection.removeItem(`${message.transport}:${message.id}`),
        });

        return new PollingSection<FailedMessage, FailedMessagesResponse>({
            name: 'FailedMessages',
            listBox: list,
            hideWhenEmpty: true,
            containerWidget: container,
            overflowButton: overflowBtn,
            onOverflowOpen: () => this.browserService.openUrl(this.browserService.getFailedMessagesUrl()),
            maxRows: 6,
            toastOverlay: this.toastOverlay,
            intervalSeconds: POLL_INTERVAL_SECONDS,
            logger: this.logger,
            fetcher: async () => {
                const p = this.getActiveProject();
                if (!p) return [] as FailedMessagesResponse;

                const transports = await this.apiClient.fetchTransports(p.url, p.token);
                const failureTransportNames = Object.entries(transports)
                    .filter(([, info]) => info.failure)
                    .map(([name]) => name);

                if (failureTransportNames.length === 0) return [] as FailedMessagesResponse;

                const results = await Promise.allSettled(
                    failureTransportNames.map(name =>
                        this.apiClient.fetchFailedMessages(p.url, p.token, name)
                    )
                );

                const all: FailedMessage[] = [];
                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        all.push(...result.value);
                    }
                }

                all.sort((a, b) => new Date(b.dispatched).getTime() - new Date(a.dispatched).getTime());
                return all;
            },
            toItems: (response) => response,
            keyOf: (msg) => `${msg.transport}:${msg.id}`,
            createRow: () => new FailedMessageRow(uiDir, actionHandler.createHandler()),
            onRenderedKeys: (keys) => {
                if (!this.daemonRunning) {
                    this.notificationService.processFailedMessages(keys);
                }
            },
        });
    }
}
