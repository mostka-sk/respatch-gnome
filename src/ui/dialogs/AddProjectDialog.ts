import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import { _ } from '../../gettext.js';
import { ApiClient } from '../../services/ApiClient.js';
import { ProjectStore } from '../../stores/ProjectStore.js';
import { LoggerService } from '../../services/LoggerService.js';
import { Project } from '../../models/Project.js';

export class AddProjectDialog {
    private dialog: Adw.Dialog;
    private state: 'verify' | 'add' | 'error' = 'verify';
    private existingProject?: Project;
    
    private nameInput: Adw.EntryRow;
    private urlInput: Adw.EntryRow;
    private tokenInput: Adw.PasswordEntryRow;
    private actionBtn: Gtk.Button;
    private toastOverlay: Adw.ToastOverlay;

    constructor(
        private parentWidget: Gtk.Widget,
        uiDir: string,
        private apiClient: ApiClient,
        private store: ProjectStore,
        private logger: LoggerService,
        private onSuccess: () => void,
        existingProject?: Project
    ) {
        this.existingProject = existingProject;
        const builder = new Gtk.Builder();
        builder.add_from_file(`${uiDir}/ui/add_project_dialog.ui`);

        this.dialog = builder.get_object('add_project_dialog') as Adw.Dialog;

        this.nameInput = builder.get_object('name_input') as Adw.EntryRow;
        this.urlInput = builder.get_object('url_input') as Adw.EntryRow;
        this.tokenInput = builder.get_object('token_input') as Adw.PasswordEntryRow;
        this.actionBtn = builder.get_object('action_button') as Gtk.Button;
        this.toastOverlay = builder.get_object('toast_overlay') as Adw.ToastOverlay;
        const cancelBtn = builder.get_object('cancel_button') as Gtk.Button;

        cancelBtn.connect('clicked', () => this.dialog.close());

        const resetState = () => {
            if (this.state !== 'verify') {
                this.state = 'verify';
                this.actionBtn.set_label(_('Verify'));
                this.actionBtn.remove_css_class('success');
                this.actionBtn.remove_css_class('destructive-action');
                this.actionBtn.add_css_class('suggested-action');
            }
        };

        this.nameInput.connect('notify::text', resetState);
        this.urlInput.connect('notify::text', resetState);
        this.tokenInput.connect('notify::text', resetState);

        if (this.existingProject) {
            this.nameInput.set_text(this.existingProject.name);
            this.urlInput.set_text(this.existingProject.url);
            this.tokenInput.set_text(this.existingProject.token);
            this.dialog.set_title(_("Edit project"));
            this.state = 'add';
            this.actionBtn.set_label(_('Save'));
            this.actionBtn.remove_css_class('suggested-action');
            this.actionBtn.add_css_class('success');
        }

        this.actionBtn.connect('clicked', () => this.handleAction());
    }

    private async handleAction() {
        const name = this.nameInput.get_text();
        const url = this.urlInput.get_text();
        const token = this.tokenInput.get_text();

        if (!name || !url || !token) return;

        if (this.state === 'verify' || this.state === 'error') {
            await this.verify(url, token);
        } else if (this.state === 'add') {
            this.saveAndClose(name, url, token);
        }
    }

    private async verify(url: string, token: string) {
        url = url.trim().replace(/\/status\/?$/, '');
        if (this.urlInput.get_text() !== url) {
            this.urlInput.set_text(url);
        }

        this.actionBtn.set_sensitive(false);
        this.actionBtn.set_label(_('Verifying...'));
        this.logger.info(`Verifying project at ${url}`);

        try {
            await this.apiClient.verifyProject(url, token);
            
            this.state = 'add';
            this.actionBtn.set_label(_('Save'));
            this.actionBtn.remove_css_class('suggested-action');
            this.actionBtn.remove_css_class('destructive-action');
            this.actionBtn.add_css_class('success');
            this.logger.info(`Project at ${url} verified successfully`);
        } catch (error) {
            this.state = 'error';
            this.actionBtn.set_label(_('Try again'));
            this.actionBtn.remove_css_class('suggested-action');
            this.actionBtn.remove_css_class('success');
            this.actionBtn.add_css_class('destructive-action');

            const errorMessage = error instanceof Error ? error.message : String(error);
            const toast = new Adw.Toast({ title: _('Verification failed: ') + errorMessage });
            this.toastOverlay.add_toast(toast);
            this.logger.error(`Failed to verify project at ${url}`, { error: errorMessage });
        } finally {
            this.actionBtn.set_sensitive(true);
        }
    }

    private saveAndClose(name: string, url: string, token: string) {
        if (this.existingProject) {
            const project = { id: this.existingProject.id, name, url, token };
            this.logger.info(`Updating project: ${name} (${project.id})`);
            this.store.updateProject(project);
        } else {
            const project = { id: GLib.uuid_string_random(), name, url, token };
            this.logger.info(`Saving new project: ${name} (${project.id})`);
            this.store.addProject(project);
            this.store.setActiveProject(project.id);
        }

        this.dialog.close();
        this.onSuccess();
    }

    present() {
        this.dialog.present(this.parentWidget);
    }
}
