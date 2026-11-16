/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// Phase 8 Wave 1: GitHub OAuth sign-in. Replaces the guest-provider
// path. Backed by the GitHub OAuth App registered in the kelechi-platform
// org; credentials come from the backstage-github-oauth K8s Secret
// (ESO-materialised from Vault secret/backstage/github-oauth).
backend.add(
  import('@backstage/plugin-auth-backend-module-github-provider'),
);
// Guest provider kept for emergency recovery — no `guest: {}` under
// appConfig.auth.providers means the provider is loaded but inert.
// If the GitHub OAuth App or Vault go sideways and we need to get back
// into Backstage without GitHub, add the provider back under
// appConfig.auth.providers to re-enable it temporarily.
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// See https://backstage.io/docs/permissions/getting-started for how to create your own permission policy
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// user settings plugin
backend.add(import('@backstage/plugin-user-settings-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

// Crossplane permissions-backend (TeraSky) — integrates Crossplane
// resources with Backstage's permission framework. Companion to the
// frontend crossplane-resources plugin registered in packages/app.
backend.add(
  import('@terasky/backstage-plugin-crossplane-permissions-backend'),
);

// ArgoCD backend plugin (@backstage-community) — companion to the
// frontend plugin registered in packages/app. The frontend's
// Deployment tab calls /api/argocd/find/name/<x>?expand=applications
// which 404s without this backend handler. Discovered during Phase 8
// Wave 1 Task 8W1.5 after RBAC / token diagnostics all came back
// green — the plugin ships in two packages (frontend + backend) and
// the backend was never wired in Wave 3.
backend.add(import('@backstage-community/plugin-argocd-backend'));

backend.start();
