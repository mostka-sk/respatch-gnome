import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { _ } from '../../gettext.js';
import { ProjectStore } from '../../stores/ProjectStore.js';
import { ApiClient } from '../../services/ApiClient.js';
import { LoggerService } from '../../services/LoggerService.js';
import { AddProjectDialog } from '../dialogs/AddProjectDialog.js';
import { Project } from '../../models/Project.js';

export class ManageServersWindow {
    public window: Adw.PreferencesDialog;
    private serversGroup: Adw.PreferencesGroup;
    private _rows: Gtk.Widget[] = [];

    constructor(
        private uiDir: string,
        private store: ProjectStore,
        private apiClient: ApiClient,
        private logger: LoggerService
    ) {
        const builder = new Gtk.Builder();
        builder.add_from_file(`${uiDir}/ui/manage_servers.ui`);

        this.window = builder.get_object('manage_servers_window') as Adw.PreferencesDialog;
        this.serversGroup = builder.get_object('servers_group') as Adw.PreferencesGroup;

        const addServerBtn = builder.get_object('add_server_button') as Gtk.Button;
        addServerBtn.connect('clicked', () => this.openAddDialog());

        this.store.connect('notify::active-project', () => this.refreshList());
        this.refreshList();
    }

    private refreshList() {
        // Clear existing rows
        for (const row of this._rows) {
            this.serversGroup.remove(row);
        }
        this._rows = [];

        const projects = this.store.getProjects();
        if (projects.length === 0) {
            const emptyLabel = new Gtk.Label({
                label: _('No servers added.'),
                margin_top: 12,
                margin_bottom: 12
            });
            emptyLabel.add_css_class('dim-label');
            this.serversGroup.add(emptyLabel);
            this._rows.push(emptyLabel);
            return;
        }


        for (const project of projects) {
            const row = new Adw.ActionRow({
                title: project.name,
                subtitle: project.url,
            });

            // Edit button
            const editBtn = new Gtk.Button({
                icon_name: 'document-edit-symbolic',
                valign: Gtk.Align.CENTER
            });
            editBtn.add_css_class('flat');
            editBtn.connect('clicked', () => this.openAddDialog(project));
            row.add_suffix(editBtn);

            // Remove button
            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER
            });
            removeBtn.add_css_class('flat');
            removeBtn.add_css_class('error');
            removeBtn.connect('clicked', () => {
                this.store.removeProject(project.id);
                this.refreshList();
            });
            row.add_suffix(removeBtn);

            this.serversGroup.add(row);
            this._rows.push(row);
        }
    }

    private openAddDialog(existingProject?: Project) {
        const dialog = new AddProjectDialog(
            this.window,
            this.uiDir,
            this.apiClient,
            this.store,
            this.logger,
            () => this.refreshList(),
            existingProject
        );
        dialog.present();
    }

    present(parent?: Gtk.Widget) {
        if (parent) {
            this.window.present(parent);
        } else {
            this.window.present(null);
        }
    }
}