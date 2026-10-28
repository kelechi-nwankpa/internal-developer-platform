import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
// ArgoCD plugin (new frontend system) — renders the ArgoCD tab +
// sync/health tile on Component pages that carry the
// `argocd/app-name` annotation. Backing API calls go via the backend
// proxy endpoint defined in app-config.yaml (/argocd/api).
import argocdPlugin from '@backstage-community/plugin-argocd';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';

export default createApp({
  features: [catalogPlugin, argocdPlugin, navModule, homeModule],
});
