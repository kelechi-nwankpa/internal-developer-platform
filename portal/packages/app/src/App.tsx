import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
// Scaffolder plugin — adds the "Create" nav entry and the template
// chooser + run pages. Backend is wired in packages/backend
// (plugin-scaffolder-backend + the GitHub module); frontend needs
// explicit registration in the new frontend system.
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
// Notifications plugin — required because other plugins (nav, home,
// scaffolder) reference apiRef{plugin.notifications.service}; without
// this registration the frontend throws
// "NotImplementedError: No implementation available for ..." and the
// catalog page fails to mount, cascading into a root-path 404.
import notificationsPlugin from '@backstage/plugin-notifications/alpha';
// ArgoCD plugin (new frontend system) — renders the ArgoCD tab +
// sync/health tile on Component pages that carry the
// `argocd/app-name` annotation. Backing API calls go via the backend
// proxy endpoint defined in app-config.yaml (/argocd/api).
import argocdPlugin from '@backstage-community/plugin-argocd';
// TeraSky Crossplane resources plugin (new frontend system via /alpha
// entry) — renders a Crossplane tab per Component showing the XR/XRC/MR
// chain for Crossplane-managed infrastructure. Full automatic discovery
// requires the TeraSky kubernetes-ingestor plugin (deferred to Phase 10
// polish); for Wave 3 the plugin loads and renders what it can from
// existing catalog annotations.
import crossplaneResourcesPlugin from '@terasky/backstage-plugin-crossplane-resources-frontend/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

export default createApp({
  features: [
    catalogPlugin,
    scaffolderPlugin,
    notificationsPlugin,
    argocdPlugin,
    crossplaneResourcesPlugin,
    navModule,
    homeModule,
  ],
});
