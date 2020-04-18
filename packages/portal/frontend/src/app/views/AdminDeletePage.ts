import {OnsButtonElement} from "onsenui";

import Log from "../../../../../common/Log";
import {RepositoryTransport} from "../../../../../common/types/PortalTypes";
import {UI} from "../util/UI";

import {AdminPage} from "./AdminPage";
import {AdminResultsTab} from "./AdminResultsTab";
import {AdminView} from "./AdminView";

export class AdminDeletePage extends AdminPage {

    private repos: RepositoryTransport[];

    constructor(remote: string) {
        super(remote);
    }

    public async init(opts: any): Promise<void> {
        const that = this;
        Log.info('AdminDeletePage::init(..) - start');

        UI.showModal('Retrieving repositories.');

        this.repos = await AdminResultsTab.getRepositories(this.remote);

        this.repos = this.repos.sort(function compare(a: RepositoryTransport, b: RepositoryTransport) {
            return a.id.localeCompare(b.id);
        });

        const repoDelete = document.getElementById("repoDeleteSelect") as HTMLSelectElement;
        repoDelete.innerHTML = '';
        for (const repo of this.repos) {
            const option = document.createElement("option");
            option.text = repo.id;
            repoDelete.add(option);
        }

        UI.hideModal();

        (document.querySelector('#adminDeleteDeliverableButton') as OnsButtonElement).onclick = function(evt) {
            Log.info('AdminDeletePage::handleDeliverableDelete(..) - delete pressed');
            evt.stopPropagation(); // prevents list item expansion

            let value = UI.getTextFieldValue('adminDeleteDeliverableText');
            if (typeof value === 'string') {
                value = value.trim();
            }
            that.deleteDeliverable(value).then(function() {
                // done
            }).catch(function(err) {
                Log.error('AdminDeletePage::handleDeliverableDelete(..) - delete pressed ERROR: ' + err.message);
            });
        };

        (document.querySelector('#adminDeleteRepositoryButton') as OnsButtonElement).onclick = function(evt) {
            Log.info('AdminDeletePage::handleRepositoryDelete(..) - button pressed');
            evt.stopPropagation(); // prevents list item expansion

            that.deleteRepoPressed().then(function() {
                // worked
            }).catch(function(err) {
                // didn't
            });
        };

        (document.querySelector('#adminDeleteSanitizeDB') as OnsButtonElement).onclick = function(evt) {
            Log.info('AdminDeletePage::adminDeleteSanitizeDB(..) - button pressed');
            evt.stopPropagation(); // prevents list item expansion
            that.sanitizeDBPressed().then(function() {
                // worked
            }).catch(function(err) {
                // didn't
            });
        };
    }

    private async deleteRepoPressed(): Promise<void> {
        const repoDelete = document.getElementById("repoDeleteSelect") as HTMLSelectElement;

        const selected = [];

        // tslint:disable-next-line
        for (let i = 0; i < repoDelete.options.length; i++) {
            const opt = repoDelete.options[i];
            if (opt.selected) {
                selected.push(opt.value || opt.text);
            }
        }

        Log.info('AdminDeletePage::deleteRepoPressed(..) - start; # repos to delete: ' + selected.length);
        if (selected.length > 0) {
            UI.showSuccessToast('Repository deletion in progress.');
        } else {
            UI.showErrorToast('No repositories selected for deletion.');
        }

        // tslint:disable-next-line
        for (let i = 0; i < selected.length; i++) {
            const sel = selected[i];
            try {
                await this.deleteRepository(sel);
                Log.info('AdminDeletePage::deleteRepoPressed(..) - delete complete; repo: ' + sel);
                UI.showSuccessToast('Repository deleted: ' + sel + ' ( ' + (i + 1) + ' of ' + selected.length + ' )',
                    {force: true, animation: 'none'});
            } catch (err) {
                Log.error('AdminDeletePage::deleteRepoPressed(..) - delete pressed ERROR: ' + err.message);
                UI.showErrorToast('Repository NOT deleted: ' + sel);
            }
        }

        Log.info('AdminDeletePage::deleteRepoPressed(..) - done');
        if (selected.length > 0) {
            UI.showSuccessToast('Repository deletion complete.', {buttonLabel: 'Ok'});
        }
        // refresh the page
        await this.init({});
    }

    private async sanitizeDBPressed(): Promise<void> {
        const dryRun = document.getElementById("adminDeleteSanitizeDBToggle") as HTMLInputElement;

        Log.info('AdminDeletePage::sanitizeDBPressed(..) - start; dryRun: ' + dryRun.checked);

        try {
            const url = this.remote + '/portal/admin/checkDatabase/' + (dryRun.checked === true);

            const options: any = AdminView.getOptions();
            options.method = 'post';

            const response = await fetch(url, options);

            UI.showSuccessToast("Sanitization complete.", {buttonLabel: 'Ok'});
            // const body = await response.json();
            // if (typeof body.success !== 'undefined') {
            //     // UI.notificationToast(body.success.message);
            // } else {
            //     Log.error("Delete ERROR: " + body.failure.message);
            //     UI.showError(body.failure.message);
            // }

            Log.info('AdminDeletePage::sanitizeDBPressed(..) - done');
            UI.showSuccessToast('Sanitiztion complete', {buttonLabel: 'Ok'});
        } catch (err) {
            Log.error('AdminDeletePage::sanitizeDBPressed(..) - ERROR: ' + err.message);
            UI.showErrorToast('Error sanitizing DB: ' + err.message);
        }
    }

    public renderPage(pageName: string, opts: {}): void {
        Log.info("AdminDeletePage::renderPage( " + pageName + ", ... ) - start");
    }

    private async deleteDeliverable(delivId: string): Promise<boolean> {
        Log.info("AdminDeletePage::deleteDeliverable( " + delivId + " ) - start");
        const url = this.remote + '/portal/admin/deliverable/' + delivId;
        return await this.performDelete(url);
    }

    private async deleteRepository(repositoryId: string): Promise<boolean> {
        Log.info("AdminDeletePage::deleteRepository( " + repositoryId + " ) - start");
        const url = this.remote + '/portal/admin/repository/' + repositoryId;
        return await this.performDelete(url);
    }

    private async performDelete(url: string): Promise<boolean> {
        const options: any = AdminView.getOptions();
        options.method = 'delete';

        const response = await fetch(url, options);
        const body = await response.json();
        if (typeof body.success !== 'undefined') {
            // UI.notificationToast(body.success.message);
            return true;
        } else {
            Log.error("Delete ERROR: " + body.failure.message);
            UI.showError(body.failure.message);
            return false;
        }
    }

}
